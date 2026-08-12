import{parseWebSocketFrame,type WebSocketMarketUpdate}from'../core/adapter/websocket';
import type{Candle,RawMarketPayload}from'../core/model/types';

const CHANNEL='KLA_MARKET_RESPONSE';
const NativeWebSocket=window.WebSocket;
const streams=new Map<string,{candles:Map<number,Candle>;update:WebSocketMarketUpdate;url:string;openedAt:number}>();

const emit=(payload:RawMarketPayload)=>window.postMessage({channel:CHANNEL,payload},window.location.origin);
const merge=(update:WebSocketMarketUpdate,url:string,openedAt:number)=>{
  const key=`${update.adapterId}:${update.channel}`;
  const stream=streams.get(key)??{candles:new Map<number,Candle>(),update,url,openedAt};
  stream.update=update;
  for(const item of update.candles)stream.candles.set(item.timestamp,item);
  while(stream.candles.size>2000)stream.candles.delete(stream.candles.keys().next().value!);
  streams.set(key,stream);
  emit({id:key,siteId:update.siteId,symbol:update.symbol,period:update.period,url,method:'WS',status:101,contentType:'application/websocket',requestAt:openedAt,responseAt:Date.now(),source:'websocket',raw:[...stream.candles.values()].sort((a,b)=>a.timestamp-b.timestamp),confidence:update.confidence});
};
const consume=async(data:unknown,url:string,openedAt:number)=>{
  let text:string|undefined;
  if(typeof data==='string')text=data;
  else if(data instanceof Blob)text=await data.text();
  else if(data instanceof ArrayBuffer)text=new TextDecoder().decode(data);
  if(!text)return;
  for(const update of parseWebSocketFrame(location.hostname,text))merge(update,url,openedAt);
};

window.WebSocket=new Proxy(NativeWebSocket,{
  construct(Target,args){
    const openedAt=Date.now();
    const socket=Reflect.construct(Target,args)as WebSocket;
    socket.addEventListener('message',event=>{void consume(event.data,socket.url||String(args[0]),openedAt)});
    return socket;
  }
});
