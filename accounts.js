'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {ProxyAgent}=require('undici');
const ROOT=__dirname, HOME=process.env.UFO_HOME || path.join(ROOT,'.ufo'), FILE=path.join(HOME,'accounts.json');
let agents=new Map();
function initDir(){fs.mkdirSync(HOME,{recursive:true,mode:0o700});fs.chmodSync(HOME,0o700);}
function origin(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('工作区地址必须为 HTTPS 域名');return u.origin;}
function proxyUrl(value){if(!value)return '';let u;try{u=new URL(value);}catch{throw Error('代理地址格式无效');}if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.pathname!=='/'||u.search||u.hash)throw Error('代理地址仅支持 http:// 或 https://，不支持路径');return u.href;}
function write(data){initDir();const t=path.join(HOME,'.accounts-'+crypto.randomUUID());try{fs.writeFileSync(t,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(t,FILE);}finally{try{fs.unlinkSync(t)}catch{}}}
function read(){initDir();if(!fs.existsSync(FILE)) {let data={version:1,activeId:null,accounts:[]};try{const token=fs.readFileSync(path.join(HOME,'credentials'),'utf8').trim(), workspace=origin(fs.readFileSync(path.join(HOME,'workspace'),'utf8').trim());if(token){let name='已有账号';try{const claims=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString());if(typeof claims.email==='string' && claims.email.includes('@'))name=claims.email;}catch{}let a={id:crypto.randomUUID(),name,token,workspace,proxy:''};data.activeId=a.id;data.accounts.push(a);}}catch(e){if(e.code!=='ENOENT')throw e;}write(data);return data;}const data=JSON.parse(fs.readFileSync(FILE,'utf8'));if(!Array.isArray(data.accounts))throw Error('账号配置文件格式错误');return data;}
function saveAccount({email,token,workspace,proxy,activate=true}){let db=read(), name=String(email||'').trim();if(!name||!token||/[\r\n]/.test(token))throw Error('账号或凭据无效');const existing=db.accounts.find(a=>a.name.toLowerCase()===name.toLowerCase()&&a.workspace===workspace);const a={id:existing?.id||crypto.randomUUID(),name,token,workspace:origin(workspace),proxy:proxyUrl(proxy)};if(existing)db.accounts[db.accounts.indexOf(existing)]=a;else db.accounts.push(a);if(activate||!db.activeId)db.activeId=a.id;write(db);return a;}
function active(){const db=read();const a=db.accounts.find(a=>a.id===db.activeId);if(!a)throw Error('请先登录并选择 UFO 账号');return a;}
function list(){const db=read();return {activeId:db.activeId,accounts:db.accounts.map(({id,name,workspace,proxy})=>{let display='';if(proxy){const u=new URL(proxy);display=u.protocol+'//'+u.host;}return{id,name,workspace,proxy:display,hasProxy:!!proxy};})};}
function select(id){const db=read();if(!db.accounts.some(a=>a.id===id))throw Error('账号不存在');db.activeId=id;write(db);}
function setProxy(id,proxy){const db=read(),a=db.accounts.find(a=>a.id===id);if(!a)throw Error('账号不存在');a.proxy=proxyUrl(proxy);write(db);}
function remove(id){const db=read(),i=db.accounts.findIndex(a=>a.id===id);if(i<0)throw Error('账号不存在');db.accounts.splice(i,1);if(db.activeId===id)db.activeId=db.accounts[0]?.id||null;write(db);}
function exportAccounts(){const db=read();return {format:'ufo-accounts',version:1,accounts:db.accounts.map(({name,token,workspace,proxy})=>({name,token,workspace,proxy:proxy||''}))};}
function importAccounts(input){
 if(!input || input.format!=='ufo-accounts' || input.version!==1 || !Array.isArray(input.accounts) || input.accounts.length===0 || input.accounts.length>500)throw Error('无效的 UFO 账号备份，须包含 1–500 个账号');
 const valid=input.accounts.map((item,index)=>{
  if(!item || typeof item!=='object' || Array.isArray(item))throw Error(`第 ${index+1} 条账号格式无效`);
  const {name,token,workspace,proxy=''}=item;
  if(typeof name!=='string' || !name.trim() || name.length>254 || /[\r\n]/.test(name))throw Error(`第 ${index+1} 条账号名称无效`);
  if(typeof token!=='string' || !token.trim() || token.length>8192 || /[\r\n]/.test(token))throw Error(`第 ${index+1} 条账号凭据无效`);
  if(typeof workspace!=='string' || typeof proxy!=='string')throw Error(`第 ${index+1} 条地址无效`);
  try{return {name:name.trim(),token:token.trim(),workspace:origin(workspace),proxy:proxyUrl(proxy)}}catch{throw Error(`第 ${index+1} 条工作区或代理地址无效`)}
 });
 const db=read(), known=new Set(db.accounts.map(a=>a.name.toLowerCase()+'\0'+a.workspace));let imported=0,skipped=0;
 for(const a of valid){const key=a.name.toLowerCase()+'\0'+a.workspace;if(known.has(key)){skipped++;continue;}known.add(key);const record={id:crypto.randomUUID(),...a};db.accounts.push(record);if(!db.activeId)db.activeId=record.id;imported++;}
 if(imported)write(db);return {imported,skipped,...list()};
}
function dispatcher(proxy){if(!proxy)return undefined;proxy=proxyUrl(proxy);if(!agents.has(proxy))agents.set(proxy,new ProxyAgent(proxy));return agents.get(proxy);}
function options(proxy){const d=dispatcher(proxy);return d?{dispatcher:d}:{};}
module.exports={HOME,read,list,active,select,setProxy,remove,saveAccount,proxyUrl,options,exportAccounts,importAccounts};
