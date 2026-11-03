'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ufo-adapter-test-'));process.env.UFO_HOME=temp;process.env.UFO_PROXY_PORT='18776';process.env.UFO_PROXY_API_KEY='test-local';
const accounts=require('../accounts'),dashboard=require('../dashboard-auth');const {server}=require('../server');let sessionCookie='';
function request(method,url,data,origin=true){return new Promise((resolve,reject)=>{const body=data===undefined?'':JSON.stringify(data);const headers={host:'127.0.0.1:18776',authorization:'Bearer test-local'};if(sessionCookie)headers.cookie=sessionCookie;if(method==='POST'){headers['content-type']='application/json';headers['x-ufo-ui']='1';headers['content-length']=Buffer.byteLength(body);if(origin)headers.origin='http://127.0.0.1:18776';}const r=http.request({host:'127.0.0.1',port:18776,path:url,method,headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b),headers:res.headers}))});r.on('error',reject);r.end(body)});}
test('account login, selection, model query and proxy isolation',async()=>{
 const previous=global.fetch;let sessions=new Map(),observed=[];
 global.fetch=async(url,o)=>{observed.push({url,hasProxy:!!o.dispatcher,model:o.headers?.['x-ufo-model'],session:o.headers?.['x-ufo-session']});
  if(url.endsWith('/v1/onboard/onboard')){let step=sessions.get(o.headers['x-ufo-session'])||0;sessions.set(o.headers['x-ufo-session'],step+1);return new Response(step===0?'ask\tEmail\n':step===1?'ask\tCode\n':`token\tsecret-${step}\nworkspace\thttps://app.ufo.ai\n`);}
  if(url.endsWith('/ext/metronome/billing'))return new Response(JSON.stringify({limited:true,balance_micro_usd:10000000,refused_below_micro_usd:2000000}));
  if(url.endsWith('/surface/web/api/agents'))return new Response(JSON.stringify({models:['auto','gpt-test']}),{headers:{'content-type':'application/json'}});
  if(url.includes('/surface/ufo/'))return new Response('frame\tmessage\t{"text":"OK"}\nframe\tterminal\t{"status":"done"}\n');throw Error('unexpected');};
 await new Promise(r=>server.listen(18776,'127.0.0.1',r));
 try{
  assert.equal((await request('GET','/api/accounts')).status,401);assert.equal((await request('POST','/auth/login',{password:dashboard.password()},false)).status,403);const logged=await request('POST','/auth/login',{password:dashboard.password()});assert.equal(logged.status,200);assert.match(logged.headers['set-cookie'][0],/HttpOnly/);sessionCookie=logged.headers['set-cookie'][0].split(';')[0];
  let bad=await request('POST','/api/login/start',{email:'a@example.com'},false);assert.equal(bad.status,403);
  let start=await request('POST','/api/login/start',{email:'a@example.com',proxy:'http://user:pass@127.0.0.1:9988'});assert.equal(start.status,200);
  let done=await request('POST','/api/login/complete',{loginId:start.body.loginId,code:'123456'});assert.equal(done.status,200);const first=done.body.activeId;assert.equal(done.body.accounts[0].proxy,'http://127.0.0.1:9988');assert(!JSON.stringify(done.body).includes('secret'));assert(!JSON.stringify(done.body).includes('pass'));
  start=await request('POST','/api/login/start',{email:'b@example.com'});done=await request('POST','/api/login/complete',{loginId:start.body.loginId,code:'123456'});const second=done.body.activeId;assert.notEqual(first,second);
  let before=observed.filter(x=>x.url.endsWith('/ext/metronome/billing')).length;let localQuotas=await request('GET','/api/quotas');assert.equal(localQuotas.status,200);assert.equal(observed.filter(x=>x.url.endsWith('/ext/metronome/billing')).length,before);let updatedQuotas=await request('POST','/api/quotas/refresh',{});assert.equal(updatedQuotas.status,200);assert.equal(observed.filter(x=>x.url.endsWith('/ext/metronome/billing')).length,before+2);
  let m=await request('GET','/v1/models');assert.equal(m.status,200);assert(m.body.data.some(x=>x.id==='gpt-test'));assert.equal(observed.filter(x=>x.url.endsWith('/api/agents')).at(-1).hasProxy,false);
  await request('POST','/api/accounts/select',{id:first});m=await request('POST','/api/models/refresh',{});assert.equal(m.status,200);assert.equal(observed.filter(x=>x.url.endsWith('/api/agents')).at(-1).hasProxy,true);
  const chat=await request('POST','/v1/chat/completions',{model:'gpt-test',messages:[{role:'user',content:'hello'}]});assert.equal(chat.status,200);assert.equal(chat.body.choices[0].message.content,'OK');assert.equal(observed.filter(x=>x.url.includes('/surface/ufo/')).at(-1).model,'gpt-test');assert.equal(observed.filter(x=>x.url.includes('/surface/ufo/')).at(-1).hasProxy,true);
  const backup=await request('POST','/api/accounts/export',{});assert.equal(backup.body.accounts.length,2);assert.equal(backup.body.accounts[0].token,'secret-2');assert.match(backup.body.accounts[0].proxy,/user:pass/);
  let imported=await request('POST','/api/accounts/import',backup.body);assert.equal(imported.body.imported,0);assert.equal(imported.body.skipped,2);
  const invalid={format:'ufo-accounts',version:1,accounts:[{name:'c@example.com',token:'valid',workspace:'https://app.ufo.ai'},{name:'bad',token:'',workspace:'https://app.ufo.ai'}]};
  const failed=await request('POST','/api/accounts/import',invalid);assert.equal(failed.status,400);assert.equal(accounts.list().accounts.length,2);
  await request('POST','/api/accounts/delete',{id:second});imported=await request('POST','/api/accounts/import',backup.body);assert.equal(imported.body.imported,1);assert.equal(imported.body.skipped,1);assert.equal(imported.body.activeId,first);
  assert.equal(fs.statSync(path.join(temp,'accounts.json')).mode&0o777,0o600);
 }finally{global.fetch=previous;await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
});
