'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const compat=require('../compat');
const tools=[{type:'function',function:{name:'read_file',parameters:{type:'object'}}}];
test('oversized initial DSH instructions report input size and actionable 413 classification',()=>{
 assert.throws(()=>compat.fastCatalogPlan([{role:'system',content:'初始指令'.repeat(4000)},{role:'user',content:'hello'}],{tools}),e=>e.code==='UFO_INPUT_TOO_LARGE'&&e.status===413&&/system/.test(e.message)&&/DSH/.test(e.message));
});
const {compact,chunks}=require('../context-compact');
test('compression preserves roles, tool links, latest user text and does not mutate input',async()=>{
 const messages=[{role:'system',content:'规则'.repeat(20000)},{role:'user',content:'Read my file'},{role:'assistant',content:null,tool_calls:[{id:'call_x',type:'function',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'call_x',content:'result'}];
 const original=JSON.stringify(messages);let calls=0;
 const options={scope:'unit-a',summarize:async prompt=>{calls++;assert(Buffer.byteLength(prompt)<39000);return 'Preserve the rules and read the requested file.';}};
 const result=await compact(messages,options);
 assert(result.after<=16000);assert(result.compressed>0);assert.equal(result.messages[0].role,'system');assert.equal(result.messages[1].content,'Read my file');assert.equal(result.messages[3].tool_call_id,'call_x');assert.deepEqual(result.messages[2],messages[2]);assert.equal(JSON.stringify(messages),original);
 const previous=calls;await compact(messages,options);assert.equal(calls,previous);
 await compact(messages,{...options,scope:'unit-b'});assert(calls>previous);
});
test('chunking counts UTF-8 and JSON escapes without damaging Unicode',()=>{const text=('你好😀"\\\n').repeat(10000),parts=chunks(text);assert.equal(parts.join(''),text);assert(parts.every(x=>Buffer.byteLength(JSON.stringify(x))<=24000));});
test('summary that cannot fit is rejected instead of silently truncated',async()=>{await assert.rejects(compact([{role:'system',content:'x'.repeat(50000)}],{scope:'bad-summary',summarize:async()=> 'x'.repeat(25000)}),/摘要仍超过预算/);});
test('independent summary parts run with bounded concurrency instead of adding their latency',async()=>{
 let active=0,peak=0;
 await compact([{role:'system',content:'a'.repeat(24000)+'b'.repeat(24000)+'c'.repeat(24000)}],{scope:'parallel-test',summarize:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,15));active--;return 'short';}});
 assert.equal(peak,2);
});
test('summary timeout cancels pending work and retry reuses completed fragments',async()=>{
 const messages=[{role:'system',content:'a'.repeat(23998)+'b'.repeat(23998)}];let firstPrompt,calls=0;
 await assert.rejects(compact(messages,{scope:'resume-timeout',timeoutMs:40,summarize:async(prompt,signal)=>{if(++calls===1){firstPrompt=prompt;return 'completed first fragment';}return new Promise((resolve,reject)=>{const hold=setTimeout(()=>resolve('too late'),1000);signal.addEventListener('abort',()=>{clearTimeout(hold);reject(signal.reason);},{once:true});});}}),e=>e.code==='UFO_CONTEXT_TIMEOUT');
 let reused=0;const result=await compact(messages,{scope:'resume-timeout',summarize:async prompt=>{assert.notEqual(prompt,firstPrompt);return 'remaining fragment';},onProgress:p=>{reused=p.cacheHits;}});
 assert(result.after<=16000);assert(reused>0);
});
test('client cancellation remains cancellation instead of summary timeout',async()=>{
 const controller=new AbortController();controller.abort(new Error('client disconnected'));
 await assert.rejects(compact([{role:'system',content:'x'.repeat(50000)}],{scope:'cancel',signal:controller.signal,summarize:async()=>{assert.fail('must not call upstream');}}),/client disconnected/);
});
