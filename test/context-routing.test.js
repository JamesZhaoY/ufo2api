'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ufo-compact-'));
process.env.UFO_HOME=tmp;process.env.UFO_TOKEN='test';process.env.UFO_WORKSPACE_URL='https://example.test';process.env.UFO_PROXY_API_KEY='test';process.env.UFO_CONTEXT_COMPACT='1';
const {server}=require('../server');
function post(body){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(JSON.stringify(body));});}
test('long first-turn DSH instructions compact before a valid tool response; disabled mode returns 413',async()=>{
 const original=global.fetch;let summaries=0,generations=0;
 global.fetch=async(url,opts)=>{assert(Buffer.byteLength(opts.body)<=39000);let text;if(opts.body.startsWith('Summarize the quoted text')){summaries++;text='Use client-side read_file to read the requested file. Do not fabricate results.';}else{generations++;assert(opts.body.includes('Read README.md'));text=JSON.stringify({tool_calls:[{name:'read_file',arguments:{path:'README.md'}}],content:null});}return new Response('frame\tmessage\t'+JSON.stringify({text})+'\nframe\tterminal\t{"status":"done"}\n');};
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const body={model:'ufo',messages:[{role:'system',content:'DSH instructions. '.repeat(3000)},{role:'user',content:'Read README.md'}],tools:[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}]};
 const first=await post(body);assert.equal(first.status,200,first.text);assert.equal(first.headers['x-ufo-context-compacted'],'1');assert.equal(JSON.parse(first.text).choices[0].message.tool_calls[0].function.name,'read_file');assert(summaries>=2);assert.equal(generations,1);
 const previous=summaries;const second=await post({...body,stream:true});assert.equal(second.status,200);assert.match(second.text,/tool_calls/);assert.match(second.text,/\[DONE\]/);assert.equal(summaries,previous);
 process.env.UFO_CONTEXT_COMPACT='0';const disabled=await post(body);assert.equal(disabled.status,413);assert.match(disabled.text,/system=/);
 }finally{global.fetch=original;await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});}
});
