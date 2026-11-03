'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {begin}=require('../web-sessions');
const account={workspace:'https://example.test',token:'token',proxy:''};
const tools=[{type:'function',function:{name:'read_file',description:'UNIQUE_TOOL_DEFINITION',parameters:{type:'object'}}}];
const body={model:'ufo',tools,messages:[{role:'system',content:'SYSTEM_CONTEXT_'+ 'x'.repeat(60000)},{role:'user',content:'Read file'}]};
const answer={role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'read_file',arguments:'{}'}}]};
const follow={...body,messages:[...body.messages,answer,{role:'tool',tool_call_id:'call_1',content:'RESULT_MARKER'}]};
async function seed(key){const s=await begin({account,body,conversationKey:key});s.transport.onAccepted({conversation_id:'remote-'+key});s.commit(answer);s.release();return s;}
test('incremental tool follow-up reuses remote conversation without history or definitions',async()=>{
 await seed('incremental');const s=await begin({account,body:follow,conversationKey:'incremental'});
 try{assert.equal(s.reused,true);assert.equal(s.transport.conversationId,'remote-incremental');assert(!s.prompt.includes('SYSTEM_CONTEXT_'));assert(!s.prompt.includes('UNIQUE_TOOL_DEFINITION'));assert(s.prompt.includes('RESULT_MARKER'));assert(s.prompt.includes('call_1'));assert(s.sentBytes<s.fullBytes/10);}finally{s.release();}
});
test('branch, duplicate, account/model/tool changes, and different client IDs never reuse stale state',async()=>{
 const cases=[{body},{body:{...follow,messages:[{role:'system',content:'edited'},...follow.messages.slice(1)]}},{account:{...account,token:'other'}},{body:{...follow,model:'different'}},{body:{...follow,tools:[{type:'function',function:{name:'other'}}]}},{conversationKey:'another-client'}];
 for(let i=0;i<cases.length;i++){const key='isolation-'+i;await seed(key);const s=await begin({account,body:follow,conversationKey:key,...cases[i]});assert.equal(s.reused,false);assert.equal(s.transport.conversationId,null);s.release();}
});
test('failed or cancelled continuation invalidates the remote mapping',async()=>{
 await seed('failed');let s=await begin({account,body:follow,conversationKey:'failed'});assert(s.reused);s.release();s=await begin({account,body:follow,conversationKey:'failed'});assert.equal(s.reused,false);s.release();
});
test('same conversation serializes requests and cancelled waiters do not block later requests',async()=>{
 const first=await begin({account,body,conversationKey:'lock'}),controller=new AbortController();let entered=false;
 const waiting=begin({account,body:follow,conversationKey:'lock',signal:controller.signal});controller.abort(new Error('cancel queued'));await assert.rejects(waiting,/cancel queued/);
 const third=begin({account,body:follow,conversationKey:'lock'}).then(s=>{entered=true;return s;});await new Promise(r=>setImmediate(r));assert.equal(entered,false);
 first.transport.onAccepted({conversation_id:'locked'});first.commit(answer);first.release();const next=await third;assert(next.reused);next.release();
});
test('cache TTL expiration and disabled mode fall back to full context',async()=>{
 await seed('ttl');const now=Date.now;let s;try{Date.now=()=>now()+3600001;s=await begin({account,body:follow,conversationKey:'ttl'});assert.equal(s.reused,false);}finally{Date.now=now;s?.release();}
 await seed('disabled');process.env.UFO_WEB_SESSION_CACHE='0';try{s=await begin({account,body:follow,conversationKey:'disabled'});assert.equal(s.reused,false);}finally{delete process.env.UFO_WEB_SESSION_CACHE;s?.release();}
});
