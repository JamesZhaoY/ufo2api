'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {upstream,parseRequest}=require('../server');
const {post,parseLogin}=require('../login');

test('normalizes text content parts in client history and tool results',()=>{
 const body={model:'ufo',messages:[{role:'system',content:[{type:'text',text:'instructions'}]},{role:'user',content:[{type:'text',text:'create '},{type:'text',text:'HTML'}]},{role:'assistant',content:[],tool_calls:[{id:'call_1',type:'function',function:{name:'write_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'call_1',content:[{type:'text',text:'Saved\n'},{type:'text',text:'page.html'}]}]};
 const parsed=parseRequest(JSON.stringify(body));
 assert.deepEqual(parsed.messages.map(m=>m.content),['instructions','create HTML','','Saved\npage.html']);
 assert.equal(parsed.messages[3].tool_call_id,'call_1');assert.equal(parsed.messages[2].tool_calls[0].function.name,'write_file');
});

test('unsupported or malformed content reports its location without leaking content',()=>{
 for(const content of [[{type:'image_url',image_url:{url:'data:image/png;base64,PRIVATE'}}],[{type:'text',text:42}],null,{text:'PRIVATE'}]){
  assert.throws(()=>parseRequest(JSON.stringify({model:'ufo',messages:[{role:'user',content}]})),e=>e.param==='messages[0].content'&&e.code==='unsupported_message_content'&&!e.message.includes('PRIVATE'));
 }
});

test('upstream parses fragmented events and decodes line breaks', async()=>{
 process.env.UFO_TOKEN='test-token';process.env.UFO_WORKSPACE_URL='https://example.test';
 const orig=global.fetch;
 global.fetch=async(url,opts)=>{
  assert.match(url,/^https:\/\/example\.test\/surface\/ufo\/[0-9a-f]{32}$/);
  assert.equal(opts.headers.authorization,'Bearer test-token');
  const bytes=new TextEncoder().encode('sent\tid\t1\t\nframe\tmessage\t{"text":"你好\\\\n"}\nframe\tmessage\t{"text":"world"}\nframe\tterminal\t{"status":"done"}\n');
  return new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,31));c.enqueue(bytes.subarray(31,33));c.enqueue(bytes.subarray(33));c.close();}}),{status:200});
 };
 try {let pieces='';assert.equal(await upstream([{role:'user',content:'test'}],x=>pieces+=x,AbortSignal.timeout(5000)),'你好\nworld');assert.equal(pieces,'你好\nworld');}
 finally{global.fetch=orig;delete process.env.UFO_TOKEN;delete process.env.UFO_WORKSPACE_URL;}
});
test('incomplete upstream fails rather than returning success',async()=>{
 process.env.UFO_TOKEN='test';process.env.UFO_WORKSPACE_URL='https://example.test';const orig=global.fetch;
 global.fetch=async()=>new Response('frame\tmessage\t{"text":"partial"}\n');
 try{await assert.rejects(upstream([{role:'user',content:'a'}],()=>{},AbortSignal.timeout(5000)),/complete/);}finally{global.fetch=orig;delete process.env.UFO_TOKEN;delete process.env.UFO_WORKSPACE_URL;}
});
test('input and login protocol validation',async()=>{
 assert.throws(()=>parseRequest('{"model":"ufo","messages":[],"stream":true}'));
 assert.deepEqual(parseLogin([{type:'token',value:'token'},{type:'workspace',value:'https://app.ufo.ai'}]),{token:'token',workspace:'https://app.ufo.ai'});
 assert.throws(()=>parseLogin([{type:'token',value:'x'},{type:'workspace',value:'http://bad.test'}]));
 const events=await post('123456','test-session',async(url,opts)=>{assert.equal(url,'https://ufo.ai/v1/onboard/onboard');assert.equal(opts.headers['x-ufo-session'],'test-session');assert.equal(opts.body,'123456');return new Response('token\texample\nworkspace\thttps://app.ufo.ai\n');});
 assert.equal(parseLogin(events).token,'example');
});
test('repairs double-escaped quotation marks in UFO text frames',async()=>{
 process.env.UFO_TOKEN='test-token';process.env.UFO_WORKSPACE_URL='https://example.test';const original=global.fetch;
 const expected='{"content":null,"tool_calls":[{"name":"weather","arguments":{"city":"Paris"}}]}';
 const invalid=JSON.stringify({text:expected}).replace(/\\"/g,'\\\\"');
 global.fetch=async()=>new Response('frame\tmessage\t'+invalid+'\nframe\tterminal\t{"status":"done"}\n');
 try{assert.equal(await upstream([{role:'user',content:'test'}],()=>{},AbortSignal.timeout(5000)),expected);}finally{global.fetch=original;delete process.env.UFO_TOKEN;delete process.env.UFO_WORKSPACE_URL;}
});
test('reports upstream model refusal distinctly',async()=>{
 process.env.UFO_TOKEN='test-token';process.env.UFO_WORKSPACE_URL='https://example.test';const original=global.fetch;global.fetch=async()=>new Response('frame\tterminal\t{"status":"failed","error_class":"ModelRefusal"}\n');
 try{await assert.rejects(upstream([{role:'user',content:'test'}],()=>{},AbortSignal.timeout(5000)),e=>e.code==='UFO_MODEL_REFUSAL');}finally{global.fetch=original;delete process.env.UFO_TOKEN;delete process.env.UFO_WORKSPACE_URL;}
});
test('decodes structured JSON correctly across every backslash chunk boundary',async()=>{
 process.env.UFO_TOKEN='test-token';process.env.UFO_WORKSPACE_URL='https://example.test';const original=global.fetch;
 const expected=JSON.stringify({tool_calls:[],content:'line one\nline two "quoted" \\ path'});const wire=expected.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
 try{for(let i=1;i<wire.length;i++){const frames=[wire.slice(0,i),wire.slice(i)].map(x=>'frame\tmessage\t'+JSON.stringify({text:x})+'\n').join('')+'frame\tterminal\t{"status":"done"}\n';global.fetch=async()=>new Response(frames);const text=await upstream([{role:'user',content:'test'}],()=>{},AbortSignal.timeout(5000));assert.equal(text,expected,`split ${i}`);}}finally{global.fetch=original;delete process.env.UFO_TOKEN;delete process.env.UFO_WORKSPACE_URL;}
});
