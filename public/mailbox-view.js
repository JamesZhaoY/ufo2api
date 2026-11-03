'use strict';
(function(root){
 function parseMailboxText(text){if(typeof text!=='string'||new TextEncoder().encode(text).length>2*1024*1024)throw Error('文件超过 2 MB');const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).map((line,i)=>({line,n:i+1})).filter(x=>x.line.trim());if(!lines.length||lines.length>500)throw Error('请选择 1–500 行邮箱数据');const seen=new Set();return lines.map(({line,n})=>{const m=line.trim().match(/^([^\s@]+@[^\s@]+?\.[^\s@]+?)----(.*?)----([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})----(\S+)$/i);if(!m||m[1].length>254||m[4].length>24000)throw Error(`第 ${n} 行格式无效：需要 邮箱----密码----客户端 ID----刷新令牌`);const key=m[1].toLowerCase();if(seen.has(key))throw Error(`第 ${n} 行邮箱重复`);seen.add(key);return {email:m[1],clientId:m[3].toLowerCase(),refreshToken:m[4]};});}
 if(typeof module!=='undefined'&&module.exports)module.exports={parseMailboxText};else root.MailboxView={parseMailboxText};
})(typeof globalThis!=='undefined'?globalThis:this);
