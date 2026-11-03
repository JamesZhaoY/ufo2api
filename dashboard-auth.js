'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const HOME=require('./accounts').HOME, FILE=path.join(HOME,'admin-password');
const TTL=12*60*60*1000, sessions=new Map(), failures=new Map();
function password(){fs.mkdirSync(HOME,{recursive:true,mode:0o700});try{const v=fs.readFileSync(FILE,'utf8').trim();if(!v)throw Error('控制台密码文件为空');return v;}catch(e){if(e.code!=='ENOENT')throw e;const value=crypto.randomBytes(16).toString('hex');try{fs.writeFileSync(FILE,value+'\n',{mode:0o600,flag:'wx'});return value}catch(err){if(err.code==='EEXIST')return fs.readFileSync(FILE,'utf8').trim();throw err;}}}
function digest(s){return crypto.createHash('sha256').update(s).digest();}
function equal(a,b){return crypto.timingSafeEqual(digest(a),digest(b));}
function cookie(req){for(const part of (req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>=0&&part.slice(0,i).trim()==='ufo_admin')return part.slice(i+1).trim();}return '';}
function valid(req){const token=cookie(req);if(!/^[A-Za-z0-9_-]{43}$/.test(token))return false;const id=digest(token).toString('hex'),expiry=sessions.get(id);if(!expiry)return false;if(expiry<=Date.now()){sessions.delete(id);return false;}return true;}
function authenticate(value,address){const ip=address||'unknown',now=Date.now(),f=failures.get(ip);if(f&&f.until>now&&f.count>=5)return {error:'登录尝试过多，请稍后再试',status:429};if(typeof value!=='string'||!equal(value,password())){const entry=!f||f.until<=now?{count:0,until:now+5*60*1000}:f;entry.count++;failures.set(ip,entry);if(failures.size>1000)failures.delete(failures.keys().next().value);return {error:'密码错误',status:401};}failures.delete(ip);for(const [k,v] of sessions)if(v<=now)sessions.delete(k);if(sessions.size>=1000)sessions.delete(sessions.keys().next().value);const token=crypto.randomBytes(32).toString('base64url');sessions.set(digest(token).toString('hex'),now+TTL);return {token};}
function revoke(req){const value=cookie(req);if(value)sessions.delete(digest(value).toString('hex'));}
function cookieHeader(token,secure=false){return `ufo_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL/1000}${secure?'; Secure':''}`;}
function clearCookie(secure=false){return `ufo_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`;}
module.exports={password,valid,authenticate,revoke,cookieHeader,clearCookie};
