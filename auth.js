'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const HOME=require('./accounts').HOME,FILE=path.join(HOME,'api-key');
function valid(value){if(typeof value!=='string'||value.length<1||value.length>256||!/^[\x21-\x7e]+$/.test(value))throw Error('API Key 必须为 1–256 个非空白 ASCII 字符');return value;}
function localKey(){fs.mkdirSync(HOME,{recursive:true,mode:0o700});try{const v=fs.readFileSync(FILE,'utf8').trim();return valid(v)}catch(e){if(e.code!=='ENOENT')throw e;const v='sk-ufo-'+crypto.randomBytes(24).toString('base64url');try{fs.writeFileSync(FILE,v+'\n',{mode:0o600,flag:'wx'});return v}catch(err){if(err.code==='EEXIST')return valid(fs.readFileSync(FILE,'utf8').trim());throw err}}}
function key(){return process.env.UFO_PROXY_API_KEY||localKey();}
function set(value){valid(value);if(process.env.UFO_PROXY_API_KEY)throw Error('API Key 由环境变量控制，请修改 UFO_PROXY_API_KEY 后重启');fs.mkdirSync(HOME,{recursive:true,mode:0o700});const tmp=path.join(HOME,'.key-'+crypto.randomUUID());try{fs.writeFileSync(tmp,value+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,FILE)}finally{try{fs.unlinkSync(tmp)}catch{}}}
module.exports={key,set,valid};
