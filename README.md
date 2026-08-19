# K Line Analyzer

[English](./README.md) | [简体中文](./README.zh-CN.md)

A Chrome Manifest V3 extension that turns an explicitly selected chart range—or the current supported market context—into local candlestick, volume-price, and Wyckoff analysis. It identifies the selected period and dates, requests the matching public OHLCV window, and presents explainable stages, signals, confidence, key levels, and risk warnings in the Chrome Side Panel.

## Recommended Usage

Use the extension primarily on Binance and Tonghuashun market pages:

- **Binance example:** [BTC/USDT Spot](https://www.binance.com/en/trade/BTC_USDT?type=spot), for crypto candlestick and volume analysis.
- **Tonghuashun example:** [Kweichow Moutai 600519](https://stockpage.10jqka.com.cn/600519/), for mainland China A-share analysis with red-up and green-down market colors.

Open and refresh a supported market page, click the K Line Analyzer toolbar icon, choose **Open Side Panel**, frame the candlesticks you want to inspect, and then select **Start Analysis**. The extension locally reads the selected chart image, matches its period and dates, requests the corresponding public market data, and generates the result and chart locally.

TradingView remains a compatibility path. It only analyzes market data already streamed by the current page and passively captured by the extension. Availability depends on the current chart data; Binance or Tonghuashun is recommended for normal use.

## Features

- English by default, with Simplified Chinese automatically selected from the Chrome UI language.
- Localized extension name, description, Popup, Side Panel, errors, warnings, stages, actions, and analysis evidence.
- Read-only MAIN-world WebSocket observation without altering host connections, frames, or heartbeat behavior.
- Binance and Tonghuashun active public market-data requests with passive page-data fallback.
- Transient public-market request failures retry serially after the previous request settles, without concurrent request bursts.
- TradingView passive current-chart compatibility with locked strategy parameters.
- Tab-scoped market candidates and analysis context isolation.
- OHLCV normalization for common array and object formats.
- Explainable accumulation, Spring test, markup, distribution, and markdown detection.
- Buy, sell, hold, and risk signals with reason codes and confidence.
- Lightweight Charts candlestick and volume rendering.
- 30-minute, 1-hour, 4-hour, daily, weekly, and monthly periods with a configurable window up to 1000 candles; calculations clearly require at least 20.
- Local selected-image recognition that identifies the chart period, matches candle colors to exact market dates, and uses the same selected range for analysis and charting without uploading screenshots.
- One `analysisCandleCount` snapshot drives both analysis and chart rendering.
- User settings remain in `chrome.storage.local`.

## Requirements

- Node.js 20+
- npm 10+
- Latest stable Chrome

## Development

```bash
npm install
npm run dev
```

`npm run dev` uses `manifest.dev.json` and retains local test-page access for `localhost` and `127.0.0.1`. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `dist` directory. Refresh the target market page after loading or reloading the extension so the MAIN-world hook is installed before the page creates its WebSocket connections.

Production builds and release packaging use `manifest.prod.json`. The production manifest contains only supported page origins and the Binance/Tonghuashun public market-data endpoints. Build verification rejects local-development hosts, inconsistent manifests, missing locale messages, stale files, and invalid extension entry points.

## Verification

```bash
npm run typecheck
npm test
npm run test:e2e:locale
npm run test:e2e:release
npm run build
npm run package
```

- `test:e2e:locale` loads the real extension against Binance in English and Simplified Chinese Chrome environments.
- `test:e2e:release` validates the English Binance path and Simplified Chinese Tonghuashun path.
- Real Side Panel E2E covers the Popup user gesture, active Tab binding, localized UI, 200/64 candle analysis, 30-minute/1-hour/4-hour periods, selected-image date matching, insufficient selections, non-empty Canvas output, responsive recovery, and reset behavior.
- `npm run package` runs the complete release gate and creates the versioned ZIP and SHA-256 checksum.

## Chrome Web Store Materials

- `PRIVACY.md`: bilingual privacy policy covering local processing, supported sites, retention, third-party market requests, and Limited Use.
- `docs/WEB_STORE_LISTING.md`: default English store listing, permissions, data disclosures, and submission checklist.
- `docs/WEB_STORE_LISTING.zh-CN.md`: matching Simplified Chinese store listing.
- `assets/icons/`: 16, 32, 48, and 128 px Manifest icons plus the editable SVG source.
- `store-assets/en/`: English localized screenshots.
- `store-assets/zh-CN/`: Simplified Chinese localized screenshots.
- `store-assets/promo-small-440x280.png`: global text-free promotional tile.

Run `npm run assets:store` to rebuild icons, execute the required locale/site E2E matrix, and regenerate localized Chrome Web Store screenshots.

## Project Layout

```text
_locales         English and Simplified Chinese Chrome message catalogs
src/background   Service Worker and Tab sessions
src/content      Page recognition, selection overlay, and Inject bridge
src/inject       MAIN-world WebSocket observation and candle aggregation
src/core/adapter Site requests, WebSocket parsing, normalization, and quality checks
src/core/config  User configuration migration, merging, and validation
src/core/analysis Explainable Wyckoff and volume-price rules
src/drawer       Side Panel UI, charting, localization mapping, and settings
src/popup        Toolbar Popup entry point
tests            Unit and release-contract tests
docs/spec        Technical design documents
```

## Documentation

- [User Guide](./docs/USER_GUIDE.md) / [用户指南](./docs/USER_GUIDE.zh-CN.md)
- [FAQ](./docs/FAQ.md) / [常见问题](./docs/FAQ.zh-CN.md)
- `docs/IMPLEMENTATION.md`: current implementation, message contracts, extension points, and known boundaries.
- `docs/spec/README.md`: reading order for the technical design package.

Update the relevant Markdown documents whenever permissions, message contracts, market-data models, strategy rules, or public behavior change.

## Security and Privacy Boundaries

- The extension does not read or store cookies, authentication tokens, account credentials, trading accounts, positions, or orders.
- Market data, page context, and analysis results are not uploaded to a developer server.
- Active requests access only the explicitly declared Binance and Tonghuashun public market-data endpoints and omit credentials.
- The page bridge treats all captured data as untrusted input and validates structure, OHLC relationships, volume, and candle count before analysis.
- Invalid settings, insufficient candles, and calculation failures are shown as user-facing errors instead of silently returning a hold signal.

See the bilingual [Privacy Policy](./PRIVACY.md) for the complete disclosure.

## Disclaimer

Results are for technical research only. They are not investment advice, do not guarantee accuracy or returns, and do not replace independent judgment.
