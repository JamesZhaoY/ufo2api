'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');

test('selected account export and both quota refresh modes exclude other accounts',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ufo-selection-'));process.env.UFO_HOME=home;process.env.UFO_PROXY_PORT='18779';
 const accounts=require('../accounts'),auth=require('../dashboard-auth'),{server}=require('../server');
 const first=accounts.saveAccount({email:'first@example.com',token:'first-token',workspace:'https://app.ufo.ai'});
 const second=accounts.saveAccount({email:'second@example.com',token:'second-token',workspace:'https://app.ufo.ai'});
 const originalFetch=global.fetch,seen=[];let cookie='',release;
 global.fetch=async(url,opts)=>{assert.match(url,/\/ext\/metronome\/billing$/);seen.push(opts.headers.cookie);if(release)await release.promise;return new Response(JSON.stringify({limited:true,balance_micro_usd:10000000,refused_below_micro_usd:0}));};
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 function request(url,data={}){return new Promise((resolve,reject)=>{const body=JSON.stringify(data);const req=http.request({host:'127.0.0.1',port,path:url,method:'POST',headers:{host:'127.0.0.1:18779',origin:'http://127.0.0.1:18779','x-ufo-ui':'1','content-type':'application/json',cookie}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers}));});req.on('error',reject);req.end(body);});}
 try{
  const login=await request('/auth/login',{password:auth.password()});assert.equal(login.status,200);cookie=login.headers['set-cookie'][0].split(';')[0];
  const exported=await request('/api/accounts/export',{ids:Array(500).fill(second.id)});assert.equal(exported.status,200);assert.deepEqual(exported.body.accounts.map(a=>a.token),['second-token']);assert.equal(exported.headers['cache-control'],'no-store');assert.equal(accounts.list().activeId,second.id);
  const sync=await request('/api/quotas/refresh',{ids:[first.id]});assert.equal(sync.status,200);assert.deepEqual(sync.body.accounts.map(a=>a.id),[first.id]);assert.deepEqual(seen,['ufo_session=first-token']);
  for(const ids of [[],null,'all',[42],['missing'],[first.id,'missing']])for(const endpoint of ['/api/accounts/export','/api/quotas/refresh']){const bad=await request(endpoint,{ids,background:true});assert.equal(bad.status,400);}
  assert.equal(seen.length,1);
  release={};release.promise=new Promise(r=>release.done=r);
  const background=await request('/api/quotas/refresh',{ids:[second.id],background:true});assert.equal(background.status,200);assert.equal(background.body.refresh.total,1);
  const repeated=await request('/api/quotas/refresh',{ids:[second.id],background:true});assert.equal(repeated.body.refresh.id,background.body.refresh.id);
  const conflicting=await request('/api/quotas/refresh',{ids:[first.id],background:true});assert.equal(conflicting.status,400);assert.deepEqual(seen,['ufo_session=first-token','ufo_session=second-token']);
  release.done();release=null;await new Promise(r=>setTimeout(r,20));
  assert.equal((await request('/api/accounts/export')).body.accounts.length,2);
  assert.equal((await request('/api/quotas/refresh')).body.accounts.length,2);assert.equal(seen.length,4);
 }finally{release?.done();global.fetch=originalFetch;await new Promise(r=>server.close(r));fs.rmSync(home,{recursive:true,force:true});}
});

const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
test('page selection preserves other pages, shows partial state and prunes removed accounts',()=>{
 const nodes=new Map(),context={Set,state:{accounts:[{id:'a'},{id:'b'},{id:'c'}]},accountSelected:new Set(['a','c','removed']),accountVisibleIds:['a','b'],quotaRefreshFlight:null,$:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function renderAccountSelection('),source.indexOf('function renderAccounts(')),context);vm.runInContext('renderAccountSelection()',context);
 assert.deepEqual([...context.accountSelected],['a','c']);assert.equal(nodes.get('#account-select-page').indeterminate,true);assert.equal(nodes.get('#refresh-selected-quotas').disabled,false);
 context.accountVisibleIds=['c'];vm.runInContext('renderAccountSelection()',context);assert.equal(nodes.get('#account-select-page').checked,true);context.quotaRefreshFlight=Promise.resolve();vm.runInContext('renderAccountSelection()',context);assert.equal(nodes.get('#refresh-selected-quotas').disabled,true);
 context.accountSelected.clear();vm.runInContext('renderAccountSelection()',context);assert.equal(nodes.get('#export-selected-accounts').disabled,true);
});

test('selected actions send only a snapshot of selected IDs and refuse empty selections',async()=>{
 const sent=[],nodes=new Map(),context={Set,Map,Promise,Date,quotaRefreshFlight:null,quotas:new Map(),selected:new Set(['b']),notify(){},confirm:()=>true,renderAccountSelection(){},renderAccounts(){},setTimeout:r=>r(),Blob,URL:{createObjectURL:()=>'',revokeObjectURL(){}},document:{body:{append(){}},createElement:()=>({click(){},remove(){}})},$:id=>{if(!nodes.has(id))nodes.set(id,{dataset:{},classList:{toggle(){}},setAttribute(){},querySelector:()=>({dataset:{idleLabel:'idle'}})});return nodes.get(id);},api:async(url,body)=>{sent.push({url,body});return {refresh:{status:'done',total:1,failed:0},accounts:[{id:'b'}]};}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function setRefreshBusy('),source.indexOf('async function load()'))+source.slice(source.indexOf('async function exportAccounts('),source.indexOf("$('#export-accounts').onclick=")),context);
 await vm.runInContext('loadQuotas(true,selected)',context);await vm.runInContext('exportAccounts(selected)',context);
 assert.deepEqual(JSON.parse(JSON.stringify(sent[0].body)),{background:true,ids:['b']});assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1).body)),{ids:['b']});context.selected.add('a');assert.equal(sent[0].body.ids.length,1);
 const before=sent.length;await vm.runInContext('loadQuotas(true,new Set())',context);await vm.runInContext('exportAccounts(new Set())',context);assert.equal(sent.length,before);
});
