'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const HOME=require('./accounts').HOME,FILE=path.join(HOME,'activity.json'),LIMIT=200;
function read(){try{const data=JSON.parse(fs.readFileSync(FILE,'utf8'));return Array.isArray(data)?data.slice(-LIMIT):[];}catch(e){if(e.code==='ENOENT')return [];throw e;}}
function record(entry){try{fs.mkdirSync(HOME,{recursive:true,mode:0o700});const events=read();events.push({at:entry.at,accountId:entry.accountId||null,accountName:entry.accountName||null,model:entry.model||null,outcome:entry.outcome,httpStatus:entry.httpStatus||null,durationMs:Math.max(0,entry.durationMs),timings:entry.timings||null});const tmp=path.join(HOME,'.activity-'+crypto.randomUUID());try{fs.writeFileSync(tmp,JSON.stringify(events.slice(-LIMIT))+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,FILE);}finally{try{fs.unlinkSync(tmp)}catch{}}}catch(e){console.error('无法保存调用记录:',e.message)}}
function recent(){return read().reverse();}
module.exports={record,recent};
