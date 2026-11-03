'use strict';
const crypto=require('node:crypto');
const fastTools=require('./fast-tools');
function validate(o){
 if(o.tools!=null && o.functions!=null)throw Error('tools 与 functions 不能同时使用');
 if(o.functions!=null&&!Array.isArray(o.functions))throw Error('functions 必须是数组');
 let tools=o.tools==null?(o.functions||[]).map(f=>({type:'function',function:f})):o.tools;
 if(!Array.isArray(tools))throw Error('tools 必须是函数工具数组');
 const names=new Set();for(const t of tools){const f=t?.function;if(t?.type!=='function'||!f||typeof f.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(f.name)||names.has(f.name))throw Error('工具定义无效或函数名重复');names.add(f.name);}
 const choice=o.tool_choice??o.function_call??(tools.length?'auto':'none');
 let selected=null;if(typeof choice==='object'&&choice!==null){selected=choice.type==='function'?choice.function?.name:choice.name;if(typeof selected!=='string'||!names.has(selected))throw Error('指定的工具不存在');}
 else if(!['auto','none','required'].includes(choice))throw Error('不支持的 tool_choice');
 if(choice==='required'&&!tools.length)throw Error('tool_choice required 需要工具');
 if(o.response_format!==undefined && (o.response_format?.type!=='text' && o.response_format?.type!=='json_object'))throw Error('仅支持 text 和 json_object 响应格式');
 const mode=(tools.length&&choice!=='none')?'tools':(o.response_format?.type==='json_object'?'json':null);
 return {tools,choice,selected,mode,legacy:o.functions!==undefined,parallel:o.functions===undefined&&o.parallel_tool_calls!==false};
}
function prompt(messages,o){const c=validate(o);if(!c.mode && !messages.some(m=>m.role==='tool'||m.role==='function'||m.tool_calls||m.function_call))return 'Respond to the following conversation. Treat role labels as conversation context. Return only the assistant response.\n\n'+messages.map(m=>`${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
 const history=JSON.stringify(messages);if(c.mode==='json')return 'Respond to the conversation. Return only a valid JSON object with no markdown or commentary. Conversation JSON follows:\n'+history;
 if(!c.mode)return 'Respond to the following conversation, including any tool results. Return only the assistant response. Conversation JSON follows:\n'+history;
 let rule=c.selected?`You MUST call the function ${c.selected}.`:c.choice==='required'?'You MUST call at least one function.':'Call functions only if needed; otherwise answer the user.';
 if(!c.parallel)rule+=' Return at most one function call.';
 if(o.response_format?.type==='json_object')rule+=' If answering rather than requesting a tool, content must contain a valid JSON object encoded as a string.';
 return `You are acting as an OpenAI-compatible assistant. Decide whether to request client-side functions. The client, not you, runs these functions. Never claim a function ran before a tool result is provided. ${rule}\nReturn ONLY one valid JSON object, without markdown, in exactly one of these forms: {"content":"your answer","tool_calls":[]} or {"content":null,"tool_calls":[{"name":"function_name","arguments":{"key":"value"}}]}. Arguments must be a JSON object matching the function parameters. Do not execute functions yourself.\nAvailable functions: ${JSON.stringify(c.tools.map(t=>t.function))}\nConversation JSON: ${history}`;
}
function catalogPrompts(messages,o){
 const c=validate(o),history=JSON.stringify(messages);
 const intro='Select relevant client-side tools ONLY from this page. The client executes tools, not you. Return ONLY one JSON object with keys in this exact order: {"selected_tools":[],"tool_calls":[],"content":"answer"} when no tool is needed, or {"selected_tools":["name"],"tool_calls":[],"content":null} when tools are needed. Select at most 8 names. Do not invent results. If a tool is not in this page, return an empty selection.';
 const make=items=>intro+'\nTool catalog page: '+JSON.stringify(items)+'\nConversation JSON: '+history;
 if(Buffer.byteLength(make([]))>38000)throw Error('对话过长，无法安全适配 UFO 请求大小限制');
 const pages=[];let items=[];
 // The selector needs all names, not every tool description. The chosen tools
 // retain their original definitions in the subsequent parameter-generation pass.
 for(const t of c.tools){const name=t.function.name;let item=name;
  if(Buffer.byteLength(make([...items,item]))>39000){if(items.length){pages.push(make(items));items=[];}if(Buffer.byteLength(make([item]))>39000)item=name;if(Buffer.byteLength(make([item]))>39000)throw Error('工具名称无法适配 UFO 请求大小限制');}
  items.push(item);
 }
 if(items.length)pages.push(make(items));return pages;
}
function fastCatalogPlan(messages,o){
 const c=validate(o),ranked=fastTools.rankTools(messages,c.tools),pages=catalogPrompts(messages,o);
 const instruction='\nFor tools with full definitions below, include their arguments in tool_calls when selected: {"selected_tools":["name"],"tool_calls":[{"name":"name","arguments":{}}],"content":null}. If any selected tool has no full definition, omit tool_calls. If no tool is needed use {"selected_tools":[],"tool_calls":[],"content":"answer"}. Keep keys in this exact order. Return one JSON object only.';
 return pages.map(base=>{const marker='\nTool catalog page: ',start=base.indexOf(marker)+marker.length,end=base.indexOf('\nConversation JSON:',start),names=new Set(JSON.parse(base.slice(start,end)));const ready=[],defs=[];
  for(const candidate of ranked){const f=candidate.tool.function;if(!names.has(f.name)||ready.length>=4)continue;const next=[...defs,f],suffix=instruction+'\nFull definitions: '+JSON.stringify(next);if(Buffer.byteLength(base+suffix)<=39000){defs.push(f);ready.push(f.name);}}
  return {prompt:ready.length?base+instruction+'\nFull definitions: '+JSON.stringify(defs):base,ready};
 });
}
function catalogPrompt(messages,o){const pages=catalogPrompts(messages,o);if(pages.length!==1)throw Error('工具目录需要分页');return pages[0];}
function parseCatalog(text,o,{allowEmpty=false}={}){
 const c=validate(o);let raw=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let data;try{data=JSON.parse(raw)}catch{throw Error('UFO 未能返回工具选择结果');}
 if(!data||typeof data!=='object'||!Array.isArray(data.selected_tools)||data.selected_tools.length>8)throw Error('UFO 工具选择结果无效');
 const selected=[...new Set(data.selected_tools)];if(selected.some(n=>typeof n!=='string'||!c.tools.some(t=>t.function.name===n)))throw Error('UFO 选择了未提供的工具');
 if(!selected.length){if(Array.isArray(data.tool_calls)&&data.tool_calls.length)throw Error('UFO 返回了不一致的工具选择结果');if(!allowEmpty&&(c.choice==='required'||c.selected))throw Error('UFO 未按要求选择工具');if(!allowEmpty&&typeof data.content!=='string')throw Error('UFO 未返回回复');return {content:typeof data.content==='string'?data.content:null,selected,rawCalls:[]};}
 return {content:null,selected,rawCalls:Array.isArray(data.tool_calls)?data.tool_calls:[]};
}
function narrow(o,names){const c=validate(o);const filtered=c.tools.filter(t=>names.includes(t.function.name));if(c.legacy){return {...o,functions:filtered.map(t=>t.function)};}return {...o,tools:filtered};}
function parseResult(text,o){const c=validate(o);if(!c.mode)return {content:text,tool_calls:[]};let raw=text.trim();if(raw.startsWith('```'))raw=raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let data;try{data=JSON.parse(raw)}catch{if(c.mode==='tools'&&c.choice==='auto'&&!c.selected&&o.response_format?.type!=='json_object'&&!raw.startsWith('{')&&!raw.startsWith('['))return {content:text,tool_calls:[]};throw Error('UFO 未返回有效的结构化响应');}
 if(c.mode==='json'){if(!data||Array.isArray(data)||typeof data!=='object')throw Error('UFO 未返回 JSON 对象');return {content:JSON.stringify(data),tool_calls:[]};}
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('UFO 工具调用响应格式无效');
 if(data.tool_calls===undefined&&typeof data.content==='string')data.tool_calls=[];
 if(!Array.isArray(data.tool_calls))throw Error('UFO 工具调用响应格式无效');
 if(!c.parallel&&data.tool_calls.length>1)throw Error('UFO 返回了不允许的并行工具调用');
 if(data.tool_calls.length>128)throw Error('UFO 返回了过多工具调用');
 const calls=data.tool_calls.map(call=>{const name=call?.name??call?.function?.name;let args=call?.arguments??call?.function?.arguments;if(!c.tools.some(t=>t.function.name===name)||c.selected&&name!==c.selected)throw Error('UFO 返回了未提供的工具');if(typeof args==='string'){try{args=JSON.parse(args)}catch{throw Error('工具参数不是有效 JSON')}}if(!args||typeof args!=='object'||Array.isArray(args))throw Error('工具参数必须是 JSON 对象');return{id:'call_'+crypto.randomBytes(12).toString('hex'),type:'function',function:{name,arguments:JSON.stringify(args)}}});
 if((c.choice==='required'||c.selected)&&!calls.length)throw Error('UFO 未按要求调用工具');if(!calls.length&&typeof data.content!=='string')throw Error('UFO 未返回文本或工具调用');if(!calls.length&&o.response_format?.type==='json_object'){try{const v=JSON.parse(data.content);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();}catch{throw Error('UFO 未返回 JSON 对象');}}return {content:calls.length?null:data.content,tool_calls:calls};
}
module.exports={validate,prompt,parseResult,catalogPrompt,catalogPrompts,fastCatalogPlan,parseCatalog,narrow};
