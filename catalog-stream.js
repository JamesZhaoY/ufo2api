'use strict';
// Emits text only after the JSON prefix explicitly says no tools were selected.
class CatalogTextStream {
 constructor(emit){this.emit=emit;this.buffer='';this.offset=null;this.emitted='';this.disabled=false;this.closed=false;}
 push(chunk){if(this.disabled||this.closed)return;this.buffer+=chunk;if(this.offset===null){const match=/^\s*\{\s*"selected_tools"\s*:\s*\[\s*\]\s*,\s*"tool_calls"\s*:\s*\[\s*\]\s*,\s*"content"\s*:\s*"/.exec(this.buffer);if(!match){if(this.buffer.length>2048)this.disabled=true;return;}this.offset=match[0].length;}
  let end=this.offset,closed=false;while(end<this.buffer.length){const ch=this.buffer[end];if(ch==='"'){closed=true;break;}if(ch==='\\'){if(end+1>=this.buffer.length)break;const next=this.buffer[end+1];if(next==='u'){if(end+6>this.buffer.length)break;if(!/^[0-9a-fA-F]{4}$/.test(this.buffer.slice(end+2,end+6))){this.disabled=true;return;}end+=6;continue;}if(!'"\\/bfnrt'.includes(next)){this.disabled=true;return;}end+=2;continue;}if(ch.charCodeAt(0)<32){this.disabled=true;return;}end++;}
  let text;try{text=JSON.parse('"'+this.buffer.slice(this.offset,end)+'"')}catch{this.disabled=true;return;}if(!closed&&text.length&&/[\uD800-\uDBFF]/.test(text[text.length-1]))text=text.slice(0,-1);if(!text.startsWith(this.emitted)){this.disabled=true;return;}const delta=text.slice(this.emitted.length);if(delta){this.emitted=text;this.emit(delta);}if(closed)this.closed=true;
 }
}
module.exports={CatalogTextStream};
