'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ufo-routing-'));process.env.UFO_HOME=tmp;process.env.UFO_PROXY_PORT='18777';process.env.UFO_PROXY_API_KEY='test-local';const accounts=require('../accounts'),pool=require('../pool'),{server}=require('../server');
function post(pathname,data,headers={}){return new Promise((resolve,reject)=>{let b=JSON.stringify(data);let req=http.request({host:'127.0.0.1',port:18777,path:pathname,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(b),authorization:'Bearer test-local',...headers}},r=>{let text='';r.on('data',x=>text+=x);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(b)});}
test('HTTP routes sticky conversations, rotates and honors quota exhaustion',async()=>{
 const aa=accounts.saveAccount({email:'a@example.com',token:'token-a',workspace:'https://app.ufo.ai',proxy:''});accounts.saveAccount({email:'b@example.com',token:'token-b',workspace:'https://app.ufo.ai',proxy:''});pool.saveSettings({strategy:'round_robin',sticky:true,sticky_minutes:60});
 let selected=[],balanceA=9;const previous=global.fetch;
 global.fetch=async(url,o)=>{if(url.endsWith('/ext/metronome/billing'))return new Response(JSON.stringify({limited:true,balance_micro_usd:o.headers.cookie.includes('token-a')?balanceA:20,refused_below_micro_usd:2}));if(url.includes('/surface/ufo/')){selected.push(o.headers.authorization);return new Response('frame\tmessage\t{"text":"ok"}\nframe\tterminal\t{"status":"done"}\n');}throw Error('unexpected');};
 await Promise.all(accounts.read().accounts.map(a=>pool.quota(a,true)));
 await new Promise(r=>server.listen(18777,'127.0.0.1',r));const body={model:'ufo',messages:[{role:'user',content:'hello'}]};
 try{for(const id of ['chat-a','chat-a','chat-b']){let result=await post('/v1/chat/completions',body,{'x-conversation-id':id});assert.equal(result.status,200);}assert.deepEqual(selected,['Bearer token-a','Bearer token-a','Bearer token-b']);
 balanceA=1;await pool.quota(aa,true);let exhausted=await post('/v1/chat/completions',body,{'x-conversation-id':'chat-a'});assert.equal(exhausted.status,503);assert.equal(selected.length,3);
 pool.saveSettings({strategy:'quota',sticky:true,sticky_minutes:60});let next=await post('/v1/chat/completions',body,{'x-conversation-id':'fresh'});assert.equal(next.status,200);assert.equal(selected.at(-1),'Bearer token-b');
 const history=JSON.parse(fs.readFileSync(path.join(tmp,'activity.json'),'utf8'));assert.equal(history.length,5);assert.equal(history.filter(x=>x.outcome==='success').length,4);assert.equal(history.filter(x=>x.outcome==='failed').length,1);assert(!JSON.stringify(history).includes('hello'));assert(!JSON.stringify(history).includes('token-a'));assert.equal(fs.statSync(path.join(tmp,'activity.json')).mode&0o777,0o600);
 }finally{global.fetch=previous;await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});}
});
