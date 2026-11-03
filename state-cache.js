'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const accounts=require('./accounts');const {HOME}=accounts;const FILE=path.join(HOME,'state-cache.json');
let state;function read(){if(state)return state;try{const value=JSON.parse(fs.readFileSync(FILE,'utf8'));state=value&&value.version===1&&value.accounts&&typeof value.accounts==='object'?value:{version:1,accounts:{}};}catch(e){if(e.code!=='ENOENT')throw e;state={version:1,accounts:{}};}return state;}
function fingerprint(a){return crypto.createHash('sha256').update(a.workspace+'\0'+a.token).digest('hex');}
function get(a,kind){const item=read().accounts[a.id];return item&&item.fingerprint===fingerprint(a)?item[kind]||null:null;}
function put(a,kind,value){if(!a.id)return;const currentAccount=accounts.read().accounts.find(x=>x.id===a.id);if(!currentAccount||fingerprint(currentAccount)!==fingerprint(a))return;const db=read(),fp=fingerprint(a),old=db.accounts[a.id];const current=old&&old.fingerprint===fp?old:{fingerprint:fp};db.accounts[a.id]={...current,[kind]:value};fs.mkdirSync(HOME,{recursive:true,mode:0o700});const tmp=path.join(HOME,'.state-'+crypto.randomUUID());try{fs.writeFileSync(tmp,JSON.stringify(db)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,FILE)}finally{try{fs.unlinkSync(tmp)}catch{}}}
function remove(id){const db=read();if(!db.accounts[id])return;delete db.accounts[id];fs.mkdirSync(HOME,{recursive:true,mode:0o700});const tmp=path.join(HOME,'.state-'+crypto.randomUUID());try{fs.writeFileSync(tmp,JSON.stringify(db)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,FILE)}finally{try{fs.unlinkSync(tmp)}catch{}}}
module.exports={get,put,remove,fingerprint};
