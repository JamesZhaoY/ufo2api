'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,attachments}=require('../message-content'),sessions=require('../web-sessions'),{upstream}=require('../web-upstream');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=';
const block={type:'image_url',image_url:{url:'data:image/png;base64,'+png}};
const account={workspace:'https://images.test',token:'test',proxy:''};
test('screenshot blocks keep their bytes and become file references, never base64 prompts',()=>{
 for(const image of [block,{type:'image',mimeType:'image/png',data:png},{type:'image',source:{type:'base64',media_type:'image/png',data:png}}]){
  const messages=[{role:'tool',tool_call_id:'capture',content:[{type:'text',text:'Screenshot attached'},image]}];normalize(messages);
  assert.match(messages[0].content,/Screenshot attached\n\[Attached image: image-[a-f0-9]+\.png\]/);assert(!JSON.stringify(messages).includes(png));
  assert.deepEqual(attachments(messages)[0].bytes,Buffer.from(png,'base64'));assert.equal(messages[0].tool_call_id,'capture');
 }
});
test('invalid images and unknown blocks fail explicitly without losing content silently',()=>{
 for(const image of [{type:'image_url',image_url:{url:'http://127.0.0.1/private'}},{type:'image',mimeType:'image/png',data:'AAAA'},{type:'audio',data:'private'}])assert.throws(()=>normalize([{role:'user',content:[image]}]),e=>e.code==='unsupported_message_content'&&e.param==='messages[0].content'&&!e.message.includes('private'));
});
test('cached conversation sends only new screenshots and preserves image identity across serialization',async()=>{
 const firstMessages=[{role:'user',content:[{type:'text',text:'Inspect'},block]}];normalize(firstMessages);
 const first=await sessions.begin({account,body:{model:'ufo',messages:firstMessages},conversationKey:'images'});
 assert.equal(first.transport.attachments.length,1);first.transport.onAccepted({conversation_id:'c'});first.commit({role:'assistant',content:'Seen'});first.release();
 const nextMessages=[{role:'user',content:[{type:'text',text:'Inspect'},block]},{role:'assistant',content:'Seen'},{role:'user',content:'Continue'}];normalize(nextMessages);
 const next=await sessions.begin({account,body:{model:'ufo',messages:nextMessages},conversationKey:'images'});
 try{assert.equal(next.reused,true);assert.equal(next.transport.attachments.length,0);assert(!next.prompt.includes(png));assert.equal(next.sentBytes,Buffer.byteLength(next.prompt));assert(next.fullBytes>=Buffer.from(png,'base64').length);}finally{next.release();}
});
test('web upload uses the observed message/file multipart contract and maintains model choice',async()=>{
 const original=global.fetch;const messages=[{role:'tool',content:[block]}];normalize(messages);let uploaded=false;
 global.fetch=async(url,options)=>{
  if(url.endsWith('/api/agents'))return Response.json({agents:[{id:'chat',name:'chat'}]});
  if(url.includes('/chat?')){uploaded=true;assert(options.body instanceof FormData);assert.equal(options.headers['content-type'],undefined);assert.equal(options.headers['x-ufo-model'],'gpt-6-astra');assert.equal(options.body.get('message'),'Inspect screenshot');const file=options.body.get('file');assert.match(file.name,/\.png$/);assert.equal(file.type,'image/png');assert.deepEqual(Buffer.from(await file.arrayBuffer()),Buffer.from(png,'base64'));return Response.json({conversation_id:'c',turn_id:'t'});}
  return new Response('event: terminal\ndata: {"status":"done","text":"Seen"}\n\n');
 };
 try{assert.equal(await upstream('Inspect screenshot',()=>{},AbortSignal.timeout(5000),account,'gpt-6-astra',{attachments:attachments(messages)}),'Seen');assert(uploaded);}finally{global.fetch=original;}
});
