# K Line Analyzer User Guide

[English](./USER_GUIDE.md) | [简体中文](./USER_GUIDE.zh-CN.md)

## Install

1. Download and extract the release ZIP, or build the extension with `npm run build`.
2. Open `chrome://extensions` in Chrome.
3. Enable Developer mode and choose **Load unpacked**.
4. Select the generated `dist` directory.
5. Pin K Line Analyzer to the toolbar if desired.

## Choose a Supported Page

- Binance: open a spot trading page such as [BTC/USDT](https://www.binance.com/en/trade/BTC_USDT?type=spot).
- Tonghuashun: open a stock page such as [600519](https://stockpage.10jqka.com.cn/600519/).
- TradingView: open a chart and wait for the page to stream chart data. This is a passive compatibility path.

Refresh the market page after installing or reloading the extension.

## Run an Analysis

1. Click the K Line Analyzer toolbar icon.
2. Select **Open Side Panel**.
3. Confirm that the panel recognizes the current supported site.
4. Select one continuous main-chart area. Five candles meet the calculation minimum, but image-only date matching needs at least 12 candles with clear directions to identify a unique range. The extension captures and processes only that area locally.
5. Releasing the mouse automatically identifies the period and dates, fetches that market range, and starts analysis. The loading view can safely cancel the operation.
6. Review the strategy result, stage, confidence, evidence, and the final symbol, period, candle count, and start/end times shown under **Analysis Window**.

Selection and configured analysis are independent: a new selection replaces the current configured result; selecting **Start Analysis** runs the saved settings and replaces the old selection and its result.

## Settings

Binance and Tonghuashun allow 30-minute, 1-hour, 4-hour, daily, weekly, and monthly periods. The number input can be cleared while editing and accepts 5–1000 candles; invalid drafts show a local message and send no market request. One valid candle-count setting drives both calculation and chart rendering and is saved locally.

TradingView follows the current chart period and the data actually captured from that chart. Its strategy settings remain locked in both the interface and background processing.

## Language

English is the default. When the Chrome UI language is Simplified Chinese, the extension name, Popup, Side Panel, errors, warnings, stages, actions, and analysis evidence appear in Simplified Chinese. Unsupported Chrome languages fall back to English.

The extension has no independent language selector. Change the Chrome UI language and restart Chrome to change the extension language.

## Privacy

Selected-area screenshots, market data, and analysis results stay in runtime memory in the browser and are not uploaded to a developer server. Active public market requests go directly to Binance or Tonghuashun without cookies or login credentials. See the bilingual [Privacy Policy](../PRIVACY.md).

## Troubleshooting

- If the panel cannot find market data, refresh the supported market page and wait for its chart to load.
- If the extension was reloaded, refresh the market page to replace stale Content and Inject scripts.
- If the page or symbol changes during analysis, wait for synchronization and run the analysis again.
- Enter at least 5 candles for configured analysis. For selection date matching, choose at least 12 consecutive candles with clear directions; the panel distinguishes the calculation minimum from insufficient date evidence.
- TradingView availability depends on data already streamed by its current chart; use Binance or Tonghuashun for the recommended active path.

## Disclaimer

Results are for technical research only and are not investment advice. They do not guarantee accuracy or returns.
