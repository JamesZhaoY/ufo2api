'use strict';
const crypto=require('node:crypto');
// Stream the first unambiguous call. Keep its outer closing brace until the
// complete upstream response and every call have passed normal validation.
class ToolCallStream{
 constructor(emit,{tools,selected}){this.emit=emit;this.names=new Set(tools.map(t=>t.function.name));this.selected=selected;this.header='';this.argumentHeader='';this.argumentsStarted=false;this.bufferArguments=false;this.started=false;this.complete=false;this.disabled=false;this.depth=0;this.quoted=false;this.escaped=false;this.arguments='';this.pendingHigh='';}
 push(chunk){
  if(this.disabled||this.complete||this.bufferArguments)return;
  chunk=this.pendingHigh+chunk;this.pendingHigh='';if(/[\uD800-\uDBFF]$/.test(chunk)){this.pendingHigh=chunk.slice(-1);chunk=chunk.slice(0,-1);}
  if(!this.started){
   this.header+=chunk;
   const hint=/^\s*(?:```(?:json)?[ \t]*\r?\n\s*)?\{\s*"tool_name"\s*:\s*("(?:\\.|[^"\\])*")/.exec(this.header);
   const match=hint||/^\s*(?:```(?:json)?[ \t]*\r?\n\s*)?\{\s*"tool_calls"\s*:\s*\[\s*\{\s*"name"\s*:\s*("(?:\\.|[^"\\])*")/.exec(this.header);
   if(!match){if(this.header.length>2048){this.disabled=true;this.header='';}return;}
   this.hasHint=!!hint;try{this.name=JSON.parse(match[1]);}catch{this.disabled=true;return;}
   if(!this.names.has(this.name)||this.selected&&this.name!==this.selected){this.disabled=true;return;}
   chunk=this.header.slice(match[0].length);this.header='';this.started=true;this.id='call_'+crypto.randomBytes(12).toString('hex');
   this.emit({index:0,id:this.id,type:'function',function:{name:this.name,arguments:''}});
  }
  if(!this.argumentsStarted){
   this.argumentHeader+=chunk;const pattern=this.hasHint?/^\s*,\s*"tool_calls"\s*:\s*\[\s*\{\s*"name"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"arguments"\s*:\s*(?=\{)/:/^\s*,\s*"arguments"\s*:\s*(?=\{)/;const match=pattern.exec(this.argumentHeader);
   if(!match){if(this.argumentHeader.length>2048){this.bufferArguments=true;this.argumentHeader='';}return;}
   chunk=this.argumentHeader.slice(match[0].length);this.argumentHeader='';this.argumentsStarted=true;
  }
  let consumed=0;
  for(const ch of chunk){
   consumed+=ch.length;
   if(this.quoted){if(this.escaped)this.escaped=false;else if(ch==='\\')this.escaped=true;else if(ch==='"')this.quoted=false;}
   else if(ch==='"')this.quoted=true;
   else if(ch==='{'||ch==='[')this.depth++;
   else if(ch==='}'||ch===']'){this.depth--;if(this.depth===0){this.complete=true;break;}}
  }
  const part=chunk.slice(0,consumed);this.arguments+=part;
  const visible=this.complete?part.slice(0,-1):part;
  if(visible)this.emit({index:0,function:{arguments:visible}});
 }
 verify(calls){
  if(!this.started)return;
  let matches=false;try{matches=calls[0]?.function.name===this.name&&(!this.argumentsStarted||this.complete&&JSON.stringify(JSON.parse(this.arguments))===calls[0].function.arguments);}catch{}
  if(!matches)throw Error('UFO 工具调用结果与已输出参数不一致');
 }
}
module.exports={ToolCallStream};
