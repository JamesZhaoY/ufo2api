'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const accounts=require('./accounts');
const stateCache=require('./state-cache');
const SETTINGS=path.join(accounts.HOME,'settings.json');
const defaults={strategy:'round_robin',sticky:true,sticky_minutes:60,registration_concurrency:2,registration_batch_limit:50,proxy_sources:['http://104.234.174.66:7778/api/proxies'],registration_proxies:[]};
const strategies=new Set(['quota','random','round_robin']);
const quotaInflight=new Map(),stickyMap=new Map(),sessionLocks=new Map();let cursor=0;
function settings(){if(!fs.existsSync(SETTINGS))return {...defaults};const x=JSON.parse(fs.readFileSync(SETTINGS,'utf8'));return normalize(x);}
function normalize(x){
 if(!x||!strategies.has(x.strategy)||typeof x.sticky!=='boolean'||!Number.isInteger(x.sticky_minutes)||x.sticky_minutes<1||x.sticky_minutes>1440)throw Error('无效的账号池设置');
 const batchLimit=x.registration_batch_limit??defaults.registration_batch_limit,concurrency=x.registration_concurrency??defaults.registration_concurrency,sources=x.proxy_sources??defaults.proxy_sources,proxies=x.registration_proxies??defaults.registration_proxies;
 if(!Number.isInteger(batchLimit)||batchLimit<1||batchLimit>500)throw Error('每批注册上限须为 1–500');
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>20)throw Error('注册并发数量须为 1–20');
 if(!Array.isArray(sources)||sources.length>5||sources.some(v=>typeof v!=='string'||v.length>2048))throw Error('代理池接口最多 5 个');
 const checkedSources=sources.map(v=>{let u;try{u=new URL(v)}catch{throw Error('代理池接口地址无效')}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash)throw Error('代理池接口须为 HTTP(S) 地址且不含用户名、密码或片段');return u.href});
 if(!Array.isArray(proxies)||proxies.length>100||proxies.some(v=>typeof v!=='string'||v.length>2048))throw Error('手动代理最多 100 个');
 const checkedProxies=proxies.map(v=>{const p=accounts.proxyUrl(v);if(!p)throw Error('代理地址不能为空');return p});
 if(!checkedSources.length&&!checkedProxies.length)throw Error('请至少配置一个代理池接口或手动代理');
 return {strategy:x.strategy,sticky:x.sticky,sticky_minutes:x.sticky_minutes,registration_concurrency:concurrency,registration_batch_limit:batchLimit,proxy_sources:[...new Set(checkedSources)],registration_proxies:[...new Set(checkedProxies)]};
}
function saveSettings(x){const s=normalize({...settings(),...x});fs.mkdirSync(accounts.HOME,{recursive:true,mode:0o700});const tmp=path.join(accounts.HOME,'.settings-'+crypto.randomUUID());try{fs.writeFileSync(tmp,JSON.stringify(s,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,SETTINGS);}finally{try{fs.unlinkSync(tmp)}catch{}}if(!s.sticky)stickyMap.clear();return s;}
async function quota(account,refresh=false,signal){
 const key=account.id+':'+stateCache.fingerprint(account);const saved=stateCache.get(account,'quota');if(!refresh){return saved||{status:'unknown',balance_micro_usd:null,refused_below_micro_usd:null,checkedAt:null,error:'尚未获取，请手动刷新'};}
 if(quotaInflight.has(key))return quotaInflight.get(key);
 const promise=(async()=>{let q;try{const r=await fetch(account.workspace+'/ext/metronome/billing',{headers:{cookie:'ufo_session='+account.token,accept:'application/json'},...accounts.options(account.proxy),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});if(!r.ok)throw Error('HTTP '+r.status);const b=await r.json();if(typeof b.limited!=='boolean')throw Error('额度响应格式异常');
  if(b.limited && (!Number.isFinite(b.balance_micro_usd)||!Number.isFinite(b.refused_below_micro_usd)))throw Error('额度数据不完整');
  q={status:b.limited?(b.balance_micro_usd<=b.refused_below_micro_usd?'exhausted':'available'):'no_limit',balance_micro_usd:Number.isFinite(b.balance_micro_usd)?b.balance_micro_usd:null,refused_below_micro_usd:Number.isFinite(b.refused_below_micro_usd)?b.refused_below_micro_usd:null,checkedAt:Date.now()};
 }catch(e){const reason=e.name==='TimeoutError'?'查询超时':e.message;q=saved?{...saved,refreshError:reason}:{status:'unknown',balance_micro_usd:null,refused_below_micro_usd:null,checkedAt:null,error:reason};}const latest=stateCache.get(account,'quota');if(latest?.upstreamRejectedAt&&latest.upstreamRejectedAt!==saved?.upstreamRejectedAt)q=latest;stateCache.put(account,'quota',q);return q;})().finally(()=>quotaInflight.delete(key));quotaInflight.set(key,promise);return promise;
}
function freeze(account){
 const saved=stateCache.get(account,'quota');
 stateCache.put(account,'quota',{...saved,status:'exhausted',upstreamRejectedAt:Math.max(Date.now(),(saved?.upstreamRejectedAt||0)+1)});
 for(const [key,pin] of stickyMap)if(pin.id===account.id)stickyMap.delete(key);
}
function latestCandidates(candidates){return candidates.map(c=>({...c,quota:stateCache.get(c.account,'quota')||c.quota}));}
function workspaceKey(account){try{const c=JSON.parse(Buffer.from(account.token.split('.')[0],'base64url'));return typeof c.ws==='string'&&c.ws?crypto.createHash('sha256').update(account.workspace+'\0'+c.ws).digest('hex'):null;}catch{return null;}}
async function quotaList(refresh=false,ids){const all=accounts.subset(ids);const result=[];for(let i=0;i<all.length;i+=8){const batch=await Promise.all(all.slice(i,i+8).map(async a=>({id:a.id,workspaceKey:workspaceKey(a),...await quota(a,refresh)})));result.push(...batch);}return result;}
function conversationKey(body,header){if(header){if(typeof header!=='string'||header.length>256||/[\r\n]/.test(header))throw Error('无效的 X-Conversation-ID');return 'explicit:'+header;}const first=body.messages.find(m=>m.role==='user');if(!first)return null;const leading=body.messages.slice(0,body.messages.indexOf(first)).filter(m=>m.role==='system'||m.role==='developer');return 'history:'+JSON.stringify([...leading,first]);}
function rankedQuota(q){if(q.status==='available')return q.balance_micro_usd-q.refused_below_micro_usd;return -Infinity;}
function quotaError(message){const e=Error(message);e.code='UFO_INSUFFICIENT_QUOTA';return e;}
function choose(candidates,opts,key,now=Date.now()){
 candidates=latestCandidates(candidates);
 if(!candidates.length)throw Error('没有可用的账号');
 for(const [k,v] of stickyMap)if(v.expires<=now)stickyMap.delete(k);
 const hash=key?crypto.createHash('sha256').update(key).digest('hex'):null;
 if(opts.sticky && hash && stickyMap.has(hash)){
  const pin=stickyMap.get(hash),match=candidates.find(c=>c.account.id===pin.id);
  if(!match)throw Error('粘性会话绑定的账号当前不可用，请检查额度或更换会话 ID');
  if(match.quota.status==='exhausted')stickyMap.delete(hash);
  else{pin.expires=now+opts.sticky_minutes*60000;return match.account;}
 }
 const eligible=candidates.filter(x=>x.quota.status!=='exhausted');if(!eligible.length)throw quotaError('所有账号的可用额度均已耗尽，请补充额度并刷新或添加其他账号');
 let chosen;if(opts.strategy==='quota'){const ranked=eligible.filter(x=>x.quota.status==='available');chosen=(ranked.length?ranked:eligible).reduce((best,x)=>rankedQuota(x.quota)>rankedQuota(best.quota)?x:best);}
 else if(opts.strategy==='random')chosen=eligible[crypto.randomInt(eligible.length)];
 else{chosen=eligible[cursor%eligible.length];cursor=(cursor+1)%2147483647;}
 if(opts.sticky && hash){if(stickyMap.size>=10000)stickyMap.delete(stickyMap.keys().next().value);stickyMap.set(hash,{id:chosen.account.id,expires:now+opts.sticky_minutes*60000});}
 return chosen.account;
}
async function chooseSupported(candidates,opts,key,isSupported){
 const hash=opts.sticky&&key?crypto.createHash('sha256').update(key).digest('hex'):null;
 const run=async()=>{
  const pinned=hash&&stickyMap.get(hash);const existing=!!(pinned&&pinned.expires>Date.now());let remaining=candidates.slice();
  while(remaining.length){const chosen=choose(remaining,opts,key);const supported=await isSupported(chosen);if(stateCache.get(chosen,'quota')?.status==='exhausted')continue;if(supported)return chosen;
   if(existing&&chosen.id===pinned.id)throw Error('粘性会话绑定的账号不支持该模型或模型列表不可用');
   if(hash&&stickyMap.get(hash)?.id===chosen.id)stickyMap.delete(hash);
   remaining=remaining.filter(c=>c.account.id!==chosen.id);
  }
  throw Error('没有可确认支持该模型的账号，请检查模型列表或网络。');
 };
 if(!hash)return run();
 const previous=sessionLocks.get(hash)||Promise.resolve();let release;const current=new Promise(r=>{release=r});sessionLocks.set(hash,current);
 await previous;try{return await run();}finally{release();if(sessionLocks.get(hash)===current)sessionLocks.delete(hash);}
}
module.exports={freeze,settings,saveSettings,quota,quotaList,conversationKey,choose,chooseSupported};
