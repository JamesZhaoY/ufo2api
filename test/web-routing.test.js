'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ufo-web-'));process.env.UFO_HOME=tmp;process.env.UFO_TOKEN='web-test';process.env.UFO_WORKSPACE_URL='https://example.test';process.env.UFO_PROXY_API_KEY='test';process.env.UFO_TRANSPORT='web';process.env.UFO_CONTEXT_COMPACT='1';
const {server}=require('../server');
function post(body){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(JSON.stringify(body));});}
test('web route skips summary and catalog, sends full context once then only tool-result delta in the same conversation',async()=>{
 let chats=0,result=false;const original=global.fetch;
 global.fetch=async(url,o)=>{if(url.endsWith('/api/agents'))return Response.json({agents:[{name:'chat',id:'chat'}]});if(url.includes('/chat?')){chats++;if(chats===1){assert(url.endsWith('conversation=new'));assert(o.body.includes('START'+ 'x'.repeat(83000)+'END'));}else{assert(url.endsWith('conversation=c'));assert(!o.body.includes('START'+ 'x'.repeat(83000)+'END'));assert(!o.body.includes('detail detail'));}assert(o.body.includes('last_tool'));assert(!o.body.startsWith('Summarize'));assert(!o.body.startsWith('Select relevant'));result=o.body.includes('RESULT_MARKER');return Response.json({conversation_id:'c',turn_id:'t'});}assert(url.endsWith('/stream'));const text=JSON.stringify(result?{content:'Done',tool_calls:[]}:{content:null,tool_calls:[{name:'last_tool',arguments:{}}]});return new Response('data: '+JSON.stringify({text})+'\n\nevent: terminal\ndata: {"status":"done"}\n\n');};
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const body={model:'ufo',messages:[{role:'system',content:'START'+'x'.repeat(83000)+'END'},{role:'user',content:'Use last_tool'}],tools:Array.from({length:35},(_,i)=>({type:'function',function:{name:i===34?'last_tool':'tool_'+i,description:'detail '.repeat(300),parameters:{type:'object'}}}))};const first=await post(body);assert.equal(first.status,200,first.text);assert.equal(first.headers['x-ufo-context-compacted'],undefined);const call=JSON.parse(first.text).choices[0].message.tool_calls[0];assert.equal(call.function.name,'last_tool');const second=await post({...body,stream:true,messages:[...body.messages,{role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'RESULT_MARKER'}]});assert.equal(second.status,200);assert.match(second.text,/Done/);assert.match(second.text,/\[DONE\]/);assert.equal(chats,2);}finally{global.fetch=original;await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});}
});
test('web quota exhaustion returns 402 rather than a retryable 502',async()=>{
 const original=global.fetch;let stops=0;
 global.fetch=async(url,o)=>{if(o.headers['x-ufo-stop-turn']){stops++;return Response.json({});}if(url.endsWith('/api/agents'))return Response.json({agents:[{name:'chat',id:'chat'}]});if(url.includes('/chat?'))return Response.json({conversation_id:'c',turn_id:'t'});return new Response('event: parked\ndata: {"message":"This workspace is out of credit."}\n\n');};
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const result=await post({model:'ufo',messages:[{role:'user',content:'hello'}]});assert.equal(result.status,402);assert.equal(JSON.parse(result.text).error.type,'insufficient_quota');assert.equal(stops,1);}finally{global.fetch=original;await new Promise(r=>server.close(r));}
});

test('screenshot tool result continues over HTTP with an image attachment and later reuses it',async()=>{
 const original=global.fetch,png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=';let chats=0;
 global.fetch=async(url,o)=>{
  if(url.endsWith('/api/agents'))return Response.json({agents:[{id:'chat',name:'chat'}]});
  if(url.includes('/chat?')){chats++;if(chats===2){assert(o.body instanceof FormData);assert.equal(o.headers['content-type'],undefined);assert.match(o.body.get('message'),/Screenshot ready/);assert.deepEqual(Buffer.from(await o.body.get('file').arrayBuffer()),Buffer.from(png,'base64'));assert(url.endsWith('conversation=image-chat'));}else{assert.equal(typeof o.body,'string');if(chats===3){assert(url.endsWith('conversation=image-chat'));assert(!o.body.includes('Attached image:'));}}return Response.json({conversation_id:'image-chat',turn_id:'t'});}
  const text=JSON.stringify(chats===1?{content:null,tool_calls:[{name:'screenshot',arguments:{}}]}:{content:'Image received',tool_calls:[]});return new Response('event: terminal\ndata: '+JSON.stringify({status:'done',text})+'\n\n');
 };
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const body={model:'ufo',tools:[{type:'function',function:{name:'screenshot',parameters:{type:'object'}}}],messages:[{role:'user',content:'Preview the animation'}]};
  const first=await post(body);assert.equal(first.status,200);const reply=JSON.parse(first.text).choices[0].message;
  const messages=[...body.messages,reply,{role:'tool',tool_call_id:reply.tool_calls[0].id,content:[{type:'text',text:'Screenshot ready'},{type:'image_url',image_url:{url:'data:image/png;base64,'+png}}]}];
  const second=await post({...body,messages});assert.equal(second.status,200,second.text);assert.equal(second.headers['x-ufo-session-reused'],'true');
  const third=await post({...body,messages:[...messages,JSON.parse(second.text).choices[0].message,{role:'user',content:[{type:'text',text:'Continue'}]}]});assert.equal(third.status,200);assert.equal(third.headers['x-ufo-session-reused'],'true');assert.equal(chats,3);
  const bad=await post({model:'ufo',messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'PRIVATE'}}]}]});assert.equal(bad.status,400);assert.equal(JSON.parse(bad.text).error.param,'messages[0].content');assert.equal(JSON.parse(bad.text).error.code,'unsupported_message_content');assert(!bad.text.includes('PRIVATE'));
 }finally{global.fetch=original;await new Promise(r=>server.close(r));}
});

test('mixed prose and JSON reaches clients as real tool calls in streaming and non-streaming responses',async()=>{
 const original=global.fetch;
 const args={questions:[{id:'err_detail',question:'报错的具体内容是什么？',header:'报错信息',options:[{label:'应用内更新报错',description:'点击更新后失败'}]}]};
 const text='我先看一下本机当前安装的版本和可用的更新渠道，再直接帮你完成更新。'+JSON.stringify({tool_calls:[{name:'ask_user_question',arguments:args}]});
 global.fetch=async(url,o)=>{
  if(url.endsWith('/api/agents'))return Response.json({agents:[{id:'chat',name:'chat'}]});
  if(url.includes('/chat?'))return Response.json({conversation_id:'mixed-chat',turn_id:'t'});
  let events='';for(let i=0;i<text.length;i+=7)events+='data: '+JSON.stringify({text:text.slice(i,i+7)})+'\n\n';return new Response(events+'event: terminal\ndata: {"status":"done"}\n\n');
 };
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{for(const stream of [false,true]){
  const result=await post({model:'ufo',stream,messages:[{role:'user',content:'Diagnose update error '+stream}],tools:[{type:'function',function:{name:'ask_user_question',parameters:{type:'object',properties:{questions:{type:'array',items:{type:'object'}}},required:['questions']}}}]});assert.equal(result.status,200,result.text);
  if(stream){const frames=result.text.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));assert.equal(frames.at(-1).choices[0].finish_reason,'tool_calls');const calls=frames.flatMap(frame=>frame.choices[0].delta.tool_calls||[]);assert.equal(calls[0].function.name,'ask_user_question');assert.deepEqual(JSON.parse(calls.map(call=>call.function?.arguments||'').join('')),args);assert(!frames.some(frame=>frame.choices[0].delta.content));}
  else{const choice=JSON.parse(result.text).choices[0];assert.equal(choice.finish_reason,'tool_calls');assert.equal(choice.message.content,null);assert.equal(choice.message.tool_calls[0].function.name,'ask_user_question');assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments),args);}
 }}finally{global.fetch=original;await new Promise(r=>server.close(r));}
});

test('tool delta arrives while upstream is still generating; invalid calls never finish',async()=>{
 const original=global.fetch;await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{for(const valid of [true,false]){
  let release,seen;const gate=new Promise(r=>release=r),first=new Promise(r=>seen=r);let output='',ended=false;
  global.fetch=async(url,o)=>{
   if(url.endsWith('/api/agents'))return Response.json({agents:[{id:'chat',name:'chat'}]});
   if(url.includes('/chat?'))return Response.json({conversation_id:'early-'+valid,turn_id:'t'});
   const prefix='{"tool_name":"write_file"';
   return new Response(new ReadableStream({start(c){const send=s=>c.enqueue(new TextEncoder().encode(s));send('data: '+JSON.stringify({text:prefix})+'\n\n');gate.then(()=>{send('data: '+JSON.stringify({text:',"tool_calls":[{"name":"write_file","arguments":{"content":'+(valid?'"first second"':'42')+'}}],"content":null}'})+'\n\nevent: terminal\ndata: {"status":"done"}\n\n');c.close();});}}));
  };
  const done=new Promise(resolve=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'}},res=>{res.on('data',chunk=>{output+=chunk;for(const line of output.split('\n'))if(line.startsWith('data: {')){try{const frame=JSON.parse(line.slice(6));if(frame.choices[0].delta.tool_calls)seen(true);}catch{}}});const finish=()=>{ended=true;resolve();};res.on('end',finish);res.on('aborted',finish);res.on('error',finish);});req.on('error',resolve);req.end(JSON.stringify({model:'ufo',stream:true,messages:[{role:'user',content:'Write a file '+valid}],tools:[{type:'function',function:{name:'write_file',parameters:{type:'object',properties:{content:{type:'string'}},required:['content']}}}]}));});
  let timer;try{
   assert.equal(await Promise.race([first,new Promise(r=>timer=setTimeout(()=>r(false),750))]),true,'tool data must reach the client before releasing the upstream gate');
   assert.equal(ended,false);assert(!output.includes('[DONE]'));assert(!output.includes('"finish_reason":"tool_calls"'));
   release();await done;
   if(valid){assert(output.includes('"finish_reason":"tool_calls"'));assert(output.includes('[DONE]'));const frames=output.split('\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));const args=frames.flatMap(x=>x.choices[0].delta.tool_calls||[]).map(x=>x.function?.arguments||'').join('');assert.deepEqual(JSON.parse(args),{content:'first second'});}
   else{assert(!output.includes('[DONE]'));assert(!output.includes('"finish_reason":"tool_calls"'));}
  }finally{clearTimeout(timer);release();await done;}
 }}finally{global.fetch=original;await new Promise(r=>server.close(r));}
});
test('web mode routes an oversized tool catalog without sending all schemas or corrupting session history',async()=>{
 const original=global.fetch;let submissions=[],selections=0;
 global.fetch=async(url,o)=>{if(url.endsWith('/api/agents'))return Response.json({agents:[{id:'chat',name:'chat'}]});if(url.includes('/chat?')){assert.equal(typeof o.body,'string');assert(Buffer.byteLength(o.body)<180000);assert(url.endsWith('conversation=new'));submissions.push(o.body);return Response.json({conversation_id:'catalog-'+submissions.length,turn_id:String(submissions.length)});}const isSelect=submissions.at(-1).startsWith('Select relevant client-side tools');let text;if(isSelect){selections++;assert(submissions.at(-1).includes('tool_428'));text=JSON.stringify({selected_tools:['tool_428'],tool_calls:[],content:null});}else{text=JSON.stringify({tool_name:'tool_428',tool_calls:[{name:'tool_428',arguments:{}}],content:null});}return new Response('event: terminal\ndata: '+JSON.stringify({status:'done',text})+'\n\n');};
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const tools=Array.from({length:429},(_,i)=>({type:'function',function:{name:'tool_'+i,description:'tool description '.repeat(80),parameters:{type:'object'}}}));const body={model:'ufo',messages:[{role:'user',content:'Call tool_428'}],tools};const first=await post(body);assert.equal(first.status,200,first.text);assert.equal(JSON.parse(first.text).choices[0].message.tool_calls[0].function.name,'tool_428');assert.equal(selections,1);assert.equal(submissions.length,2);assert(!submissions[0].includes('\"name\":\"tool_0\"'));assert(submissions[0].includes('tool_428'));assert(submissions[1].includes('tool_428'));assert(!submissions[1].includes('"name":"tool_0"'));const call=JSON.parse(first.text).choices[0].message.tool_calls[0];const second=await post({...body,messages:[...body.messages,{role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'done'}]});assert.equal(second.status,200,second.text);assert.equal(second.headers['x-ufo-session-reused'],'false');}finally{global.fetch=original;await new Promise(r=>server.close(r));}
});
