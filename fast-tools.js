'use strict';
const Ajv=require('ajv');
const ajv=new Ajv({strict:true,allowUnionTypes:true,allErrors:false});
const validators=new Map();
function validArguments(def,args){
 if(!args||typeof args!=='object'||Array.isArray(args))return false;
 if(def.parameters===undefined)return Object.keys(args).length===0;
 try{
  const key=JSON.stringify(def.parameters);
  let validator=validators.get(key);
  if(!validator){
   validator=ajv.compile(def.parameters);
   // Keep Ajv's own cache bounded as well; retained functions remain usable.
   ajv.removeSchema(def.parameters);
   if(validators.size>=128)validators.delete(validators.keys().next().value);
   validators.set(key,validator);
  }
  return !validator.$async&&validator(args)===true;
 }catch{return false;}
}
function rankTools(messages,tools){
 const last=[...messages].reverse().find(m=>m.role==='user'&&typeof m.content==='string')?.content.toLowerCase()||'';
 const used=new Set();for(const m of messages)if(m.role==='assistant')for(const call of m.tool_calls||[])if(call.function?.name)used.add(call.function.name);
 const terms=(last.match(/[a-z][a-z0-9_-]{2,}/g)||[]).filter(x=>!['the','and','for','with','that','this','please','use','tool','then','from','your','only','run','exactly'].includes(x));
 return tools.map(t=>{const f=t.function,n=f.name.toLowerCase(),d=(typeof f.description==='string'?f.description:'').toLowerCase();let score=used.has(f.name)?1000:0;if(last.includes(n)&&n.length>3)score+=500;
  if(/shell|terminal|bash|command|执行|终端|命令|运行|执行命令|脚本/.test(last)&&/shell|bash|terminal|exec|command/.test(n))score+=300;
  if(/read|file|文件|读取|查看/.test(last)&&/read|file|view/.test(n))score+=140;
  if(/search|find|搜索|查找|检索/.test(last)&&/search|grep|find/.test(n))score+=140;
  for(const term of terms){if(n.includes(term))score+=30;else if(d.includes(term))score+=2;}
  return {tool:t,score};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
}
function validCalls(calls,selected,ready,tools,parallel){
 if(!Array.isArray(calls)||!calls.length||calls.length!==selected.length||(!parallel&&calls.length>1))return false;
 const expected=new Set(selected),seen=new Set(),readySet=new Set(ready);
 for(const call of calls){const name=call?.name??call?.function?.name;if(!expected.has(name)||!readySet.has(name)||seen.has(name))return false;seen.add(name);let args=call?.arguments??call?.function?.arguments;if(typeof args==='string'){try{args=JSON.parse(args)}catch{return false}}if(!args||typeof args!=='object'||Array.isArray(args))return false;const def=tools.find(t=>t.function.name===name)?.function;if(!def||!validArguments(def,args))return false;}
 return seen.size===expected.size;
}
module.exports={rankTools,validCalls,validArguments};
