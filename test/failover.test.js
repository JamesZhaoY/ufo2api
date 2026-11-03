'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ufo-failover-'));process.env.UFO_HOME=tmp;process.env.UFO_PROXY_API_KEY='test';process.env.UFO_TRANSPORT='web';delete process.env.UFO_TOKEN;delete process.env.UFO_WORKSPACE_URL;
const accounts=require('../accounts'),cache=require('../state-cache'),pool=require('../pool'),{server}=require('../server');
const a=accounts.saveAccount({email:'a@example.test',token:'token-a',workspace:'https://example.test',proxy:''}),b=accounts.saveAccount({email:'b@example.test',token:'token-b',workspace:'https://example.test',proxy:''});
for(const account of [a,b])cache.put(account,'quota',{status:'available',balance_micro_usd:10,refused_below_micro_usd:0});
pool.saveSettings({strategy:'round_robin',sticky:true,sticky_minutes:60});
function post(){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer test','content-type':'application/json','x-conversation-id':'same-dsh-chat'}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify({model:'ufo',messages:[{role:'user',content:'hello'}]}));});}
test('exhausted account freezes durably and the same conversation retries on another account',async()=>{
 const original=global.fetch,chosen=[];
 global.fetch=async(url,o)=>{const isA=o.headers.cookie==='ufo_session=token-a';if(url.endsWith('/api/agents'))return Response.json({agents:[{name:'chat',id:'chat'}]});if(o.headers['x-ufo-stop-turn'])return Response.json({});if(url.includes('/chat?')){chosen.push(isA?'a':'b');return Response.json({turn_id:isA?'a':'b',conversation_id:'c'});}return new Response(isA?'event: parked\ndata: {"message":"This workspace is out of credit."}\n\n':'event: terminal\ndata: {"status":"done","text":"OK"}\n\n');};
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{assert.equal((await post()).status,402);assert.equal(cache.get(a,'quota').status,'exhausted');const result=await post();assert.equal(result.status,200,JSON.stringify(result.body));assert.equal((await post()).status,200);assert.deepEqual(chosen,['a','b','b']);const saved=JSON.parse(fs.readFileSync(path.join(tmp,'state-cache.json'),'utf8'));assert.equal(saved.accounts[a.id].quota.status,'exhausted');}finally{global.fetch=original;await new Promise(r=>server.close(r));}
});
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('stale quota refresh cannot thaw a newly frozen account; successful later refresh can',async()=>{
 const original=global.fetch;cache.put(a,'quota',{status:'available',balance_micro_usd:100,refused_below_micro_usd:0});let resolve;
 global.fetch=()=>new Promise(r=>resolve=r);
 try{const refreshing=pool.quota(a,true);pool.freeze(a);resolve(Response.json({limited:true,balance_micro_usd:100,refused_below_micro_usd:0}));assert.equal((await refreshing).status,'exhausted');
 const opts={strategy:'quota',sticky:true,sticky_minutes:60};const stale=[{account:a,quota:{status:'available',balance_micro_usd:100}},{account:b,quota:cache.get(b,'quota')}];assert.equal((await pool.chooseSupported(stale,opts,'stale-snapshot',async()=>true)).id,b.id);
 global.fetch=async()=>{throw Error('offline')};assert.equal((await pool.quota(a,true)).status,'exhausted');
 global.fetch=async()=>Response.json({limited:true,balance_micro_usd:100,refused_below_micro_usd:0});assert.equal((await pool.quota(a,true)).status,'available');assert.equal(cache.get(a,'quota').upstreamRejectedAt,undefined);
 }finally{global.fetch=original;}
});
test('freezing during model checks is respected before returning an account',async()=>{
 cache.put(a,'quota',{status:'available',balance_micro_usd:100,refused_below_micro_usd:0});
 const candidates=[{account:a,quota:cache.get(a,'quota')},{account:b,quota:cache.get(b,'quota')}];
 const selected=await pool.chooseSupported(candidates,{strategy:'quota',sticky:true,sticky_minutes:60},'freeze-during-check',async account=>{if(account.id===a.id)pool.freeze(a);return true;});assert.equal(selected.id,b.id);
 pool.freeze(b);assert.throws(()=>pool.choose(candidates,{strategy:'quota',sticky:true,sticky_minutes:60},'freeze-during-check'),e=>e.code==='UFO_INSUFFICIENT_QUOTA');
 delete require.cache[require.resolve('../state-cache')];assert.equal(require('../state-cache').get(a,'quota').status,'exhausted');
});
