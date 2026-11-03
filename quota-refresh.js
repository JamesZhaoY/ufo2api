'use strict';
const crypto=require('node:crypto');
// One shared refresh per server. Slow accounts do not hold up a whole batch.
function create({accounts,quota,concurrency=16,timeoutMs=20000}){
 let current=null;
 function status(){return current?{...current}:null;}
 function start(){if(current?.status==='running')return status();const list=accounts();const job=current={id:crypto.randomUUID(),status:'running',total:list.length,completed:0,failed:0,startedAt:Date.now(),finishedAt:null};let next=0;
  async function worker(){while(next<list.length){const account=list[next++];try{const q=await quota(account,AbortSignal.timeout(timeoutMs));if(q.status==='unknown'||q.refreshError)job.failed++;}catch{job.failed++;}finally{job.completed++;}}}
  void Promise.all(Array.from({length:Math.min(concurrency,list.length)},worker)).then(()=>{job.status='done';job.finishedAt=Date.now();}).catch(()=>{job.status='failed';job.finishedAt=Date.now();});return status();
 }
 return {start,status};
}
module.exports={create};
