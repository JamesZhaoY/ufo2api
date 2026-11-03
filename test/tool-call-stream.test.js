'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ToolCallStream}=require('../tool-call-stream');
const tools=[{type:'function',function:{name:'write_file'}}];
test('streams a tool name and partial arguments before generation finishes, withholding the closing brace',()=>{
 const out=[],s=new ToolCallStream(d=>out.push(d),{tools});
 s.push('{"tool_calls":[{"name":"write_file","arguments":{"content":"first');
 assert.equal(out[0].function.name,'write_file');assert(out.map(d=>d.function.arguments||'').join('').includes('first'));assert.equal(s.complete,false);
 s.push(' second","nested":{"braces":"} \\\" {"}}}],"content":null}');
 const args=out.map(d=>d.function.arguments||'').join('');assert.throws(()=>JSON.parse(args));assert.equal(s.complete,true);
 const calls=[{function:{name:'write_file',arguments:JSON.stringify(JSON.parse(s.arguments))}}];s.verify(calls);
 assert.deepEqual(JSON.parse(args+'}'),JSON.parse(calls[0].function.arguments));
});
test('handles every chunk boundary including Unicode and escaped braces',()=>{
 const args={content:'鹈鹕😀\n"x" { }',items:[1,{x:true}]},text=JSON.stringify({tool_calls:[{name:'write_file',arguments:args}],content:null});
 for(let i=1;i<text.length;i++){const out=[],s=new ToolCallStream(d=>out.push(d),{tools});s.push(text.slice(0,i));s.push(text.slice(i));s.verify([{function:{name:'write_file',arguments:JSON.stringify(args)}}]);assert.deepEqual(JSON.parse(out.map(d=>d.function.arguments||'').join('')+'}'),args);}
});
test('unconfirmed, prose-prefixed, string-encoded and unknown tool calls remain buffered',()=>{
 for(const text of ['{"tool_calls":[],"content":"answer"}','plan {"tool_calls":[{"name":"write_file","arguments":{}}]}','{"tool_calls":[{"name":"unknown","arguments":{}}]}','{"tool_calls":[{"name":"write_file","arguments":"{}"}]}']){const out=[],s=new ToolCallStream(d=>out.push(d),{tools});s.push(text);assert.deepEqual(out,[]);}
 const out=[],s=new ToolCallStream(d=>out.push(d),{tools,selected:'another'});s.push('{"tool_calls":[{"name":"write_file","arguments":{}}]}');assert.deepEqual(out,[]);
});
test('cannot finish incomplete or changed calls',()=>{
 const s=new ToolCallStream(()=>{},{tools});s.push('{"tool_calls":[{"name":"write_file","arguments":{"x":1');assert.throws(()=>s.verify([]));s.push('}}]}');assert.throws(()=>s.verify([{function:{name:'write_file',arguments:'{"x":2}'}}]));
});
