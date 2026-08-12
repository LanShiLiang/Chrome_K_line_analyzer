import type{Candle}from'../model/types';

export type WebSocketMarketUpdate={adapterId:'tradingview-ws'|'binance-ws';channel:string;siteId:string;symbol?:string;period?:string;candles:Candle[];confidence:number};

const number=(value:unknown)=>{const parsed=typeof value==='number'?value:Number(value);return Number.isFinite(parsed)?parsed:undefined};
const candle=(values:unknown[]):Candle|undefined=>{
  for(const offset of [0,1]){
    if(values.length-offset<6)continue;
    const [time,open,high,low,close,volume]=values.slice(offset,offset+6).map(number);
    if(time===undefined||open===undefined||high===undefined||low===undefined||close===undefined||volume===undefined)continue;
    if(high<Math.max(open,close)||low>Math.min(open,close)||volume<0)continue;
    return{timestamp:time<1e12?time*1000:time,open,high,low,close,volume};
  }
};

export function decodeTradingViewMessages(frame:string):unknown[]{
  const messages:unknown[]=[];
  const pattern=/~m~(\d+)~m~/g;
  let match:RegExpExecArray|null;
  while((match=pattern.exec(frame))){
    const start=pattern.lastIndex;
    const text=frame.slice(start,start+Number(match[1]));
    pattern.lastIndex=start+Number(match[1]);
    if(text.startsWith('~h~'))continue;
    try{const parsed=JSON.parse(text);if(typeof parsed!=='string'||!parsed.startsWith('~h~'))messages.push(parsed)}catch{/* Ignore heartbeat and incomplete frames. */}
  }
  if(messages.length===0&&frame.trim().startsWith('{'))try{messages.push(JSON.parse(frame))}catch{/* Non-JSON frame. */}
  return messages;
}

function tradingViewSeries(value:unknown,path:string,updates:WebSocketMarketUpdate[]){
  if(!value||typeof value!=='object')return;
  const record=value as Record<string,unknown>;
  if(Array.isArray(record.s)){
    const candles=record.s.map(item=>item&&typeof item==='object'&&Array.isArray((item as Record<string,unknown>).v)?candle((item as Record<string,unknown>).v as unknown[]):undefined).filter((item):item is Candle=>Boolean(item));
    if(candles.length)updates.push({adapterId:'tradingview-ws',channel:path,siteId:'tradingview',candles,confidence:95});
  }
  for(const[key,child]of Object.entries(record))tradingViewSeries(child,path?`${path}.${key}`:key,updates);
}

export function parseTradingViewFrame(frame:string):WebSocketMarketUpdate[]{
  const updates:WebSocketMarketUpdate[]=[];
  for(const message of decodeTradingViewMessages(frame)){
    if(!message||typeof message!=='object')continue;
    const envelope=message as{m?:string;p?:unknown[]};
    if(envelope.m!=='timescale_update'&&envelope.m!=='du')continue;
    tradingViewSeries(envelope.p?.[1],String(envelope.p?.[0]??envelope.m),updates);
  }
  return updates;
}

export function parseBinanceFrame(frame:string):WebSocketMarketUpdate[]{
  let parsed:unknown;
  try{parsed=JSON.parse(frame)}catch{return[]}
  const envelope=parsed as{stream?:unknown;data?:unknown;e?:unknown;k?:unknown;s?:unknown};
  const data=(envelope.data??envelope)as{e?:unknown;k?:unknown;s?:unknown};
  if(data.e!=='kline'||!data.k||typeof data.k!=='object')return[];
  const k=data.k as Record<string,unknown>;
  const parsedCandle=candle([k.t,k.o,k.h,k.l,k.c,k.v]);
  if(!parsedCandle)return[];
  const symbol=String(k.s??data.s??'');
  const period=String(k.i??'');
  return[{adapterId:'binance-ws',channel:String(envelope.stream??`${symbol.toLowerCase()}@kline_${period}`),siteId:'binance',symbol:symbol||undefined,period:period||undefined,candles:[parsedCandle],confidence:100}];
}

export function parseWebSocketFrame(host:string,frame:string):WebSocketMarketUpdate[]{
  if(host.includes('tradingview.com'))return parseTradingViewFrame(frame);
  if(host.includes('binance.'))return parseBinanceFrame(frame);
  return[...parseBinanceFrame(frame),...parseTradingViewFrame(frame)];
}
