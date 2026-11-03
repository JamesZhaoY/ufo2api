'use strict';
const crypto=require('node:crypto');
// One shared refresh per server. Slow accounts do not hold up a whole batch.
function create({accounts,quota,concurrency=16,timeoutMs=20000}){
 let current=null,currentScope=null;
 function status(){return current?{...current}:null;}
 function start(ids){const list=accounts(ids),scope=JSON.stringify(list.map(a=>a.id??a).sort());if(current?.status==='running'){if(scope!==currentScope)throw Error('已有其他范围的额度刷新正在进行，请完成后重试');return status();}currentScope=scope;const job=current={id:crypto.randomUUID(),status:'running',total:list.length,completed:0,failed:0,startedAt:Date.now(),finishedAt:null};let next=0;
  async function worker(){while(next<list.length){const account=list[next++];try{const q=await quota(account,AbortSignal.timeout(timeoutMs));if(q.status==='unknown'||q.refreshError)job.failed++;}catch{job.failed++;}finally{job.completed++;}}}
  void Promise.all(Array.from({length:Math.min(concurrency,list.length)},worker)).then(()=>{job.status='done';job.finishedAt=Date.now();}).catch(()=>{job.status='failed';job.finishedAt=Date.now();});return status();
 }
 return {start,status};
}
module.exports={create};
