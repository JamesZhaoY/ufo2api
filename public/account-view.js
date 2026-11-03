'use strict';
(function(root){
 const collator=new Intl.Collator('zh-CN',{sensitivity:'base',numeric:true});
 function available(quota){if(!quota||!['available','exhausted'].includes(quota.status)||!Number.isFinite(quota.balance_micro_usd)||!Number.isFinite(quota.refused_below_micro_usd))return null;return Math.max(0,quota.balance_micro_usd-quota.refused_below_micro_usd);}
 function accountPage(accounts,quotas,{query='',sort='default',page=1,pageSize=10}={}){
  const term=String(query).trim().toLocaleLowerCase();const filtered=accounts.map((account,index)=>({account,index,amount:available(quotas.get(account.id))})).filter(({account})=>!term||[account.name,account.workspace,account.proxy].some(x=>String(x||'').toLocaleLowerCase().includes(term)));
  if(sort!=='default')filtered.sort((a,b)=>{let cmp=0;if(sort==='name_asc'||sort==='name_desc'){cmp=collator.compare(a.account.name,b.account.name);if(sort==='name_desc')cmp=-cmp;}else if(sort==='quota_desc'||sort==='quota_asc'){if(a.amount===null||b.amount===null)cmp=a.amount===b.amount?0:(a.amount===null?1:-1);else cmp=sort==='quota_desc'?b.amount-a.amount:a.amount-b.amount;}return cmp||a.index-b.index;});
  const size=[10,20,50].includes(Number(pageSize))?Number(pageSize):10,total=filtered.length,pageCount=Math.max(1,Math.ceil(total/size)),current=Math.min(pageCount,Math.max(1,Number.isFinite(Number(page))?Math.floor(Number(page)):1)),offset=(current-1)*size;
  return {items:filtered.slice(offset,offset+size).map(x=>x.account),total,page:current,pageCount,start:total?offset+1:0,end:Math.min(offset+size,total)};
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={accountPage,available};else root.AccountView={accountPage,available};
})(typeof globalThis!=='undefined'?globalThis:this);
