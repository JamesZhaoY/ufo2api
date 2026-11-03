'use strict';
const crypto=require('node:crypto');
const ATTACHMENTS=Symbol('attachments');
const MAX_IMAGE=10*1024*1024,MAX_TOTAL=20*1024*1024;
function invalid(index,detail){const e=Error(`messages[${index}].content：${detail}`);e.code='unsupported_message_content';e.param=`messages[${index}].content`;return e;}
function imagePart(part,index){
 let mime,data;
 if(part.type==='image_url'){
  const url=typeof part.image_url==='string'?part.image_url:part.image_url?.url;
  if(typeof url!=='string'||!url.startsWith('data:'))throw invalid(index,'图片请使用 base64 data URL，暂不支持远程图片地址');
  const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
  if(!match)throw invalid(index,'无效的图片 data URL');[,mime,data]=match;
 }else if(part.type==='image'){
  mime=part.mimeType??part.source?.media_type;data=part.data??(part.source?.type==='base64'?part.source.data:undefined);
 }
 if(!['image/png','image/jpeg','image/webp','image/gif'].includes(mime)||typeof data!=='string')throw invalid(index,'图片须为 PNG、JPEG、WebP 或 GIF 的 base64 数据');
 data=data.replace(/[\r\n]/g,'');
 if(data.length>Math.ceil(MAX_IMAGE/3)*4)throw invalid(index,'单张图片不能超过 10 MB');
 if(!data.length||data.length%4===1||!(/^[A-Za-z0-9+/]+={0,2}$/).test(data))throw invalid(index,'图片 base64 数据无效');
 const bytes=Buffer.from(data,'base64');
 if(bytes.toString('base64').replace(/=+$/,'')!==data.replace(/=+$/,''))throw invalid(index,'图片 base64 数据无效');
 const magic=mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:mime==='image/gif'?/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()):bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
 if(!magic||bytes.length>MAX_IMAGE)throw invalid(index,'图片内容与声明格式不符或超过 10 MB');
 const digest=crypto.createHash('sha256').update(bytes).digest('hex'),ext=mime.split('/')[1];
 return {name:`image-${digest}.${ext}`,mime,bytes};
}
function normalize(messages){
 let total=0,count=0;
 for(const [index,m] of messages.entries()){
  if(typeof m.content==='string'||m.role==='assistant'&&m.content==null&&(m.tool_calls||m.function_call))continue;
  if(!Array.isArray(m.content))throw invalid(index,'仅支持文本、文本块数组和图片内容块');
  const files=[];
  m.content=m.content.map(part=>{
   if(part?.type==='text'&&typeof part.text==='string')return part.text;
   if(part?.type==='image_url'||part?.type==='image'){
    const file=imagePart(part,index);total+=file.bytes.length;count++;
    if(total>MAX_TOTAL||count>32)throw invalid(index,'单次请求最多 32 张图片，图片总大小不能超过 20 MB');
    files.push(file);return `\n[Attached image: ${file.name}]\n`;
   }
   throw invalid(index,'不支持的内容块；请使用 text、image_url 或 image');
  }).join('');
  if(files.length)Object.defineProperty(m,ATTACHMENTS,{value:files});
 }
}
function attachments(messages){return [...new Map(messages.flatMap(m=>m[ATTACHMENTS]||[]).map(f=>[f.name,f])).values()];}
module.exports={normalize,attachments};
