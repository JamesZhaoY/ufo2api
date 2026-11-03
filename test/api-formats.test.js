'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ufo-formats-'));
process.env.UFO_HOME=tmp;process.env.UFO_PROXY_API_KEY='format-key';process.env.UFO_TRANSPORT='web';process.env.UFO_TOKEN='test';process.env.UFO_WORKSPACE_URL='https://formats.test';
const {server}=require('../server'),formats=require('../api-formats');
const original=global.fetch;let prompts=[],answer='hello',refusal=false,chats=0,stops=0,gate=null;
global.fetch=async(url,o={})=>{
 if(o.headers?.['x-ufo-stop-turn']){stops++;return Response.json({});}
 if(url.endsWith('/api/agents'))return Response.json({agents:[{id:'chat',name:'chat'}]});
 if(url.includes('/chat?')){chats++;prompts.push({url,body:o.body});return Response.json({turn_id:'t'+chats,conversation_id:'c'+chats});}
 if(refusal)return new Response('event: terminal\ndata: {"status":"failed","error_class":"ModelRefusal"}\n\n');
 if(gate){const g=gate;return new Response(new ReadableStream({start(c){const send=s=>c.enqueue(new TextEncoder().encode(s));send('data: '+JSON.stringify({text:'{"tool_name":"write_file"'})+'\n\n');if(g.cancel)o.signal.addEventListener('abort',()=>c.error(o.signal.reason),{once:true});g.promise.then(()=>{send('data: '+JSON.stringify({text:',"tool_calls":[{"name":"write_file","arguments":{"content":'+g.content+'}}],"content":null}'})+'\n\nevent: terminal\ndata: {"status":"done"}\n\n');c.close();});}}));}
 return new Response('data: '+JSON.stringify({text:answer.slice(0,3)})+'\n\ndata: '+JSON.stringify({text:answer.slice(3)})+'\n\nevent: terminal\ndata: {"status":"done"}\n\n');
};
test.before(()=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)));
test.after(async()=>{global.fetch=original;await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});});
function post(route,body,{key='format-key',bearer=true,onChunk}={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method:'POST',headers:{'content-type':'application/json',...(bearer?{authorization:'Bearer '+key}:{'x-api-key':key})}},res=>{let text='';res.on('data',b=>{text+=b;onChunk?.(text,req);});const finish=()=>resolve({status:res.statusCode,text,complete:res.complete,headers:res.headers});res.on('end',finish);res.on('aborted',finish);res.on('error',finish);});req.on('error',reject);req.end(typeof body==='string'?body:JSON.stringify(body));});}
function events(raw){return raw.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));}
const fn={name:'write_file',parameters:{type:'object',properties:{content:{type:'string'}},required:['content'],additionalProperties:false}};
function request(kind,stream=false){return kind==='responses'?{model:'ufo',input:'write a file',stream,tools:[{type:'function',...fn}]}:{model:'ufo',max_tokens:1024,stream,messages:[{role:'user',content:'write a file'}],tools:[{name:fn.name,input_schema:fn.parameters}]};}

test('both formats support text JSON and their native text SSE lifecycle',async()=>{
 answer='你好 world';
 for(const kind of ['responses','messages'])for(const stream of [false,true]){
  const b=request(kind,stream);delete b.tools;const r=await post('/v1/'+kind,b,{bearer:kind==='responses'});assert.equal(r.status,200,r.text);
  if(!stream){const obj=JSON.parse(r.text);if(kind==='responses'){assert.equal(obj.output[0].content[0].text,answer);assert.equal(obj.status,'completed');assert.match(obj.id,/^resp_/);}else{assert.equal(obj.content[0].text,answer);assert.equal(obj.stop_reason,'end_turn');}}
  else{const e=events(r.text);assert(!r.text.includes('[DONE]'));if(kind==='responses'){assert.equal(e[0].type,'response.created');assert.deepEqual(e.map(x=>x.sequence_number),e.map((_,i)=>i));assert.equal(e.filter(x=>x.type==='response.output_text.delta').map(x=>x.delta).join(''),answer);assert.equal(e.at(-1).response.output[0].content[0].text,answer);}else{assert.equal(e[0].type,'message_start');assert.equal(e.filter(x=>x.delta?.type==='text_delta').map(x=>x.delta.text).join(''),answer);assert.equal(e.at(-1).type,'message_stop');assert.equal(e.at(-2).delta.stop_reason,'end_turn');}}
 }
});
test('both formats return multiple tools with stable IDs and complete streamed JSON arguments',async()=>{
 answer=JSON.stringify({tool_name:'write_file',tool_calls:[{name:'write_file',arguments:{content:'鹈鹕😀'}},{name:'write_file',arguments:{content:'second'}}],content:null});
 for(const kind of ['responses','messages'])for(const stream of [false,true]){
  const r=await post('/v1/'+kind,request(kind,stream));assert.equal(r.status,200,r.text);
  if(!stream){const obj=JSON.parse(r.text),calls=kind==='responses'?obj.output:obj.content;assert.equal(calls.length,2);assert.equal(kind==='responses'?JSON.parse(calls[0].arguments).content:calls[0].input.content,'鹈鹕😀');}
  else{const e=events(r.text);if(kind==='responses'){const added=e.filter(x=>x.type==='response.output_item.added');assert.equal(added.length,2);const completed=e.at(-1).response;for(const [i,item]of completed.output.entries()){assert.equal(item.call_id,added[i].item.call_id);assert.equal(item.id,added[i].item.id);const args=e.filter(x=>x.type==='response.function_call_arguments.delta'&&x.output_index===i).map(x=>x.delta).join('');assert.deepEqual(JSON.parse(args),JSON.parse(item.arguments));}}
   else{const starts=e.filter(x=>x.type==='content_block_start');assert.equal(starts.length,2);for(let i=0;i<2;i++){const args=e.filter(x=>x.type==='content_block_delta'&&x.index===i).map(x=>x.delta.partial_json).join('');assert.equal(JSON.parse(args).content,i?'second':'鹈鹕😀');assert.equal(e.filter(x=>x.type==='content_block_stop'&&x.index===i).length,1);}assert.equal(e.at(-2).delta.stop_reason,'tool_use');}}
 }
});
test('Responses previous_response_id restores tool history and reuses the upstream conversation',async()=>{
 answer=JSON.stringify({tool_calls:[{name:'write_file',arguments:{content:'file'}}],content:null});
 const first=JSON.parse((await post('/v1/responses',{...request('responses'),instructions:'stable instructions'})).text);const call=first.output[0];
 answer=JSON.stringify({tool_calls:[],content:'saved'});
 const second=await post('/v1/responses',{...request('responses'),instructions:'stable instructions',previous_response_id:first.id,input:[{type:'function_call_output',call_id:call.call_id,output:'saved on client'}]});
 assert.equal(second.status,200,second.text);assert.equal(second.headers['x-ufo-session-reused'],'true');assert.match(prompts.at(-1).body,/saved on client/);assert.match(prompts.at(-1).body,new RegExp(call.call_id));assert.equal(JSON.parse(second.text).output[0].content[0].text,'saved');
 const changed=formats.decode(JSON.stringify({model:'ufo',previous_response_id:first.id,input:'next'}),'responses',require('crypto').createHash('sha256').update('format-key').digest('hex'));assert(!changed.body.messages.some(m=>m.content==='stable instructions'));
});
test('Responses store false and missing references do not fabricate conversation history',async()=>{
 answer='ok';const first=JSON.parse((await post('/v1/responses',{model:'ufo',input:'private',store:false})).text);
 const before=chats;const r=await post('/v1/responses',{model:'ufo',previous_response_id:first.id,input:'continue'});assert.equal(r.status,404);assert.equal(chats,before);assert.equal(JSON.parse(r.text).error.param,'previous_response_id');
});
test('multiple client tool results preserve cache continuity for both protocols',async()=>{
 for(const kind of ['responses','messages']){
  const body=request(kind);if(kind==='responses')body.input='two response calls';else body.messages=[{role:'user',content:'two message calls'}];
  answer=JSON.stringify({tool_calls:[{name:'write_file',arguments:{content:'one'}},{name:'write_file',arguments:{content:'two'}}],content:null});
  const first=JSON.parse((await post('/v1/'+kind,body)).text);answer=JSON.stringify({tool_calls:[],content:'both saved'});
  const next=kind==='responses'?{...body,input:[{role:'user',content:body.input},...first.output,...first.output.map(c=>({type:'function_call_output',call_id:c.call_id,output:'saved'}))]}:{...body,messages:[...body.messages,{role:'assistant',content:first.content},{role:'user',content:first.content.map(c=>({type:'tool_result',tool_use_id:c.id,content:'saved'}))}]};
  const r=await post('/v1/'+kind,next);assert.equal(r.status,200,r.text);assert.equal(r.headers['x-ufo-session-reused'],'true');assert.equal((prompts.at(-1).body.match(/"role":"tool"/g)||[]).length,2);
 }
});
test('Messages round trips tool results and base64 screenshots without losing errors or attachments',async()=>{
 answer=JSON.stringify({tool_calls:[],content:'seen'});const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=';
 const r=await post('/v1/messages',{...request('messages'),system:[{type:'text',text:'system instructions'}],messages:[{role:'user',content:'look'},{role:'assistant',content:[{type:'tool_use',id:'toolu_shot',name:'write_file',input:{content:'x'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_shot',is_error:true,content:[{type:'text',text:'preview failed'},{type:'image',source:{type:'base64',media_type:'image/png',data:png}}]}]}]});
 assert.equal(r.status,200,r.text);const form=prompts.at(-1).body;assert(form instanceof FormData);assert.match(form.get('message'),/Tool error/);assert.match(form.get('message'),/toolu_shot/);assert.equal(Buffer.from(await form.get('file').arrayBuffer()).toString('base64'),png);
});
test('format-specific validation and authentication fail before any upstream call',async()=>{
 const before=chats;
 for(const [route,body]of [['responses',{model:'ufo',input:'x',tools:[{type:'web_search'}]}],['responses',{model:'ufo',input:[{type:'input_file',file_id:'f'}]}],['messages',{...request('messages'),thinking:{type:'enabled',budget_tokens:1024}}],['messages',{...request('messages'),max_tokens:0}],['messages','{']]){const r=await post('/v1/'+route,body);assert.equal(r.status,400,r.text);assert(JSON.parse(r.text).error);if(route==='messages')assert.equal(JSON.parse(r.text).type,'error');}
 const denied=await post('/v1/messages?beta=true',request('messages'),{key:'bad',bearer:false});assert.equal(denied.status,401);assert.equal(JSON.parse(denied.text).error.type,'authentication_error');assert.equal(chats,before);
});
test('upstream refusal preserves failure in both formats',async()=>{
 refusal=true;try{for(const kind of ['responses','messages']){const r=await post('/v1/'+kind,request(kind));assert.equal(r.status,422);assert.match(JSON.parse(r.text).error.message,/拒绝/);}}finally{refusal=false;}
});
test('first native tool event arrives before parameters; invalid calls never emit a completion',async()=>{
 for(const kind of ['responses','messages'])for(const valid of [true,false]){
  let release,seen;const received=new Promise(r=>{seen=r});gate={promise:new Promise(r=>{release=r}),content:valid?'"ok"':'42'};
  const done=post('/v1/'+kind,request(kind,true),{onChunk:text=>{if(text.includes(kind==='responses'?'response.output_item.added':'content_block_start'))seen(text);}});
  let timer;try{const early=await Promise.race([received,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('no early event')),1500);})]);assert(!early.includes('response.completed'));assert(!early.includes('message_stop'));}finally{clearTimeout(timer);release();}
  const r=await done;gate=null;assert.equal(r.complete,valid);if(valid)assert(r.text.includes(kind==='responses'?'response.completed':'message_stop'));else{assert(!r.text.includes('response.completed'));assert(!r.text.includes('message_stop'));assert(!r.text.includes('function_call_arguments.done'));assert(!r.text.includes('content_block_stop'));}
 }
});
test('disconnecting either native stream cancels the UFO turn',async()=>{
 for(const kind of ['responses','messages']){
  const before=stops;gate={promise:new Promise(()=>{}),cancel:true};
  try{await post('/v1/'+kind,request(kind,true),{onChunk:(text,req)=>{if(text.includes(kind==='responses'?'response.output_item.added':'content_block_start'))req.destroy();}});
   const deadline=Date.now()+1500;while(stops===before&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.equal(stops,before+1);
  }finally{gate=null;}
 }
});
