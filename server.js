'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const accounts = require('./accounts');
const login = require('./login');
const pool = require('./pool');
const activity = require('./activity');
const compat = require('./compat');
const contextCompact = require('./context-compact');
const webUpstream = require('./web-upstream');
const webSessions = require('./web-sessions');
const messageContent = require('./message-content');
const apiFormats = require('./api-formats');
const fastTools = require('./fast-tools');
const {CatalogTextStream,ToolTextStream}=require('./catalog-stream');
const {ToolCallStream}=require('./tool-call-stream');
const auth = require('./auth');
const stateCache = require('./state-cache');
const dashboardAuth = require('./dashboard-auth');
const mailboxes = require('./mailboxes');
const mailboxJobsModule = require('./mailbox-jobs');

const ROOT = __dirname;
const HOME = process.env.UFO_HOME || path.join(ROOT, '.ufo');
const HOST = process.env.UFO_PROXY_HOST || '127.0.0.1';
const PORT = Number(process.env.UFO_PROXY_PORT || 8787);
const KEY = process.env.UFO_PROXY_API_KEY || '';
const TIMEOUT = Number(process.env.UFO_TIMEOUT || 600) * 1000;
const MODEL = 'ufo';
function trace(event){
 const line=JSON.stringify({at:new Date().toISOString(),...event})+'\n';
 console.log(line.trimEnd());
 try{fs.mkdirSync(HOME,{recursive:true,mode:0o700});const file=path.join(HOME,'request-trace.log');if(fs.existsSync(file)&&fs.statSync(file).size>1024*1024)fs.writeFileSync(file,'',{mode:0o600});fs.appendFileSync(file,line,{mode:0o600});}catch(e){console.error('调用阶段日志写入失败:',e.code);}
}

const modelInflight = new Map(), pendingLogins = new Map();
let PUBLIC=null;
if(process.env.UFO_PUBLIC_ORIGIN){PUBLIC=new URL(process.env.UFO_PUBLIC_ORIGIN);if(!['http:','https:'].includes(PUBLIC.protocol)||PUBLIC.username||PUBLIC.password||PUBLIC.pathname!=='/'||PUBLIC.search||PUBLIC.hash)throw Error('UFO_PUBLIC_ORIGIN 必须是 HTTP(S) origin');}
function allowedUi(req,requireOrigin=false){const host=(req.headers.host||'').toLowerCase(),local=[`localhost:${PORT}`,`127.0.0.1:${PORT}`,`[::1]:${PORT}`];const allowed=new Set([...local,...(PUBLIC?[PUBLIC.host.toLowerCase()]:[])]);if(!allowed.has(host))return false;const origin=req.headers.origin;if(requireOrigin&&!origin)return false;if(origin){const acceptable=new Set(local.map(h=>'http://'+h));if(PUBLIC)acceptable.add(PUBLIC.origin);try{if(!acceptable.has(origin)||new URL(origin).host.toLowerCase()!==host)return false;}catch{return false;}}return true;}
function secureCookie(req){return !!PUBLIC&&PUBLIC.protocol==='https:'&&(req.headers.host||'').toLowerCase()===PUBLIC.host.toLowerCase();}

function json(res, status, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':b.length}); res.end(b); }
function fail(res, status, msg, type='invalid_request_error',code=null,param=null) { json(res,status,apiFormats.errorBody(res.apiFormat,status,msg,type,code,param)); }
function authorized(req) {
 const value=req.headers.authorization || (req.url?.split('?')[0]==='/v1/messages'&&typeof req.headers['x-api-key']==='string'?'Bearer '+req.headers['x-api-key']:'');
 const a=Buffer.from(value); const b=Buffer.from('Bearer '+auth.key());
 return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function readConfig() {
 if (process.env.UFO_TOKEN && process.env.UFO_WORKSPACE_URL) return {token:process.env.UFO_TOKEN,workspace:process.env.UFO_WORKSPACE_URL,proxy:''};
 return accounts.active();
}
async function getModels(account, refresh=false) {
 const key=account.id || account.workspace, fingerprint=stateCache.fingerprint(account);
 const cached=stateCache.get(account,'models');
 const flightKey=key+':'+fingerprint;
 if(!refresh){if(cached&&Array.isArray(cached.values))return cached.values;if(modelInflight.has(flightKey))return modelInflight.get(flightKey);throw Error('模型列表尚未加载，请在模型目录手动刷新');}
 if(modelInflight.has(flightKey))return modelInflight.get(flightKey);
 const pending=(async()=>{try{const response=await fetch(account.workspace+'/surface/web/api/agents',{headers:{cookie:'ufo_session='+account.token,accept:'application/json'},...accounts.options(account.proxy),signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('模型列表查询失败 (HTTP '+response.status+')');const obj=await response.json();if(!Array.isArray(obj.models)||!obj.models.every(x=>typeof x==='string'))throw Error('UFO 模型列表格式异常');const values=[...new Set(obj.models)];stateCache.put(account,'models',{values,updatedAt:Date.now()});return values;}catch(e){if(!cached)stateCache.put(account,'models',{values:null,updatedAt:null,error:'初次加载失败，请手动刷新'});throw e;}})();
 modelInflight.set(flightKey,pending);try{return await pending;}finally{if(modelInflight.get(flightKey)===pending)modelInflight.delete(flightKey);}
}
async function refreshAccount(account){return Promise.allSettled([getModels(account,true),pool.quota(account,true)]);}
const mailboxJobs=mailboxJobsModule.create({refresh:refreshAccount});
const quotaRefresh=require('./quota-refresh').create({accounts:ids=>accounts.subset(ids),quota:(a,signal)=>pool.quota(a,true,signal)});
async function warmMissing(){const all=accounts.read().accounts;for(let i=0;i<all.length;i+=8)await Promise.all(all.slice(i,i+8).map(a=>{const jobs=[];if(!stateCache.get(a,'models'))jobs.push(getModels(a,true));if(!stateCache.get(a,'quota'))jobs.push(pool.quota(a,true));return Promise.allSettled(jobs)}));}
async function upstream(messages, onText, signal, account=readConfig(), model=MODEL, request={}, promptOverride=null, webOptions={}) {
 const {token,workspace:origin,proxy}=account;
 const channel=crypto.randomBytes(16).toString('hex');
 const prompt=promptOverride??compat.prompt(messages,request);
 if(process.env.UFO_TRANSPORT==='web')return webUpstream.upstream(prompt,onText,signal,account,model,webOptions);
 if(Buffer.byteLength(prompt)>compat.MAX_PROMPT_BYTES)throw compat.inputTooLarge(messages,Buffer.byteLength(prompt));
 const response=await fetch(`${origin}/surface/ufo/${channel}`,{method:'POST',headers:{
  'authorization':`Bearer ${token}`,'content-type':'text/plain','accept-encoding':'identity',
  'x-ufo-session':`Author.local.${crypto.randomUUID()}`,'x-ufo-tty':'0','x-ufo-installed':'0',
  'x-ufo-script':'0.1.95','x-ufo-timezone':Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC','x-ufo-internet':'off',
  ...(model !== MODEL && model !== 'auto' ? {'x-ufo-model':model}: {})
 },body:prompt,signal,...accounts.options(proxy)});
 if (!response.ok) {if(response.status===413)throw compat.inputTooLarge(messages,Buffer.byteLength(prompt));throw Error(`UFO returned HTTP ${response.status}`);}
 if (!response.body) throw Error('UFO returned no response stream');
 const decoder=new TextDecoder(); let pending='', text='', terminal=false, escapeTail='';
 const emitText=(raw, final=false)=>{
  let value=escapeTail+raw; escapeTail='';
  if(!final){let n=0;while(n<value.length&&value[value.length-1-n]==='\\')n++;if(n%2===1){escapeTail='\\';value=value.slice(0,-1);}}
  value=value.replace(/\\([nrt\\"])/g,(_,c)=>({'n':'\n','r':'\r','t':'\t','\\':'\\','"':'"'}[c]));
  if(value) {text+=value;onText(value);}
 };
 const processLine=(line)=>{
  const [tag,kind,...parts]=line.replace(/\r$/,'').split('\t');
  if (tag !== 'frame') return;
  let data;const raw=parts.join('\t');try{data=JSON.parse(raw)}catch{
   // UFO sometimes double-escapes quotes within frame text, yielding invalid JSON.
   const repaired=raw.replace(/(\\+)(?=")/g,slashes=>slashes.length%2===0?slashes+'\\':slashes);
   try{data=JSON.parse(repaired)}catch{throw Error('Invalid UFO event')}
  }
  if (kind==='message' && typeof data.text==='string') { emitText(data.text); }
  if (kind==='terminal') {
   terminal=true; emitText('',true);
   if (data.status!=='done' || data.error_class || data.incomplete_reason || data.question || data.credential_request || data.connect_request){const e=Error(data.error_class==='ModelRefusal'?'UFO 模型拒绝了该请求':'UFO request did not complete successfully');if(data.error_class==='ModelRefusal')e.code='UFO_MODEL_REFUSAL';throw e;}
   if (!text && typeof data.text==='string' && data.text) { emitText(data.text,true); }
  }
 };
 for await (const chunk of response.body) {
  pending+=decoder.decode(chunk,{stream:true});
  if (pending.length>4*1024*1024) throw Error('UFO event exceeded the size limit');
  let idx; while ((idx=pending.indexOf('\n'))!==-1) { const line=pending.slice(0,idx);pending=pending.slice(idx+1);processLine(line); }
 }
 pending+=decoder.decode(); if (pending) processLine(pending);
 if (!terminal || !text) throw Error('UFO did not return a complete text response');
 return text;
}
function parseRequest(body) {
 let o; try{o=typeof body==='string'?JSON.parse(body):body;}catch{throw Error('Invalid JSON.');}
 if (!o || Array.isArray(o) || typeof o!=='object') throw Error('Request body must be an object.');
 if (typeof o.model!=='string' || !o.model || o.model.length>200 || /[\r\n]/.test(o.model)) throw Error('Invalid model.');
 if (!Array.isArray(o.messages)||!o.messages.length) throw Error('messages must be a non-empty list.');
 for (const m of o.messages) {
  if(!m || !['system','developer','user','assistant','tool','function'].includes(m.role))throw Error('无效的消息角色');
  if(m.role==='tool' && (typeof m.tool_call_id!=='string'||!m.tool_call_id))throw Error('tool 消息缺少 tool_call_id');
 }
 messageContent.normalize(o.messages);
 compat.validate(o);
 if (o.n!==undefined && o.n!==1) throw Error('Only n=1 is supported.');
 if (o.stream!==undefined && typeof o.stream!=='boolean') throw Error('stream must be a boolean.');
 return o;
}
async function management(req,res) {
 if(!allowedUi(req,req.method!=='GET'))return fail(res,403,'来源不匹配或地址未配置。');
 if(!dashboardAuth.valid(req))return fail(res,401,'请先登录控制台。','authentication_error');
 if(req.method!=='GET'&&req.headers['x-ufo-ui']!=='1')return fail(res,403,'无效的管理请求。');
 if(req.method==='GET' && req.url==='/api/accounts')return json(res,200,accounts.list());
 if(req.method==='GET' && req.url==='/api/mailboxes')return json(res,200,{mailboxes:mailboxes.list()});
 if(req.method==='GET' && req.url==='/api/mailboxes/jobs')return json(res,200,{jobs:mailboxJobs.list(),concurrency:pool.settings().registration_concurrency,batchLimit:pool.settings().registration_batch_limit});
 if(req.method==='GET' && req.url==='/api/activity')return json(res,200,{calls:activity.recent()});
 if(req.method==='GET' && req.url==='/api/settings'){res.setHeader('Cache-Control','no-store');return json(res,200,{...pool.settings(),apiKey:auth.key(),apiKeySource:KEY?'environment':'local'});}
 if(req.method==='GET' && req.url==='/api/quotas/refresh-status')return json(res,200,{refresh:quotaRefresh.status(),accounts:await pool.quotaList(false)});
 if(req.method==='GET' && req.url==='/api/quotas')return json(res,200,{accounts:await pool.quotaList(false)});
 if(req.method==='GET' && req.url==='/api/models'){
  try{const a=readConfig();const models=await getModels(a,false);return json(res,200,{models,accountId:a.id,updatedAt:stateCache.get(a,'models')?.updatedAt||null});}catch(e){return fail(res,502,e.message,'api_error');}
 }
 if(req.method!=='POST')return fail(res,404,'Not found.');
 let raw='',bytes=0;const dec=new StringDecoder('utf8');
 try{
  for await(const part of req){bytes+=part.length;if(bytes>(['/api/accounts/import','/api/mailboxes/import','/api/accounts/export','/api/quotas/refresh'].includes(req.url)?2097152:16384))return fail(res,413,'请求过大。');raw+=dec.write(part);}raw+=dec.end();
  const data=JSON.parse(raw||'{}');
  if(req.url==='/api/quotas/refresh'){if(data.background===true)return json(res,200,{refresh:quotaRefresh.start(data.ids)});return json(res,200,{accounts:await pool.quotaList(true,data.ids)});}
  if(req.url==='/api/models/refresh'){const a=readConfig(),models=await getModels(a,true);return json(res,200,{models,accountId:a.id,updatedAt:stateCache.get(a,'models')?.updatedAt||null});}
  if(req.url==='/api/settings'){if(data.apiKey!==undefined){auth.valid(data.apiKey);if(KEY&&data.apiKey!==KEY)throw Error('API Key 由环境变量控制，请修改环境变量后重启');}const saved=pool.saveSettings(data);mailboxJobs.reconfigure();if(data.apiKey!==undefined&&!KEY&&data.apiKey!==auth.key())auth.set(data.apiKey);return json(res,200,{...saved,apiKey:auth.key(),apiKeySource:KEY?'environment':'local'});}
  if(req.url==='/api/mailboxes/import'){if(data.replace&&mailboxes.list().some(x=>mailboxJobs.busy(x.id)))throw Error('邮箱注册任务进行中，请完成后替换凭据');return json(res,200,mailboxes.importEntries(data.entries,{replace:data.replace===true}));}
  if(req.url==='/api/mailboxes/register')return json(res,200,{jobs:mailboxJobs.start(data.ids)});
  if(req.url==='/api/mailboxes/delete'){if(mailboxJobs.busy(data.id))throw Error('该邮箱正在注册，暂不能移除');mailboxes.remove(data.id);return json(res,200,{mailboxes:mailboxes.list()});}
  if(req.url==='/api/accounts/export'){res.setHeader('Cache-Control','no-store');return json(res,200,accounts.exportAccounts(data.ids));}
  if(req.url==='/api/accounts/import'){const result=accounts.importAccounts(data);if(result.imported)void warmMissing().catch(e=>console.error('导入后加载失败:',e.message));return json(res,200,result);}
  if(req.url==='/api/accounts/select'){accounts.select(data.id);return json(res,200,accounts.list());}
  if(req.url==='/api/accounts/proxy'){accounts.setProxy(data.id,data.proxy||'');return json(res,200,accounts.list());}
  if(req.url==='/api/accounts/delete'){accounts.remove(data.id);stateCache.remove(data.id);return json(res,200,accounts.list());}
  if(req.url==='/api/login/start'){
   const email=String(data.email||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw Error('请输入有效邮箱');
   const proxy=accounts.proxyUrl(data.proxy||''), session=`Author.local.${crypto.randomUUID()}`;
   const send=(url,opts)=>fetch(url,{...opts,...accounts.options(proxy)});
   const start=await login.post('',session,send);if(!start.some(e=>e.type==='ask'))throw Error('UFO 登录响应异常');
   const next=await login.post(email,session,send);if(!next.some(e=>e.type==='ask'))throw Error('UFO 未请求验证码');
   for(const [k,v] of pendingLogins)if(Date.now()>v.expires)pendingLogins.delete(k);
   const id=crypto.randomUUID();pendingLogins.set(id,{email,proxy,session,expires:Date.now()+10*60*1000});
   return json(res,200,{loginId:id});
  }
  if(req.url==='/api/login/complete'){
   const p=pendingLogins.get(data.loginId);if(!p || Date.now()>p.expires){pendingLogins.delete(data.loginId);throw Error('登录会话已过期，请重新获取验证码');}
   const code=String(data.code||'').trim();if(!/^[0-9]{6,10}$/.test(code))throw Error('验证码格式无效');
   const send=(url,opts)=>fetch(url,{...opts,...accounts.options(p.proxy)});
   const {token,workspace}=login.parseLogin(await login.post(code,p.session,send));
   const a=accounts.saveAccount({email:p.email,token,workspace,proxy:p.proxy});pendingLogins.delete(data.loginId);await refreshAccount(a);
   return json(res,200,accounts.list());
  }
  return fail(res,404,'Not found.');
 }catch(e){console.error('Management error:',e.message);return fail(res,400,e.message);}
}
const server=http.createServer(async(req,res)=>{
 const apiPath=req.url.split('?')[0];
 res.apiFormat=apiPath==='/v1/messages'?'messages':apiPath==='/v1/responses'?'responses':null;
 if(req.url==='/auth/login' && req.method==='POST'){
  if(!allowedUi(req,true)||req.headers['x-ufo-ui']!=='1')return fail(res,403,'来源不匹配。');
  let b='',size=0;try{for await(const chunk of req){size+=chunk.length;if(size>4096)return fail(res,413,'请求过大。');b+=chunk.toString('utf8');}const input=JSON.parse(b);const result=dashboardAuth.authenticate(input.password,req.socket.remoteAddress);if(result.error)return fail(res,result.status,result.error,'authentication_error');res.setHeader('Set-Cookie',dashboardAuth.cookieHeader(result.token,secureCookie(req)));res.setHeader('Cache-Control','no-store');return json(res,200,{ok:true});}catch{return fail(res,400,'登录请求无效。');}
 }
 if(req.url==='/auth/logout' && req.method==='POST'){
  if(!allowedUi(req,true)||req.headers['x-ufo-ui']!=='1')return fail(res,403,'来源不匹配。');dashboardAuth.revoke(req);res.setHeader('Set-Cookie',dashboardAuth.clearCookie(secureCookie(req)));res.setHeader('Cache-Control','no-store');return json(res,200,{ok:true});
 }
 if ((req.url==='/'||req.url==='/login') && req.method==='GET') {
  if(!allowedUi(req))return fail(res,403,'地址未配置。');
  if(req.url==='/'&&!dashboardAuth.valid(req)){res.writeHead(302,{Location:'/login','Cache-Control':'no-store'});return res.end();}
  if(req.url==='/login'&&dashboardAuth.valid(req)){res.writeHead(302,{Location:'/','Cache-Control':'no-store'});return res.end();}
  const page=fs.readFileSync(path.join(ROOT,'public',req.url==='/'?'index.html':'signin.html'));res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':page.length,'content-security-policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'x-content-type-options':'nosniff','cache-control':'no-store'});return res.end(page);
 }
 if(req.method==='GET'&&req.url==='/fonts/noto-sans-sc-ui.woff'){const b=fs.readFileSync(path.join(ROOT,'public/fonts/noto-sans-sc-ui.woff'));res.writeHead(200,{'content-type':'font/woff','content-length':b.length,'cache-control':'public, max-age=86400'});return res.end(b);}
 if (req.method==='GET' && ['/app.js','/account-view.js','/mailbox-view.js','/style.css','/signin.js','/signin.css'].includes(req.url)) {const b=fs.readFileSync(path.join(ROOT,'public',req.url.slice(1)));res.writeHead(200,{'content-type':req.url.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','content-length':b.length,'x-content-type-options':'nosniff'});return res.end(b);}
 if(req.url.startsWith('/api/'))return management(req,res);
 if (!authorized(req)) { req.resume(); return fail(res,401,'Invalid API key.','authentication_error'); }
 if (req.method==='GET' && req.url==='/v1/models') {
  try {const a=readConfig(), names=await getModels(a);return json(res,200,{object:'list',data:[MODEL,...names.filter(x=>x!==MODEL)].map(id=>({id,object:'model',created:0,owned_by:'ufo'}))});}
  catch(e){return fail(res,502,e.message,'api_error');}
 }
 if(req.method==='GET' && req.url.startsWith('/v1/models/')) {
  try {const model=decodeURIComponent(req.url.slice('/v1/models/'.length));const names=await getModels(readConfig());if(model!==MODEL && !names.includes(model))return fail(res,404,'模型不存在。');return json(res,200,{id:model,object:'model',created:0,owned_by:'ufo'});}catch(e){return fail(res,502,e.message,'api_error');}
 }

 if (req.method!=='POST'||!['/v1/chat/completions','/v1/responses','/v1/messages'].includes(apiPath)) {req.resume();return fail(res,404,'Not found.');}
 const requestTrace=crypto.randomUUID();const started=Date.now();let callModel=null,callAccount=null,callAccountName=null,recorded=false;const timings={routingMs:null,quotaMs:null,modelCheckMs:null,catalogMs:null,catalogPages:0,generationMs:null,firstOutputMs:null,toolCount:0};
 const saveCall=(outcome)=>{if(recorded)return;recorded=true;trace({event:'request_finished',request:requestTrace,outcome,status:res.headersSent?res.statusCode:null,durationMs:Date.now()-started,toolDefinitions:timings.toolCount,toolResultsReceived:timings.toolResultsReceived??0,toolCallsReturned:timings.toolCallsReturned??0,finishReason:timings.finishReason??null,compactionMs:timings.compactionMs??null});activity.record({at:new Date().toISOString(),model:callModel,accountId:callAccount,accountName:callAccountName,outcome,httpStatus:res.headersSent?res.statusCode:null,durationMs:Date.now()-started,timings});};
 res.on('finish',()=>saveCall(res.statusCode>=200&&res.statusCode<300?'success':'failed'));
 res.on('close',()=>{if(!res.writableFinished)saveCall('interrupted')});
 let data='', size=0; const bodyDecoder=new StringDecoder('utf8');
 try {
   for await (const part of req) {size+=part.length;if(size>32*1024*1024) {fail(res,413,'请求体不能超过 32 MB。');return;}data+=bodyDecoder.write(part);}
  data+=bodyDecoder.end();
  const decoded=res.apiFormat?apiFormats.decode(data,res.apiFormat,crypto.createHash('sha256').update(auth.key()).digest('hex')):null;
  const body=parseRequest(decoded?decoded.body:data),mode=compat.validate(body),conversationKey=pool.conversationKey(body,req.headers['x-conversation-id']);
  const formatReply=res.apiFormat?apiFormats.reply(res.apiFormat,res,body,decoded.context):null;
  timings.apiFormat=res.apiFormat||'chat';callModel=body.model;timings.toolCount=mode.tools.length;timings.toolResultsReceived=body.messages.filter(m=>m.role==='tool'||m.role==='function').length;trace({event:'request_started',request:requestTrace,apiFormat:timings.apiFormat,toolDefinitions:timings.toolCount,toolResultsReceived:timings.toolResultsReceived,stream:body.stream===true});let account;const routeStarted=Date.now();
  if(process.env.UFO_TRANSPORT!=='web'&&messageContent.attachments(body.messages).length){const e=Error('图片输入需要启用 UFO 网页通道（UFO_TRANSPORT=web）');e.code='unsupported_message_content';e.param='messages';throw e;}
  if(process.env.UFO_TOKEN && process.env.UFO_WORKSPACE_URL){account=readConfig();}
  else {
   const all=accounts.read().accounts;if(!all.length)return fail(res,503,'请先添加 UFO 账号。','api_error');
   const candidates=[], modelChecks=new Map();
   for(let i=0;i<all.length;i+=8){const batch=all.slice(i,i+8);const jobs=batch.map(a=>{
    const quotaStarted=Date.now(), modelStarted=Date.now();
    const quotaTask=pool.quota(a).finally(()=>{timings.quotaMs=Math.max(timings.quotaMs||0,Date.now()-quotaStarted)});
    if(body.model!==MODEL && body.model!=='auto')modelChecks.set(a.id,getModels(a).then(names=>({supported:names.includes(body.model),elapsed:Date.now()-modelStarted}),()=>({supported:false,elapsed:Date.now()-modelStarted})));
    return quotaTask.then(q=>({account:a,quota:q}));
   });candidates.push(...await Promise.all(jobs));}
   try{const opts=pool.settings();const key=conversationKey;account=await pool.chooseSupported(candidates,opts,key,async a=>{const task=modelChecks.get(a.id);if(!task)return true;const checked=await task;timings.modelCheckMs=checked.elapsed;return checked.supported;});}catch(e){return fail(res,e.code==='UFO_INSUFFICIENT_QUOTA'?402:503,e.message,e.code==='UFO_INSUFFICIENT_QUOTA'?'insufficient_quota':'api_error');}
  }
  timings.routingMs=Date.now()-routeStarted;callAccount=account.id||null;callAccountName=account.name||null;
  const id='chatcmpl-'+crypto.randomUUID().replaceAll('-',''), created=Math.floor(Date.now()/1000);
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),TIMEOUT);
  res.on('close',()=>{if(!res.writableFinished)controller.abort();});
  const frame=(delta,finish_reason=null)=>({id,object:'chat.completion.chunk',created,model:body.model,choices:[{index:0,delta,finish_reason}]});
  let sent=false,catalogStreamed='',toolStreamed='';
  const emitDelta=delta=>{if(formatReply){if(!sent){timings.firstOutputMs=Date.now()-started;sent=true;}formatReply.delta(delta);return;}if(!sent){timings.firstOutputMs=Date.now()-started;res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.write('data: '+JSON.stringify(frame({role:'assistant'}))+'\n\n');sent=true;}res.write('data: '+JSON.stringify(frame(delta))+'\n\n');};
  const emitContent=part=>emitDelta({content:part});
  let webSession=null,completedMessage=null,callStream=null,catalogUsed=false;
  try {
   timings.transport=process.env.UFO_TRANSPORT==='web'?'web':'cli';
   if(timings.transport==='cli'&&process.env.UFO_CONTEXT_COMPACT==='1'&&Buffer.byteLength(JSON.stringify(body.messages))>16000){
    const compactStarted=Date.now();
    timings.stage='compaction';timings.contextBytesBefore=Buffer.byteLength(JSON.stringify(body.messages));
    let summary;try{summary=await contextCompact.compact(body.messages,{scope:[account.workspace,account.token,account.proxy,body.model],signal:controller.signal,onProgress:p=>{timings.summaryCalls=p.calls;timings.summaryCompleted=p.completed;timings.summaryCacheHits=p.cacheHits;trace({event:'compaction_progress',request:requestTrace,...p});},summarize:(prompt,signal)=>upstream([],()=>{},signal,account,body.model,{},prompt)});}finally{timings.compactionMs=Date.now()-compactStarted;}
    body.messages=summary.messages;
    timings.compactionMs=Date.now()-compactStarted;timings.contextBytesBefore=summary.before;timings.contextBytesAfter=summary.after;
    res.setHeader('X-UFO-Context-Compacted',String(summary.compressed));
   }
   if(timings.transport==='web'){
    webSession=await webSessions.begin({account,body,conversationKey,signal:controller.signal,onUsage:u=>{if(Number.isFinite(u.tokens))timings.upstreamTokens=u.tokens;if(Number.isFinite(u.costMicroUsd))timings.upstreamCostMicroUsd=u.costMicroUsd;if(Number.isFinite(u.cachePercent))timings.upstreamCachePercent=u.cachePercent;}});
    const session=webSession;session.transport.onTiming=(key,ms)=>{timings[key]=ms;};res.once('finish',()=>{if(res.statusCode>=200&&res.statusCode<300&&completedMessage&&!catalogUsed)session.commit(completedMessage);session.release();});res.once('close',()=>session.release());
    controller.signal.throwIfAborted();
    res.setHeader('X-UFO-Session-Reused',String(session.reused));res.setHeader('X-UFO-Input-Bytes',String(session.sentBytes));
    timings.attachmentCount=session.transport.attachments.length;timings.sessionReused=session.reused;timings.upstreamInputBytes=session.sentBytes;timings.fullInputBytes=session.fullBytes;
    trace({event:'web_context',request:requestTrace,reused:session.reused,sentBytes:session.sentBytes,fullBytes:session.fullBytes,attachments:session.transport.attachments.length});
   }
   timings.stage=timings.transport==='web'?'request_preparation':'tool_selection';trace({event:'stage',request:requestTrace,stage:timings.stage});let request=body, result;
   const oversizedWebTools=timings.transport==='web'&&mode.mode==='tools'&&Buffer.byteLength(webSession.prompt)>180000;
   if(mode.mode==='tools' && ((timings.transport==='cli'&&Buffer.byteLength(compat.prompt(body.messages,body))>39000)||oversizedWebTools)){
    catalogUsed=oversizedWebTools;
    if(mode.selected){request=compat.narrow(body,[mode.selected]);}
    else{const pages=compat.fastCatalogPlan(body.messages,body,oversizedWebTools?{maxBytes:180000}:undefined), picks=[];timings.catalogPages=pages.length;const catalogStarted=Date.now();const canStream=body.stream&&pages.length<=3&&mode.choice==='auto'&&!mode.selected&&body.response_format?.type!=='json_object';let allReady=false,pendingText='';const readyFlags=pages.map(()=>false);const maybeEmit=()=>{if(!allReady&&readyFlags.every(Boolean)){allReady=true;if(pendingText){catalogStreamed+=pendingText;emitContent(pendingText);pendingText='';}}};const decoders=canStream?pages.map((_,i)=>new CatalogTextStream(part=>{if(i!==0)return;if(!allReady)pendingText+=part;else{catalogStreamed+=part;emitContent(part);}},()=>{readyFlags[i]=true;maybeEmit();})):[];for(let i=0;i<pages.length;i+=3){const slice=pages.slice(i,i+3);const batch=await Promise.all(slice.map((p,j)=>upstream(body.messages,x=>decoders[i+j]?.push(x),controller.signal,account,body.model,body,p.prompt,oversizedWebTools?{attachments:messageContent.attachments(body.messages)}:{})));picks.push(...batch.map((x,j)=>({...compat.parseCatalog(x,body,{allowEmpty:true}),ready:slice[j].ready})));}
     timings.catalogMs=Date.now()-catalogStarted;
     const selected=[...new Set(picks.flatMap(x=>x.selected))];if(selected.length>8)throw Error('UFO 选择了过多工具，请缩小请求范围');
     if(selected.length){if(catalogStreamed)throw Error('UFO 工具选择结果与已输出文本不一致');const calls=picks.flatMap(x=>x.rawCalls),ready=picks.flatMap(x=>x.ready);if(fastTools.validCalls(calls,selected,ready,mode.tools,mode.parallel)){result=JSON.stringify({content:null,tool_calls:calls});timings.fastToolCalls=true;}else request=compat.narrow(body,selected);}else{if(mode.choice==='required')throw Error('UFO 未按要求选择工具');const answer=picks.find(x=>typeof x.content==='string')?.content;if(answer===undefined)throw Error('UFO 未返回回复');if(catalogStreamed&&!answer.startsWith(catalogStreamed))throw Error('UFO 回复与已输出文本不一致');result=JSON.stringify({content:answer,tool_calls:[]});}}

   }
   if(result===undefined){timings.stage='generation';trace({event:'stage',request:requestTrace,stage:timings.stage});const generationStarted=Date.now();if(body.stream&&mode.mode==='tools'&&!mode.legacy)callStream=new ToolCallStream(delta=>{timings.toolStreamed=true;emitDelta({tool_calls:[delta]});},{tools:mode.tools,selected:mode.selected});const canStreamToolText=body.stream&&mode.mode==='tools'&&mode.choice==='auto'&&!mode.selected&&body.response_format?.type!=='json_object';const toolDecoder=canStreamToolText?new ToolTextStream(part=>{toolStreamed+=part;emitContent(part)}):null;try{result=await upstream(body.messages, part=>{
    if (!body.stream) return;
    if(mode.mode){toolDecoder?.push(part);callStream?.push(part);return;}
    emitContent(part);
   },controller.signal,account,body.model,request,catalogUsed?compat.prompt(body.messages,request):(webSession?.prompt??null),catalogUsed?{attachments:messageContent.attachments(body.messages)}:(webSession?.transport??{}));}finally{timings.generationMs=Date.now()-generationStarted;}}
   timings.stage='response_validation';const parsed=compat.parseResult(result,request);
   if(toolStreamed&&(parsed.tool_calls.length||typeof parsed.content!=='string'||!parsed.content.startsWith(toolStreamed)))throw Error('UFO 回复与已输出文本不一致');
   callStream?.verify(parsed.tool_calls);if(callStream?.started)parsed.tool_calls[0].id=callStream.id;
   const calls=parsed.tool_calls, legacy=mode.legacy&&calls.length>0;
   const message={role:'assistant',content:parsed.content};
   if(calls.length){if(legacy)message.function_call=calls[0].function;else message.tool_calls=calls;}
   completedMessage=message;
   const finish=calls.length?(legacy?'function_call':'tool_calls'):'stop';timings.toolCallsReturned=calls.length;timings.finishReason=finish;
   if (body.stream) {
    if(callStream?.started){emitDelta({tool_calls:[{index:0,function:{arguments:callStream.argumentsStarted?'}':calls[0].function.arguments}}]});if(calls.length>1)emitDelta({tool_calls:calls.slice(1).map((call,index)=>({index:index+1,...call}))});}
    if(catalogStreamed&&parsed.content?.length>catalogStreamed.length)emitContent(parsed.content.slice(catalogStreamed.length));
    if(toolStreamed&&parsed.content?.length>toolStreamed.length)emitContent(parsed.content.slice(toolStreamed.length));
    if(formatReply){if(!sent)emitDelta(calls.length?{tool_calls:calls.map((x,i)=>({index:i,...x}))}:{content:parsed.content});formatReply.finish(message);return;}
    if(!sent){timings.firstOutputMs=Date.now()-started;res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.write('data: '+JSON.stringify(frame({role:'assistant'}))+'\n\n');sent=true;
     const delta=calls.length?(legacy?{function_call:calls[0].function}:{tool_calls:calls.map((x,i)=>({index:i,...x}))}):{content:parsed.content};res.write('data: '+JSON.stringify(frame(delta))+'\n\n');}
    res.write('data: '+JSON.stringify(frame({},finish))+'\n\ndata: [DONE]\n\n');res.end();
   } else {timings.firstOutputMs=Date.now()-started;if(formatReply)formatReply.finish(message);else json(res,200,{id,object:'chat.completion',created,model:body.model,choices:[{index:0,message,finish_reason:finish}],usage:null});}
  } catch(e) {
   controller.abort();
   if(e.code==='UFO_INSUFFICIENT_QUOTA'&&account.id){pool.freeze(account);timings.accountFrozen=true;trace({event:'account_frozen',request:requestTrace,reason:'insufficient_quota'});}
   console.error('UFO request failed:',e.message);
   if (!res.headersSent) fail(res,e.code==='UFO_INSUFFICIENT_QUOTA'?402:e.code==='UFO_PARKED'?422:e.code==='UFO_CONTEXT_TIMEOUT'?504:e.code==='UFO_INPUT_TOO_LARGE'?413:e.code==='UFO_MODEL_REFUSAL'?422:502,'UFO request failed: '+(e.name==='AbortError'?'timeout or disconnected':e.message),e.code==='UFO_INSUFFICIENT_QUOTA'?'insufficient_quota':['UFO_MODEL_REFUSAL','UFO_INPUT_TOO_LARGE','UFO_PARKED'].includes(e.code)?'invalid_request_error':'api_error');
   else res.destroy();
  } finally {clearTimeout(timer);if(res.destroyed)webSession?.release();}
 } catch(e) {trace({event:'request_rejected',request:requestTrace,code:e.code??null,param:e.param??null});if(!res.headersSent)fail(res,e.status||400,e.message,'invalid_request_error',e.code??null,e.param??null);else res.destroy();}
});
if (require.main===module){dashboardAuth.password();auth.key();server.listen(PORT,HOST,()=>{console.log(`UFO adapter listening at http://${HOST}:${PORT}/v1`);warmMissing().catch(e=>console.error('初次加载账号状态失败:',e.message));});}
module.exports={server,upstream,parseRequest};
