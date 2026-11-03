'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const readline=require('node:readline/promises');
const HOME=process.env.UFO_HOME || path.join(__dirname,'.ufo');
const GATEWAY=process.env.UFO_GATEWAY_URL || 'https://ufo.ai';
async function post(value,session,fetcher=fetch) {
 const origin=new URL(GATEWAY);
 if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw Error('UFO_GATEWAY_URL must be an HTTPS origin');
 const r=await fetcher(`${origin.origin}/v1/onboard/onboard`,{method:'POST',headers:{'content-type':'text/plain','x-ufo-session':session,'x-ufo-tty':'1','x-ufo-installed':'1','x-ufo-script':'0.1.95','x-ufo-timezone':Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'},body:value,signal:AbortSignal.timeout(60000)});
 if(!r.ok) throw Error(`UFO login returned HTTP ${r.status}`);
 const text=await r.text(); if(text.length>65536)throw Error('Login response too large');
 return text.split(/\r?\n/).filter(Boolean).map(line=>{const i=line.indexOf('\t');return {type:i<0?line:line.slice(0,i),value:i<0?'':line.slice(i+1)};});
}
function parseLogin(events) {
 const token=events.find(e=>e.type==='token')?.value;
 const workspace=events.find(e=>e.type==='workspace')?.value;
 if(!token || !workspace || /[\r\n]/.test(token)) throw Error('Login did not return a credential and workspace. Verify the code and try again.');
 const url=new URL(workspace);
 if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw Error('Invalid UFO workspace URL');
 return {token, workspace:url.origin};
}
async function main() {
 const rl=readline.createInterface({input:process.stdin,output:process.stdout});
 const session=`Author.local.${crypto.randomUUID()}`;
 try {
  const first=await post('',session);
  if(!first.some(e=>e.type==='ask')) throw Error('Unexpected login response');
  const email=(await rl.question('UFO 邮箱: ')).trim();
  if(!email || /[\r\n]/.test(email))throw Error('Email required');
  const next=await post(email,session);
  if(!next.some(e=>e.type==='ask'))throw Error('UFO did not request a verification code');
  console.log('请查看邮箱中的 UFO 验证码。');
  const code=(await rl.question('验证码: ')).trim();
  if(!code || /[\r\n]/.test(code))throw Error('Verification code required');
  const {token,workspace}=parseLogin(await post(code,session));
  require('./accounts').saveAccount({email,token,workspace,proxy:''});
  console.log('UFO 登录成功。');
 } finally {rl.close();}
}
if(require.main===module) main().catch(e=>{console.error('登录失败:',e.message);process.exitCode=1;});
module.exports={post,parseLogin};
