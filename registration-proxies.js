'use strict';
const net=require('node:net');
const crypto=require('node:crypto');
const {ProxyAgent}=require('undici');
const SOURCE='http://104.234.174.66:7778/api/proxies';
function publicIPv4(host){if(net.isIP(host)!==4)return false;const [a,b]=host.split('.').map(Number);return a!==0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127);}
function candidates(rows){if(!Array.isArray(rows))throw Error('代理池返回的数据格式无效');const seen=new Set(),out=[];for(const row of rows.slice(0,5000)){if(!row||String(row.protocol).toLowerCase()!=='http'||row.status!=='active'||typeof row.address!=='string')continue;const match=/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(row.address.trim());if(!match||!publicIPv4(match[1])||Number(match[2])<1||Number(match[2])>65535)continue;const url=`http://${match[1]}:${Number(match[2])}`;if(!seen.has(url)){seen.add(url);out.push(url)}}return out;}
function shuffle(items){for(let i=items.length-1;i>0;i--){const j=crypto.randomInt(i+1);[items[i],items[j]]=[items[j],items[i]];}return items;}
async function connect(login,session,signal,{fetcher=fetch,makeAgent=url=>new ProxyAgent(url),shuffle:order=shuffle,sources=[SOURCE],manual=[]}={}){
 const lists=await Promise.all(sources.map(async source=>{try{const response=await fetcher(source,{signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),redirect:'error'});if(!response.ok)throw Error();const body=await response.text();if(body.length>2*1024*1024)throw Error();return candidates(JSON.parse(body));}catch{return null;}}));
 const urls=order([...new Set([...manual,...lists.filter(Boolean).flat()])]);if(!urls.length){if(sources.length&&lists.every(x=>x===null))throw Error('代理池读取失败，请检查代理池服务和网络');throw Error('代理池没有可用的 HTTP 节点');}
 for(const url of urls.slice(0,10)){if(signal.aborted)break;const agent=makeAgent(url);const through=(target,options)=>fetcher(target,{...options,dispatcher:agent,signal:AbortSignal.any([signal,options.signal,AbortSignal.timeout(8000)].filter(Boolean))});try{const step=await login.post('',session,through);if(!step.some(x=>x.type==='ask'))throw Error('unexpected response');return {step,fetcher:through,close:()=>agent.destroy()};}catch{await agent.destroy();}}
 throw Error('代理池节点均不可用，请稍后重试');
}
module.exports={SOURCE,candidates,connect};
