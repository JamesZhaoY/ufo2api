'use strict';
const crypto=require('node:crypto');
const compat=require('./compat');
const {attachments}=require('./message-content');
const sessions=new Map(),locks=new Map();
const TTL=60*60*1000,LIMIT=128;
function stable(value){
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])]));
 return value;
}
function hash(value){return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');}
function messageHash(message){
 const m={...message};
 const normalizeFunction=f=>{if(!f)return f;try{return {...f,arguments:JSON.stringify(stable(JSON.parse(f.arguments)))};}catch{return f;}};
 if(Array.isArray(m.tool_calls)&&!m.tool_calls.length)delete m.tool_calls;
 if(m.tool_calls)m.tool_calls=m.tool_calls.map(call=>({...call,function:normalizeFunction(call.function)}));
 if(m.function_call)m.function_call=normalizeFunction(m.function_call);
 if(m.role==='assistant'&&(m.tool_calls||m.function_call)&&m.content==null)m.content='';
 return hash(m);
}
async function acquire(key,signal){
 signal?.throwIfAborted();
 const previous=locks.get(key)||Promise.resolve();let unlock;
 const gate=new Promise(resolve=>{unlock=resolve;});
 const queued=previous.then(()=>gate);locks.set(key,queued);
 let released=false;
 const release=()=>{if(released)return;released=true;unlock();queued.then(()=>{if(locks.get(key)===queued)locks.delete(key);});};
 let abort;
 try{
  await Promise.race([previous,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});})]);
  signal?.throwIfAborted();return release;
 }catch(e){release();throw e;}finally{signal?.removeEventListener('abort',abort);}
}
async function begin({account,body,conversationKey,signal,onUsage=()=>{}}){
 const mode=compat.validate(body);
 const key=hash([account.workspace,account.token,account.proxy,body.model,conversationKey,mode,body.response_format]);
 const enabled=!!conversationKey&&process.env.UFO_WEB_SESSION_CACHE!=='0';
 const release=enabled?await acquire(key,signal):()=>{};
 try{
  const now=Date.now();for(const [id,s] of sessions)if(s.expires<=now)sessions.delete(id);
  const hashes=body.messages.map(messageHash),old=enabled?sessions.get(key):null;
  // A branch, repeated request or edited history must never append to the wrong remote state.
  const reused=!!old&&hashes.length>old.hashes.length&&old.hashes.every((h,i)=>hashes[i]===h);
  if(enabled)sessions.delete(key);
  let messages=body.messages;
  if(reused){
   let start=old.hashes.length;
   // The adapter assigned IDs after UFO generated its previous tool request.
   // Synchronize those IDs once before sending the corresponding client results.
   const previous=body.messages[start-1];
   if(previous?.role==='assistant'&&(previous.tool_calls?.length||previous.function_call))start--;
   messages=body.messages.slice(start);
  }
  const prompt=reused?'Continue this existing client conversation using the previously supplied instructions and function definitions. The messages below append to that history. If the first entry is an assistant tool call, it only synchronizes client-assigned call IDs for your preceding response; do not execute or repeat it.\n'+compat.prompt(messages,body,{omitTools:true}):compat.prompt(messages,body);
  let conversationId=reused?old.conversationId:null;
  const files=attachments(messages),fileBytes=items=>items.reduce((n,f)=>n+f.bytes.length,0);
  return {prompt,reused,messages,catalogSession:reused&&!!old.catalogSession,sentBytes:Buffer.byteLength(prompt)+fileBytes(files),fullBytes:Buffer.byteLength(compat.prompt(body.messages,body))+fileBytes(attachments(body.messages)),
   transport:{attachments:files,conversationId,onAccepted:value=>{conversationId=value.conversation_id;},onUsage},
   commit(message,{catalogSession=false}={}){
    if(!enabled||signal?.aborted||!conversationId||hashes.length>=2048)return;
    if(sessions.size>=LIMIT)sessions.delete(sessions.keys().next().value);
    sessions.set(key,{conversationId,catalogSession,hashes:[...hashes,messageHash(message)],expires:Date.now()+TTL});
   },release};
 }catch(e){release();throw e;}
}
module.exports={begin};
