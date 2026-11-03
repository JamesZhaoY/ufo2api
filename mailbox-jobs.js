'use strict';
const crypto=require('node:crypto');
const defaultProxies=require('./registration-proxies'),defaultPool=require('./pool');
const defaultMailboxes=require('./mailboxes'),defaultMicrosoft=require('./microsoft-mail'),defaultLogin=require('./login'),defaultAccounts=require('./accounts');
function create({settings=defaultPool.settings,proxies=defaultProxies,mailboxes=defaultMailboxes,microsoft=defaultMicrosoft,login=defaultLogin,accounts=defaultAccounts,refresh=async()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,timeoutMs=120000,pollMs=4000}={}){
 const jobs=new Map(),active=new Set(),queue=[];let running=0;
 function publicJob(j){return {id:j.id,mailboxId:j.mailboxId,email:j.email,status:j.status,message:j.message,createdAt:j.createdAt,finishedAt:j.finishedAt||null};}
 function list(){return [...jobs.values()].sort((a,b)=>b.createdAt-a.createdAt).map(publicJob);}
 function busy(id){return active.has(id);}
 function start(ids){if(!Array.isArray(ids)||!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw Error('请选择 1–50 个不同邮箱');const selected=ids.map(id=>mailboxes.get(id));if(selected.some(x=>active.has(x.id)))throw Error('所选邮箱已有注册任务');while(jobs.size+selected.length>200){const old=[...jobs.values()].find(j=>['done','failed','skipped'].includes(j.status));if(!old)throw Error('注册队列已满');jobs.delete(old.id);}const created=selected.map(box=>{const j={id:crypto.randomUUID(),mailboxId:box.id,email:box.email,status:'queued',message:'等待处理',createdAt:now()};jobs.set(j.id,j);active.add(box.id);queue.push(j);return j});pump();return created.map(publicJob);}
 function pump(){while(running<settings().registration_concurrency&&queue.length){const j=queue.shift();running++;void run(j).catch(()=>{j.status='failed';j.message='注册任务异常结束';j.finishedAt=now()}).finally(()=>{running--;active.delete(j.mailboxId);pump()});}}
 async function run(j){let reader,connection;const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs+140000);try{
  if(accounts.read().accounts.some(a=>a.name.toLowerCase()===j.email.toLowerCase())){j.status='skipped';j.message='账号管理中已存在该邮箱';return;}
  j.status='checking';j.message='检查邮箱授权';const box=mailboxes.get(j.mailboxId);reader=await microsoft.open({...box},{signal:abort.signal});const before=await reader.list(false),seen=new Set(before.map(x=>x.id));
  const session='Author.local.'+crypto.randomUUID();j.status='sending';j.message='选择并检查注册代理';const cfg=settings();connection=await proxies.connect(login,session,abort.signal,{sources:cfg.proxy_sources,manual:cfg.registration_proxies});let step=connection.step;j.message='请求 UFO 验证码';const sentAt=now();step=await login.post(box.email,session,connection.fetcher);if(!step.some(x=>x.type==='ask'))throw Error('UFO 未请求验证码');
  j.status='waiting';j.message='等待新验证码邮件';const deadline=sentAt+timeoutMs;let code=null,transient=0;
  while(now()<deadline&&!abort.signal.aborted){let messages;try{messages=await reader.list(true);transient=0;}catch(e){if(!e.retryable||++transient>3)throw e;await sleep(pollMs);continue;}const candidates=messages.filter(m=>!seen.has(m.id)&&m.date>=sentAt-30000&&microsoft.isUfo(m.sender,m.subject)).sort((a,b)=>b.date-a.date);for(const m of candidates){code=microsoft.findCode(`${m.subject}\n${m.text}`);if(!code&&reader.body)code=microsoft.findCode(`${m.subject}\n${await reader.body(m)}`);if(code)break;}if(code)break;await sleep(pollMs);}
  if(!code)throw Error('等待 UFO 验证邮件超时，请检查收件箱、垃圾邮件或授权');j.status='registering';j.message='提交验证码';const {token,workspace}=login.parseLogin(await login.post(code,session,connection.fetcher));if(accounts.read().accounts.some(a=>a.name.toLowerCase()===box.email.toLowerCase())){j.status='skipped';j.message='账号管理中已存在该邮箱';return;}const a=accounts.saveAccount({email:box.email,token,workspace,proxy:'',activate:false});j.status='loading';j.message='加载模型与额度';await refresh(a);j.status='done';j.message='已添加到账号管理';
 }catch(e){j.status='failed';j.message=e instanceof microsoft.MailError?e.message:(e.message?.startsWith('UFO')||e.message?.startsWith('等待')||e.message?.startsWith('代理池')?e.message:'注册失败，请检查网络和邮箱授权');}finally{clearTimeout(timer);if(reader){try{reader.close()}catch{}}if(connection){try{await connection.close()}catch{}}j.finishedAt=now();}}
 return {start,list,busy,reconfigure:pump};
}
module.exports={create};
