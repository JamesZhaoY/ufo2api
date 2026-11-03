'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {upstream}=require('../web-upstream');
const account={workspace:'https://example.test',token:'web-test',proxy:''};
function events(text){return 'data: '+JSON.stringify({text:text.slice(0,3)})+'\r\n\r\ndata: '+JSON.stringify({text:text.slice(3)})+'\r\n\r\nevent: terminal\r\ndata: '+JSON.stringify({status:'done',text})+'\r\n\r\n';}
test('web sends long input unchanged and decodes byte-fragmented SSE without double escaping',async()=>{
 const original=global.fetch,text='你好\\n"quoted"\nend',prompt='BEGIN\n'+'x'.repeat(83000)+'\nEND';let output='';
 global.fetch=async(url,options)=>{assert.equal(options.headers.cookie,'ufo_session=web-test');if(url.endsWith('/api/agents'))return Response.json({agents:[{id:'chat-id',name:'chat'}]});if(url.includes('/chat?conversation=new')){assert.equal(options.body,prompt);assert.equal(options.headers['x-ufo-model'],'gpt-6-luna');return Response.json({turn_id:'turn-id',conversation_id:'conv-id'});}if(url.endsWith('/stream')){const bytes=new TextEncoder().encode(events(text));return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i++)c.enqueue(bytes.slice(i,i+1));c.close();}}));}assert.fail('unexpected request');};
 try{assert.equal(await upstream(prompt,x=>output+=x,AbortSignal.timeout(5000),account,'gpt-6-luna'),text);assert.equal(output,text);}finally{global.fetch=original;}
});
test('terminal-only response works; refusal is not converted to success',async()=>{
 const original=global.fetch;let refusal=false;
 global.fetch=async url=>url.includes('/chat?')?Response.json({turn_id:'t',conversation_id:'c'}):new Response('event: terminal\ndata: '+JSON.stringify(refusal?{status:'failed',error_class:'ModelRefusal'}:{status:'done',text:'OK'})+'\n\n');
 try{assert.equal(await upstream('x',()=>{},AbortSignal.timeout(5000),account),'OK');refusal=true;await assert.rejects(upstream('x',()=>{},AbortSignal.timeout(5000),account),e=>e.code==='UFO_MODEL_REFUSAL');}finally{global.fetch=original;}
});
test('incomplete stream stops the server-owned web turn',async()=>{
 const original=global.fetch;let stops=0;
 global.fetch=async(url,o)=>{if(o.headers['x-ufo-stop-turn']){stops++;assert.equal(o.headers['x-ufo-stop-turn'],'t');assert(url.endsWith('conversation=c'));return Response.json({});}return url.includes('/chat?')?Response.json({turn_id:'t',conversation_id:'c'}):new Response('data: {"text":"partial"}\n\n');};
 try{await assert.rejects(upstream('x',()=>{},AbortSignal.timeout(5000),account),/完整回复/);assert.equal(stops,1);}finally{global.fetch=original;}
});
test('client cancellation sends a stop request with an independent signal',async()=>{
 const original=global.fetch,controller=new AbortController();let stopped=false;
 global.fetch=async(url,o)=>{if(o.headers['x-ufo-stop-turn']){assert.equal(o.signal.aborted,false);stopped=true;return Response.json({});}if(url.includes('/chat?'))return Response.json({turn_id:'cancel-turn',conversation_id:'cancel-chat'});return new Response(new ReadableStream({start(c){o.signal.addEventListener('abort',()=>c.error(o.signal.reason),{once:true});controller.abort(new Error('client cancel'));}}));};
 try{await assert.rejects(upstream('x',()=>{},controller.signal,account),/client cancel/);assert(stopped);}finally{global.fetch=original;}
});
test('out-of-credit parked event is classified as quota exhaustion and queued turn is stopped',async()=>{
 const original=global.fetch;let stops=0;
 global.fetch=async(url,o)=>{if(o.headers['x-ufo-stop-turn']){stops++;return Response.json({});}return url.includes('/chat?')?Response.json({turn_id:'quota-turn',conversation_id:'quota-chat'}):new Response('event: parked\ndata: '+JSON.stringify({message:'This workspace is out of credit. Your message is answered automatically once credit is added.'})+'\n\n');};
 try{await assert.rejects(upstream('x',()=>{},AbortSignal.timeout(5000),account),e=>e.code==='UFO_INSUFFICIENT_QUOTA'&&/额度/.test(e.message));assert.equal(stops,1);}finally{global.fetch=original;}
});
