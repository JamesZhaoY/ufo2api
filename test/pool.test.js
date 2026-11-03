'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ufo-pool-'));process.env.UFO_HOME=tmp;const pool=require('../pool');
const candidate=(id,status,balance=0,threshold=0)=>({account:{id},quota:{status,balance_micro_usd:balance,refused_below_micro_usd:threshold}});
const a=candidate('a','available',10,1),b=candidate('b','available',20,2),zero=candidate('zero','exhausted',1,1),unknown=candidate('unknown','unknown');
test('strategies prefer usable quota, rotate and never treat unknown as zero',()=>{
 const opts={strategy:'quota',sticky:false,sticky_minutes:1};assert.equal(pool.choose([a,b,unknown,zero],opts,null).id,'b');assert.equal(pool.choose([zero,unknown],opts,null).id,'unknown');assert.throws(()=>pool.choose([zero],opts,null),/耗尽/);
 opts.strategy='round_robin';assert.deepEqual(Array.from({length:4},()=>pool.choose([a,b,zero],opts,null).id),['a','b','a','b']);
 opts.strategy='random';for(let i=0;i<100;i++)assert.notEqual(pool.choose([a,b,zero],opts,null).id,'zero');
});
test('sticky mapping survives strategy changes and never silently reassigns exhausted account',()=>{
 const opt={strategy:'round_robin',sticky:true,sticky_minutes:1},key='explicit:test-sticky';let x=pool.choose([a,b],opt,key,1000);assert.equal(pool.choose([a,b],{...opt,strategy:'quota'},key,2000).id,x.id);
 assert.throws(()=>pool.choose([{...a,quota:{status:'exhausted'}},b],opt,key,3000),/不可用/);
 assert.equal(pool.choose([a,b],{...opt,strategy:'quota'},key,64001).id,'b');
});
test('conversation IDs and settings are validated',()=>{
 const body={messages:[{role:'system',content:'s'},{role:'user',content:'hello'}]};assert.equal(pool.conversationKey(body,'abc'),'explicit:abc');assert.match(pool.conversationKey(body),/^history:/);assert.throws(()=>pool.conversationKey(body,'x'.repeat(257)));assert.throws(()=>pool.saveSettings({strategy:'foo',sticky:true,sticky_minutes:60}));assert.equal(pool.saveSettings({strategy:'random',sticky:true,sticky_minutes:30}).strategy,'random');assert.equal(fs.statSync(path.join(tmp,'settings.json')).mode&0o777,0o600);
});
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('model checks preserve sticky binding and skip unsupported new selections',async()=>{
 const opts={strategy:'quota',sticky:true,sticky_minutes:5},key='explicit:support-check';const seen=[],preferred=candidate('a','available',30,1);
 const chosen=await pool.chooseSupported([preferred,b],opts,key,async x=>{seen.push(x.id);return x.id==='b'});assert.equal(chosen.id,'b');assert(seen.includes('a'));assert.equal((await pool.chooseSupported([a,b],opts,key,async()=>true)).id,'b');await assert.rejects(pool.chooseSupported([a,b],opts,key,async()=>false),/粘性/);
});
test('concurrent requests with same session share a single sticky choice',async()=>{
 const opts={strategy:'round_robin',sticky:true,sticky_minutes:5},key='explicit:concurrent';let release;const gate=new Promise(r=>release=r);
 const one=pool.chooseSupported([a,b],opts,key,async()=>{await gate;return true});const two=pool.chooseSupported([a,b],opts,key,async()=>true);release();const result=await Promise.all([one,two]);assert.equal(result[0].id,result[1].id);
});
test('registration settings validate and preserve old configurations',()=>{const old={strategy:'round_robin',sticky:false,sticky_minutes:60};fs.writeFileSync(path.join(tmp,'settings.json'),JSON.stringify(old));assert.equal(pool.settings().registration_concurrency,2);const saved=pool.saveSettings({...old,registration_concurrency:5,proxy_sources:[],registration_proxies:['http://127.0.0.1:8080']});assert.equal(saved.registration_concurrency,5);assert.deepEqual(pool.settings().registration_proxies,['http://127.0.0.1:8080/']);assert.equal(pool.saveSettings(old).registration_concurrency,5);assert.throws(()=>pool.saveSettings({...old,registration_concurrency:0}),/并发/);assert.throws(()=>pool.saveSettings({...old,proxy_sources:[],registration_proxies:[]}),/至少/);});
test('registration batch limit defaults to 50 and is persisted with bounds',()=>{const old={strategy:'round_robin',sticky:true,sticky_minutes:60};fs.writeFileSync(path.join(tmp,'settings.json'),JSON.stringify(old));assert.equal(pool.settings().registration_batch_limit,50);pool.saveSettings({...old,registration_batch_limit:300});assert.equal(pool.settings().registration_batch_limit,300);assert.equal(pool.saveSettings(old).registration_batch_limit,300);for(const limit of [0,501,1.5,'50'])assert.throws(()=>pool.saveSettings({...old,registration_batch_limit:limit}),/上限/);});
