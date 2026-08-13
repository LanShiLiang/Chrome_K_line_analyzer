import{describe,expect,it}from'vitest';
import{decodeTradingViewMessages,parseBinanceFrame,parseTradingViewFrame,parseWebSocketFrame}from'../src/core/adapter/websocket';

const framed=(value:unknown)=>{const json=JSON.stringify(value);return`~m~${json.length}~m~${json}`};
const binanceKline=(overrides:Record<string,unknown>={})=>({e:'kline',s:'BTCUSDT',k:{t:1710000000000,s:'BTCUSDT',i:'1m',o:'10',h:'12',l:'9',c:'11',v:'100',...overrides}});

describe('TradingView WebSocket adapter',()=>{
  it('decodes concatenated protocol messages and skips raw and JSON heartbeats',()=>{
    const first={m:'timescale_update',p:['cs_1',{}]};
    const second={m:'du',p:['cs_1',{}]};
    expect(decodeTradingViewMessages(`${framed(first)}${framed('~h~1')}${framed(second)}`)).toEqual([first,second]);
    expect(decodeTradingViewMessages('~m~5~m~~h~1')).toEqual([]);
  });

  it('extracts indexed OHLCV batches from timescale updates',()=>{
    const frame=framed({m:'timescale_update',p:['cs_1',{s1:{s:[{i:0,v:[0,1710000000,10,12,9,11,100]},{i:1,v:[1,1710000060,11,13,10,12,120]}]}}]});
    const[result]=parseTradingViewFrame(frame);
    expect(result).toMatchObject({adapterId:'tradingview-ws',siteId:'tradingview',confidence:95});
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]).toMatchObject({timestamp:1710000000000,open:10,close:11,volume:100});
  });

  it('ignores unrelated, truncated, and invalid candle frames',()=>{
    expect(parseTradingViewFrame(framed({m:'quote_completed',p:[]}))).toEqual([]);
    expect(parseTradingViewFrame('~m~100~m~{"m":"timescale_update"}')).toEqual([]);
    const invalid=framed({m:'du',p:['cs_1',{s1:{s:[{v:[0,10,9,8,10,1]}]}}]});
    expect(parseTradingViewFrame(invalid)).toEqual([]);
  });
});

describe('Binance WebSocket adapter',()=>{
  it('parses combined and raw kline streams',()=>{
    const[combined]=parseBinanceFrame(JSON.stringify({stream:'btcusdt@kline_1m',data:binanceKline()}));
    const[raw]=parseBinanceFrame(JSON.stringify(binanceKline({t:1710000060000})));
    expect(combined).toMatchObject({adapterId:'binance-ws',channel:'btcusdt@kline_1m',symbol:'BTCUSDT',period:'1m'});
    expect(combined.candles[0]).toMatchObject({open:10,high:12,low:9,close:11,volume:100});
    expect(raw.candles[0].timestamp).toBe(1710000060000);
  });

  it('rejects non-kline events, invalid JSON, OHLC, volume, and timestamps',()=>{
    expect(parseBinanceFrame('{')).toEqual([]);
    expect(parseBinanceFrame(JSON.stringify({e:'trade'}))).toEqual([]);
    expect(parseBinanceFrame(JSON.stringify(binanceKline({h:'8'})))).toEqual([]);
    expect(parseBinanceFrame(JSON.stringify(binanceKline({v:'-1'})))).toEqual([]);
    expect(parseBinanceFrame(JSON.stringify(binanceKline({t:0})))).toEqual([]);
  });
});

describe('WebSocket site routing',()=>{
  const binanceFrame=JSON.stringify(binanceKline());
  it('matches exact hosts and subdomains without trusting lookalike domains',()=>{
    expect(parseWebSocketFrame('www.binance.com',binanceFrame)).toHaveLength(1);
    expect(parseWebSocketFrame('evilbinance.com',binanceFrame)).toHaveLength(1);
    expect(parseWebSocketFrame('tradingview.com',binanceFrame)).toEqual([]);
  });
});
