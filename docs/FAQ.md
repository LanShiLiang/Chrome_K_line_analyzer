# K Line Analyzer FAQ

[English](./FAQ.md) | [简体中文](./FAQ.zh-CN.md)

## Why is English the default?

English provides a consistent fallback for unsupported Chrome languages and makes the extension accessible to Binance users and the global Chrome Web Store audience. Simplified Chinese remains fully supported for Tonghuashun and mainland China A-share users.

## How does the extension choose its language?

It uses Chrome's extension localization system and the Chrome UI language. There is no separate extension setting. Unsupported languages fall back to English.

## Are `BUY`, `MARKUP`, and other internal keywords translated in code?

No. Internal action values, stages, error codes, and evidence codes remain stable English machine identifiers. Only the labels rendered to the user are localized.

## Does the extension upload market data or results?

No. Selected-area screenshots, image matching, and analysis run locally, and none of them are uploaded to a developer server. Public market requests go directly to the declared Binance or Tonghuashun endpoints.

## How does selected-image analysis identify dates?

The extension captures only the chart rectangle explicitly selected by the user, detects red/green candle groups locally, identifies the current chart period from page market context, and matches the color sequence against normalized OHLCV. If the period or date range cannot be matched reliably, it asks the user to select again instead of inventing a range.

## Why are TradingView settings locked?

TradingView uses only data already streamed to the current page. The extension follows the current chart period and captured candle count instead of issuing a separate active request or overriding that context.

## Why does the panel report insufficient candles instead of calculating anyway?

The selected candle count is the complete analysis and chart window. Running with a shorter hidden window would make the displayed chart and strategy calculation inconsistent, so the extension shows an explicit error.

## Is this an automated trading tool?

No. It does not place orders, access trading accounts, predict guaranteed outcomes, or promise returns. Results are explainable technical-research output only.
