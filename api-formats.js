'use strict';
const crypto=require('node:crypto');
const history=new Map();
const TTL=3600000,MAX_BYTES=64*1024*1024,MAX_ENTRY=8*1024*1024;
let historyBytes=0;
function invalid(message,param){const e=Error(message);e.param=param;e.code='unsupported_parameter';throw e;}
function object(value,param){if(!value||typeof value!=='object'||Array.isArray(value))invalid(param+' must be an object',param);return value;}
function list(value,param){if(!Array.isArray(value))invalid(param+' must be an array',param);return value;}
function string(value,param){if(typeof value!=='string')invalid(param+' must be a string',param);return value;}
function remove(id){const entry=history.get(id);if(entry){historyBytes-=entry.bytes;history.delete(id);}}
function prune(){for(const [id,entry]of history)if(entry.expires<=Date.now())remove(id);}
function previous(id,scope){prune();const entry=history.get(id);if(!entry||entry.scope!==scope){const e=Error('previous_response_id 不存在、未存储或已过期；请发送完整 input 历史');e.status=404;e.param='previous_response_id';throw e;}return structuredClone(entry.messages);}
function remember(id,messages,scope){prune();const bytes=Buffer.byteLength(JSON.stringify(messages));if(bytes>MAX_ENTRY)return;while(history.size>=128||historyBytes+bytes>MAX_BYTES)remove(history.keys().next().value);history.set(id,{messages:structuredClone(messages),scope,bytes,expires:Date.now()+TTL});historyBytes+=bytes;}
function responseParts(content){
 if(typeof content==='string')return content;
 return list(content,'content').map(p=>{
  if(p?.type==='input_text'||p?.type==='output_text')return {type:'text',text:string(p.text,'content.text')};
  if(p?.type==='input_image'&&typeof p.image_url==='string')return {type:'image_url',image_url:{url:p.image_url}};
  invalid('Responses 仅支持文本和 base64 input_image 内容块','input');
 });
}
function responseInput(input){
 if(typeof input==='string')return [{role:'user',content:input}];
 return list(input,'input').map(item=>{
  object(item,'input item');
  if(item.type==='function_call')return {role:'assistant',content:null,tool_calls:[{id:string(item.call_id,'call_id'),type:'function',function:{name:string(item.name,'name'),arguments:string(item.arguments,'arguments')}}]};
  if(item.type==='function_call_output')return {role:'tool',tool_call_id:string(item.call_id,'call_id'),content:responseParts(item.output)};
  if((!item.type||item.type==='message')&&['user','assistant','system','developer'].includes(item.role))return {role:item.role,content:responseParts(item.content)};
  invalid('不支持的 Responses input item 类型','input');
 });
}
function mergeCalls(messages){
 const result=[];for(const m of messages){const last=result.at(-1);if(m.role==='assistant'&&m.tool_calls&&m.content==null&&last?.role==='assistant'){last.tool_calls=[...(last.tool_calls||[]),...m.tool_calls];}else result.push(m);}return result;
}
function fromResponses(o,scope){
 for(const key of ['conversation','prompt'])if(o[key]!=null)invalid('暂不支持 '+key+'，请发送完整 input 或 previous_response_id',key);
 if(o.background===true)invalid('暂不支持后台响应','background');
 if(o.store!==undefined&&typeof o.store!=='boolean')invalid('store must be a boolean','store');
 const prior=o.previous_response_id==null?[]:previous(string(o.previous_response_id,'previous_response_id'),scope);
 const messages=mergeCalls([...prior,...responseInput(o.input??[])]),storedMessages=structuredClone(messages);
 if(o.instructions!=null)messages.unshift({role:'system',content:string(o.instructions,'instructions')});
 const tools=o.tools==null?undefined:list(o.tools,'tools').map(t=>{if(t?.type!=='function')invalid('仅支持客户端 function 工具','tools');return {type:'function',function:{name:t.name,description:t.description,parameters:t.parameters,strict:t.strict}};});
 let choice=o.tool_choice;if(choice&&typeof choice==='object'){if(choice.type!=='function')invalid('不支持的 tool_choice','tool_choice');choice={type:'function',function:{name:choice.name}};}
 const format=o.text?.format;
 if(format&&!['text','json_object'].includes(format.type))invalid('暂不支持 JSON Schema 输出约束','text.format');
 return {body:{model:o.model,messages,tools,tool_choice:choice,parallel_tool_calls:o.parallel_tool_calls,stream:o.stream,response_format:format},context:{storedMessages,store:o.store!==false,scope,previousId:o.previous_response_id??null}};
}
function anthropicParts(parts){
 if(typeof parts==='string')return parts;
 return list(parts,'content').map(p=>{if(p?.type==='text')return {type:'text',text:string(p.text,'text')};if(p?.type==='image')return {type:'image',source:p.source};invalid('Messages 仅支持 text、image、tool_use 和 tool_result 内容块','messages');});
}
function fromMessages(o){
 if(o.thinking&&o.thinking.type!=='disabled')invalid('UFO 代理暂不支持原生 thinking 模式','thinking');
 if(o.output_config?.format)invalid('暂不支持 JSON Schema 输出约束','output_config.format');
 if(!Number.isInteger(o.max_tokens)||o.max_tokens<=0)invalid('max_tokens must be a positive integer','max_tokens');
 const messages=[];
 if(o.system!=null)messages.push({role:'system',content:anthropicParts(o.system)});
 for(const m of list(o.messages,'messages')){
  if(!m||!['user','assistant'].includes(m.role))invalid('Messages role 必须是 user 或 assistant','messages');
  if(typeof m.content==='string'){messages.push({role:m.role,content:m.content});continue;}
  const parts=list(m.content,'content');let text=[];
  const flush=()=>{if(text.length){messages.push({role:m.role,content:anthropicParts(text)});text=[];}};
  for(const p of parts){
   if(p?.type==='tool_use'){
    if(m.role!=='assistant')invalid('tool_use 必须位于 assistant 消息','messages');
    const content=text.length?anthropicParts(text):null;text=[];
    messages.push({role:'assistant',content,tool_calls:[{id:string(p.id,'tool_use.id'),type:'function',function:{name:string(p.name,'tool_use.name'),arguments:JSON.stringify(object(p.input,'tool_use.input'))}}]});
   }else if(p?.type==='tool_result'){
    if(m.role!=='user')invalid('tool_result 必须位于 user 消息','messages');flush();
    let content=anthropicParts(p.content??'');if(p.is_error){content=typeof content==='string'?'[Tool error]\n'+content:[{type:'text',text:'[Tool error]\n'},...content];}
    messages.push({role:'tool',tool_call_id:string(p.tool_use_id,'tool_result.tool_use_id'),content});
   }else text.push(p);
  }
  flush();
 }
 const tools=o.tools==null?undefined:list(o.tools,'tools').map(t=>{if(t?.type&&t.type!=='custom')invalid('仅支持客户端自定义工具','tools');return {type:'function',function:{name:t?.name,description:t?.description,parameters:t?.input_schema}};});
 let choice;if(o.tool_choice){const c=object(o.tool_choice,'tool_choice');choice=c.type==='tool'?{type:'function',function:{name:c.name}}:({auto:'auto',any:'required',none:'none'})[c.type];if(!choice)invalid('不支持的 tool_choice','tool_choice');}
 return {body:{model:o.model,messages:mergeCalls(messages),tools,tool_choice:choice,parallel_tool_calls:o.tool_choice?.disable_parallel_tool_use===true?false:undefined,stream:o.stream},context:{}};
}
function decode(raw,kind,scope){let o;try{o=JSON.parse(raw);}catch{throw Error('Invalid JSON.');}object(o,'Request body');return kind==='responses'?fromResponses(o,scope):fromMessages(o);}
const id=prefix=>prefix+crypto.randomBytes(12).toString('hex');
function errorBody(kind,status,message,type,code,param){
 if(kind!=='messages')return {error:{message,type,param,code}};
 const mapped=status===401?'authentication_error':status===403?'permission_error':status===404?'not_found_error':status===413?'request_too_large':status===429?'rate_limit_error':status>=500||status===402?'api_error':'invalid_request_error';
 return {type:'error',error:{type:mapped,message}};
}
// One reply writer maps validated chat deltas into the two public wire formats.
// No terminal success event is emitted until the existing adapter validates all calls.
function reply(kind,res,body,context){
 const responseId=id(kind==='responses'?'resp_':'msg_'),created=Math.floor(Date.now()/1000);
 let sequence=0,started=false,textItem=null,active=null;const items=[],calls=new Map();
 const event=(type,data={})=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...(kind==='responses'?{sequence_number:sequence++}:{}),...data})+'\n\n');
 const envelope=(status,output)=>kind==='responses'?{id:responseId,object:'response',created_at:created,status,model:body.model,output,error:null,incomplete_details:null,usage:null,parallel_tool_calls:body.parallel_tool_calls!==false,tools:(body.tools||[]).map(t=>({type:'function',...t.function})),tool_choice:body.tool_choice?.function?{type:'function',name:body.tool_choice.function.name}:body.tool_choice??'auto',previous_response_id:context.previousId??null,store:context.store,metadata:{}}:{id:responseId,type:'message',role:'assistant',model:body.model,content:output,stop_reason:status==='completed'?(calls.size?'tool_use':'end_turn'):null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}};
 const start=()=>{if(started)return;started=true;res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});if(kind==='responses'){event('response.created',{response:envelope('in_progress',[])});event('response.in_progress',{response:envelope('in_progress',[])});}else event('message_start',{message:envelope('in_progress',[])});};
 const add=(item)=>{
  const index=items.length;items.push(item);
  if(kind==='responses')event('response.output_item.added',{output_index:index,item:structuredClone(item)});
  else {if(active!==null)event('content_block_stop',{index:active});active=index;event('content_block_start',{index,content_block:item.type==='function_call'?{type:'tool_use',id:item.call_id,name:item.name,input:{}}:{type:'text',text:''}});}
  return index;
 };
 const delta=d=>{
  if(!d.content&&!d.tool_calls?.length)return;start();
  if(d.content){if(!textItem){const item={id:id('msg_'),type:'message',role:'assistant',status:'in_progress',content:[]};const index=add(item);textItem={item,index};if(kind==='responses')event('response.content_part.added',{item_id:item.id,output_index:index,content_index:0,part:{type:'output_text',text:'',annotations:[]}});item.content=[{type:'output_text',text:'',annotations:[]}];}
   textItem.item.content[0].text+=d.content;
   if(kind==='responses')event('response.output_text.delta',{item_id:textItem.item.id,output_index:textItem.index,content_index:0,delta:d.content});else event('content_block_delta',{index:textItem.index,delta:{type:'text_delta',text:d.content}});
  }
  for(const call of d.tool_calls||[]){let entry=calls.get(call.index);if(!entry){const item={id:id('fc_'),type:'function_call',call_id:call.id,name:call.function.name,arguments:'',status:'in_progress'};entry={item,index:add(item)};calls.set(call.index,entry);}
   const args=call.function?.arguments||'';entry.item.arguments+=args;
   if(args){if(kind==='responses')event('response.function_call_arguments.delta',{item_id:entry.item.id,output_index:entry.index,delta:args});else event('content_block_delta',{index:entry.index,delta:{type:'input_json_delta',partial_json:args}});}
  }
 };
 const finish=message=>{
  if(!body.stream){if(message.content){textItem={item:{id:id('msg_'),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:message.content,annotations:[]}]},index:0};items.push(textItem.item);}for(const [index,call]of (message.tool_calls||[]).entries()){const item={id:id('fc_'),type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments,status:'completed'};calls.set(index,{item,index:items.length});items.push(item);}}
  else {start();for(const [index,call]of (message.tool_calls||[]).entries()){const entry=calls.get(index);if(entry)entry.item.arguments=call.function.arguments;}
   for(const [index,item]of items.entries()){item.status='completed';if(kind==='responses'){if(item.type==='message'){event('response.output_text.done',{item_id:item.id,output_index:index,content_index:0,text:item.content[0].text});event('response.content_part.done',{item_id:item.id,output_index:index,content_index:0,part:item.content[0]});}else event('response.function_call_arguments.done',{item_id:item.id,output_index:index,arguments:item.arguments});event('response.output_item.done',{output_index:index,item});}}
  }
  const output=kind==='responses'?items:items.map(item=>item.type==='function_call'?{type:'tool_use',id:item.call_id,name:item.name,input:JSON.parse(item.arguments)}:{type:'text',text:item.content[0].text});
  const result=envelope('completed',output);
  if(kind==='responses'&&context.store)res.once('finish',()=>remember(responseId,[...context.storedMessages,message],context.scope));
  if(body.stream){if(kind==='responses')event('response.completed',{response:result});else{if(active!==null)event('content_block_stop',{index:active});event('message_delta',{delta:{stop_reason:result.stop_reason,stop_sequence:null},usage:{output_tokens:0}});event('message_stop');}res.end();}
  else {const bytes=Buffer.from(JSON.stringify(result));res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-length':bytes.length});res.end(bytes);}
 };
 return {delta,finish};
}
module.exports={decode,reply,errorBody};
