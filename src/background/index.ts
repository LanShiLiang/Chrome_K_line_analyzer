import { analyzeMarket } from '../core/analysis/engine';
import { createMarketData } from '../core/adapter/normalize';
import type { RawMarketPayload, SelectionRange, UserConfig } from '../core/model/types';
import { DEFAULT_CONFIG } from '../core/model/types';
import type { ExtensionMessage } from '../shared/messages';

type Session={selection?:SelectionRange;candidates:RawMarketPayload[];page?:{url:string;title:string}};
const sessions=new Map<number,Session>();
const session=(tabId:number)=>{if(!sessions.has(tabId))sessions.set(tabId,{candidates:[]});return sessions.get(tabId)!};

chrome.runtime.onMessage.addListener((message:ExtensionMessage,sender,sendResponse)=>{
  const tabId=sender.tab?.id??message.tabId;
  if(message.type==='OPEN_DRAWER'&&tabId!==undefined){chrome.tabs.sendMessage(tabId,{...message,type:'START_SELECTION'});sendResponse({ok:true});return;}
  if(tabId===undefined){sendResponse({ok:false,error:{code:'E_TAB_REQUIRED',message:'缺少 Tab 上下文',recoverable:true}});return;}
  const current=session(tabId);
  if(message.type==='PAGE_DETECTED')current.page=message.payload as Session['page'];
  if(message.type==='SELECTION_DONE')current.selection={...(message.payload as SelectionRange),tabId};
  if(message.type==='MARKET_DATA_CANDIDATES')current.candidates=message.payload as RawMarketPayload[];
  if(message.type==='GET_STATE'){sendResponse({ok:true,data:current});return;}
  if(message.type==='RUN_ANALYSIS'){
    const requested=message.payload as {candidateId?:string;config?:UserConfig};
    const candidate=current.candidates.find(c=>c.id===requested.candidateId)??current.candidates[0];
    if(!candidate){sendResponse({ok:false,error:{code:'E_MARKET_DATA_NOT_FOUND',message:'未捕获到行情数据，请刷新页面或切换周期',recoverable:true}});return;}
    const data=createMarketData(candidate.raw,candidate.url,candidate.siteId??locationHost(candidate.url),candidate.symbol,candidate.period);
    const result=analyzeMarket(data,requested.config??DEFAULT_CONFIG);
    sendResponse({ok:true,data:{marketData:data,result,selection:current.selection}});
    return true;
  }
  sendResponse({ok:true});
});

chrome.tabs.onRemoved.addListener(tabId=>sessions.delete(tabId));
function locationHost(url:string){try{return new URL(url).hostname}catch{return 'generic'}}
