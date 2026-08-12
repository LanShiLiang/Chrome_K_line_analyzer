import type { RawMarketPayload } from '../core/model/types';

const CHANNEL='KLA_MARKET_RESPONSE';
const emit=(payload:RawMarketPayload)=>window.postMessage({channel:CHANNEL,payload},window.location.origin);
const safeRaw=(value:unknown)=>{
  if(typeof value==='string'&&value.length>200_000)return value.slice(0,200_000);
  return value;
};

const originalFetch=window.fetch.bind(window);
window.fetch=async(...args)=>{
  const requestAt=Date.now();
  const response=await originalFetch(...args);
  try{
    const clone=response.clone();
    const contentType=clone.headers.get('content-type')??'';
    const raw=contentType.includes('json')?await clone.json():safeRaw(await clone.text());
    emit({id:crypto.randomUUID(),url:typeof args[0]==='string'?args[0]:args[0] instanceof URL?args[0].href:args[0].url,method:(args[1]?.method??'GET').toUpperCase() as 'GET'|'POST',status:clone.status,contentType,requestAt,responseAt:Date.now(),source:'fetch',raw,confidence:0});
  }catch{/* Response may be opaque or non-cloneable; never affect the host page. */}
  return response;
};

const originalOpen=XMLHttpRequest.prototype.open;
const originalSend=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(method:string|undefined,url:string|URL,...rest:unknown[]){
  Object.assign(this,{__klaMeta:{method:(method??'GET').toUpperCase(),url:String(url),requestAt:Date.now()}});
  return Reflect.apply(originalOpen,this,[method??'GET',url,...rest]);
};
XMLHttpRequest.prototype.send=function(body?:Document|XMLHttpRequestBodyInit|null){
  this.addEventListener('load',()=>{
    try{
      const meta=(this as XMLHttpRequest&{__klaMeta?:{method:string;url:string;requestAt:number}}).__klaMeta;
      if(!meta)return;
      const raw=this.responseType===''||this.responseType==='text'?safeRaw(this.responseText):this.response;
      emit({id:crypto.randomUUID(),url:meta.url,method:(meta.method==='POST'?'POST':'GET'),status:this.status,contentType:this.getResponseHeader('content-type')??undefined,requestAt:meta.requestAt,responseAt:Date.now(),source:'xhr',raw,confidence:0});
    }catch{/* Host page behavior takes priority. */}
  });
  return originalSend.call(this,body);
};
