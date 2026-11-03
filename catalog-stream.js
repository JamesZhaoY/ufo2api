'use strict';
// Only stream text after the response prefix confirms that no tools were chosen.
class EmptyToolsTextStream {
 constructor(emit,{catalog=false,onReady=()=>{}}={}){this.emit=emit;this.onReady=onReady;this.catalog=catalog;this.buffer='';this.offset=null;this.cursor=0;this.pendingHigh='';this.emitted='';this.disabled=false;this.closed=false;}
 push(chunk){if(this.disabled||this.closed)return;this.buffer+=chunk;
  if(this.offset===null){const prefix=this.catalog?/^\s*(?:```(?:json)?[ \t]*\r?\n\s*)?\{\s*(?:"selected_tools"\s*:\s*\[\s*\]\s*,\s*"tool_calls"\s*:\s*\[\s*\]|"tool_calls"\s*:\s*\[\s*\]\s*,\s*"selected_tools"\s*:\s*\[\s*\])\s*,\s*"content"\s*:\s*"/i:/^\s*(?:```(?:json)?[ \t]*\r?\n\s*)?\{\s*"tool_calls"\s*:\s*\[\s*\]\s*,\s*"content"\s*:\s*"/i;const match=prefix.exec(this.buffer);if(!match){if(this.buffer.length>2048)this.disabled=true;return;}this.offset=match[0].length;this.cursor=this.offset;this.onReady();}
  let output='';const add=value=>{if(this.pendingHigh){output+=this.pendingHigh;this.pendingHigh='';}if(value&&/[\uD800-\uDBFF]/.test(value[value.length-1])){this.pendingHigh=value[value.length-1];value=value.slice(0,-1);}output+=value;};
  while(this.cursor<this.buffer.length){const ch=this.buffer[this.cursor];if(ch==='"'){this.closed=true;this.cursor++;break;}if(ch==='\\'){if(this.cursor+1>=this.buffer.length)break;const next=this.buffer[this.cursor+1];let length=2;if(next==='u'){length=6;if(this.cursor+length>this.buffer.length)break;if(!/^[0-9a-fA-F]{4}$/.test(this.buffer.slice(this.cursor+2,this.cursor+6))){this.disabled=true;break;}}else if(!'"\\/bfnrt'.includes(next)){this.disabled=true;break;}try{add(JSON.parse('"'+this.buffer.slice(this.cursor,this.cursor+length)+'"'));}catch{this.disabled=true;break;}this.cursor+=length;continue;}if(ch.charCodeAt(0)<32){this.disabled=true;break;}let end=this.cursor+1;while(end<this.buffer.length&&!['"','\\'].includes(this.buffer[end])&&this.buffer.charCodeAt(end)>=32)end++;add(this.buffer.slice(this.cursor,end));this.cursor=end;}
  if(this.closed&&this.pendingHigh){output+=this.pendingHigh;this.pendingHigh='';}if(output){this.emitted+=output;this.emit(output);}
 }
}
class CatalogTextStream extends EmptyToolsTextStream{constructor(emit,onReady){super(emit,{catalog:true,onReady});}}
class ToolTextStream extends EmptyToolsTextStream{constructor(emit){super(emit);}}
module.exports={CatalogTextStream,ToolTextStream};
