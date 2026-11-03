'use strict';
const crypto=require('node:crypto');
const accounts=require('./accounts');
const agents=new Map();
async function upstream(prompt,onText,signal,account,model='ufo',session={}){
 const base=account.workspace+'/surface/web';
 const headers={cookie:'ufo_session='+account.token,origin:account.workspace,'x-ufo-timezone':'Asia/Shanghai','x-ufo-internet':'off'};
 const options=accounts.options(account.proxy);
 const request=(url,init={})=>fetch(url,{...options,...init,headers:{...headers,...init.headers},signal:init.signal??signal});
 const key=crypto.createHash('sha256').update(JSON.stringify([account.workspace,account.token,account.proxy])).digest('hex');
 let agent=agents.get(key);
 if(!agent||agent.expires<Date.now()){
  const response=await request(base+'/api/agents');if(!response.ok)throw Error('UFO 网页助手查询失败 (HTTP '+response.status+')');
  const data=await response.json(),chat=data.agents?.find(a=>a.name==='chat'&&typeof a.id==='string');
  if(!chat)throw Error('UFO 工作区没有可用的 chat 助手');
  agent={id:chat.id,expires:Date.now()+600000};if(agents.size>=128)agents.delete(agents.keys().next().value);agents.set(key,agent);
 }
 const url=base+'/agents/'+encodeURIComponent(agent.id)+'/chat?conversation='+encodeURIComponent(session.conversationId||'new');
 const response=await request(url,{method:'POST',headers:{'content-type':'text/plain; charset=utf-8',...(!['ufo','auto'].includes(model)?{'x-ufo-model':model}:{})},body:prompt});
 if(!response.ok){const e=Error('UFO 网页请求失败 (HTTP '+response.status+')');if(response.status===413)e.code='UFO_INPUT_TOO_LARGE';throw e;}
 const accepted=await response.json();if(typeof accepted.turn_id!=='string'||typeof accepted.conversation_id!=='string')throw Error('UFO 网页返回了无效的会话标识');
 session.onAccepted?.(accepted);
 let terminal=false,text='';
 try{
  const stream=await request(base+'/turns/'+encodeURIComponent(accepted.turn_id)+'/stream');
  if(!stream.ok||!stream.body)throw Error('UFO 网页响应流不可用 (HTTP '+stream.status+')');
  const decoder=new TextDecoder();let pending='',event='message',data=[];
  const dispatch=()=>{
   const kind=event,raw=data.join('\n');event='message';data=[];
   if(!raw||!['message','terminal','parked'].includes(kind))return;
   let value;try{value=JSON.parse(raw);}catch{throw Error('UFO 网页响应事件格式无效');}
   if(kind==='message'&&typeof value.text==='string'){text+=value.text;onText(value.text);}
   if(kind==='parked'){
    const reason=typeof value.message==='string'?value.message.slice(0,800):'上游未提供原因';
    const exhausted=/\bout of credit\b|\binsufficient credits?\b/i.test(reason);
    const e=Error(exhausted?'UFO 工作区额度已耗尽，该账号已冻结。请重试以选择其他可用账号；补充额度后刷新可恢复该账号。':'UFO 网页请求已暂停：'+reason);
    e.code=exhausted?'UFO_INSUFFICIENT_QUOTA':'UFO_PARKED';throw e;
   }
   if(kind==='terminal'){
    terminal=true;
    if(value.status!=='done'||value.error_class||value.incomplete_reason||value.question||value.credential_request||value.connect_request){const e=Error(value.error_class==='ModelRefusal'?'UFO 模型拒绝了该请求':'UFO 网页请求未成功完成');if(value.error_class==='ModelRefusal')e.code='UFO_MODEL_REFUSAL';throw e;}
    session.onUsage?.({tokens:value.tokens,costMicroUsd:value.cost_micro_usd,cachePercent:value.cache_percent});
    if(!text&&typeof value.text==='string'){text=value.text;onText(text);}
   }
  };
  const line=value=>{value=value.replace(/\r$/,'');if(!value){dispatch();return;}if(value.startsWith('event:'))event=value.slice(6).trimStart();if(value.startsWith('data:'))data.push(value.slice(5).replace(/^ /,''));};
  for await(const chunk of stream.body){
   pending+=decoder.decode(chunk,{stream:true});if(pending.length>4*1024*1024)throw Error('UFO 网页响应事件过大');
   let end;while((end=pending.indexOf('\n'))>=0){line(pending.slice(0,end));pending=pending.slice(end+1);if(terminal)break;}
   if(terminal)break;
  }
  if(!terminal){pending+=decoder.decode();if(pending)line(pending);dispatch();}
  if(!terminal||!text)throw Error('UFO 网页未返回完整回复');
  return text;
 }finally{
  if(!terminal){
   // Stopping the SSE read alone does not cancel a server-owned web turn.
   try{await request(base+'/agents/'+encodeURIComponent(agent.id)+'/chat?conversation='+encodeURIComponent(accepted.conversation_id),{method:'POST',headers:{'x-ufo-stop-turn':accepted.turn_id},signal:AbortSignal.timeout(5000)});}catch{}
  }
 }
}
module.exports={upstream};
