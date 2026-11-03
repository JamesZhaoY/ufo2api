'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{CatalogTextStream}=require('../catalog-stream');
test('incrementally decodes fragmented JSON text, escapes and unicode',()=>{let out='';const p=new CatalogTextStream(s=>out+=s);for(const chunk of ['{"selected_tools":[],','"tool_calls":[],"content":"Hello ','world\\','n\\u4e','2d!"}'])p.push(chunk);assert.equal(out,'Hello world\n中!');});
test('never emits text before empty tool selections are confirmed',()=>{let out='';const p=new CatalogTextStream(s=>out+=s);p.push('{"selected_tools":["shell"],"tool_calls":[],"content":"bad"}');assert.equal(out,'');});
test('handles surrogate pairs without emitting incomplete characters',()=>{let out='';const p=new CatalogTextStream(s=>out+=s);p.push('{"selected_tools":[],"tool_calls":[],"content":"\\uD83D');assert.equal(out,'');p.push('\\uDE00"}');assert.equal(out,'😀');});
