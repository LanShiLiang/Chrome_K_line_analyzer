import{describe,expect,it}from'vitest';
import{decodeTradingViewMessages,parseBinanceFrame,parseTradingViewFrame}from'../src/core/adapter/websocket';

const framed=(value:unknown)=>{const json=JSON.stringify(value);return`~m~${json.length}~m~${json}`};

describe('TradingView WebSocket adapter',()=>{
  it('decodes framed protocol messages and skips heartbeats',()=>{
    const message={m:'timescale_update',p:['cs_1',{}]};
    expect(decodeTradingViewMessages(`${framed(message)}${framed('~h~1')}`)).toEqual([message]);
  });
  it('extracts OHLCV batches from timescale updates',()=>{
    const frame=framed({m:'timescale_update',p:['cs_1',{s1:{s:[{i:0,v:[1710000000,10,12,9,11,100]},{i:1,v:[1710000060,11,13,10,12,120]}]}}]});
    const [result]=parseTradingViewFrame(frame);
    expect(result.adapterId).toBe('tradingview-ws');
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]).toMatchObject({timestamp:1710000000000,open:10,close:11,volume:100});
  });
});

describe('Binance WebSocket adapter',()=>{
  it('parses combined kline streams',()=>{
    const [result]=parseBinanceFrame(JSON.stringify({stream:'btcusdt@kline_1m',data:{e:'kline',s:'BTCUSDT',k:{t:1710000000000,s:'BTCUSDT',i:'1m',o:'10',h:'12',l:'9',c:'11',v:'100'}}}));
    expect(result).toMatchObject({adapterId:'binance-ws',symbol:'BTCUSDT',period:'1m'});
    expect(result.candles[0]).toMatchObject({open:10,high:12,low:9,close:11,volume:100});
  });
});
