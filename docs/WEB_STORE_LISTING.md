# Chrome Web Store Listing and Data Disclosure

[English](./WEB_STORE_LISTING.md) | [简体中文](./WEB_STORE_LISTING.zh-CN.md)

This document is the English-default source for the Chrome Web Store Developer Dashboard. Before submission, compare every field with the production ZIP, `PRIVACY.md`, and the current extension behavior.

## Single Purpose

> Provide local candlestick, volume-price, and Wyckoff analysis while the user browses a supported market page.

## Store Name and Description

**Name**

> K Line Analyzer

**Short description**

> Analyze candlesticks, volume-price structure, and Wyckoff stages locally beside supported Binance and Tonghuashun market pages.

**Detailed description**

> K Line Analyzer is a focused Chrome Side Panel extension for market research.
>
> Open a supported Binance or Tonghuashun market page, then use the side panel to review current candlestick and volume data, volume-price structure, Wyckoff stages, strategy results, evidence, key levels, and risk warnings. TradingView remains available as a passive current-chart compatibility path.
>
> Core capabilities:
>
> - Volume-Price Analysis: normalizes and evaluates OHLCV and volume changes.
> - Wyckoff Analysis: identifies accumulation, Spring tests, markup, distribution, and markdown structures.
> - Local Processing: strategy calculations and results stay in the browser and are not uploaded to a developer server.
> - Adjustable Context: supports daily, weekly, and monthly periods with 20–1000 candles.
> - Explainable Results: shows reason codes, evidence, confidence, and risk warnings instead of placing orders or promising returns.
> - Localized Interface: English is the default, with Simplified Chinese selected automatically from the Chrome UI language.
>
> Supported sites:
>
> - Binance (recommended): requests public candlestick data for the current trading pair from Binance's public market-data endpoint. Example: https://www.binance.com/en/trade/BTC_USDT?type=spot
> - Tonghuashun (recommended): requests public candlestick data for the current stock code from Tonghuashun's market-data endpoint. Example: https://stockpage.10jqka.com.cn/600519/
> - TradingView (compatibility): read-only parses market data already streamed to the current page. Availability depends on the data present in the active chart.
>
> To use the extension, open and refresh a supported market page, click the K Line Analyzer toolbar icon, choose Open Side Panel, and select Start Analysis.
>
> The extension does not read cookies, authentication tokens, login credentials, trading accounts, positions, orders, or payment information. It contains no advertising, telemetry, or remote code. User settings remain in `chrome.storage.local`.
>
> Results are for technical research only. They are not investment advice and do not guarantee accuracy or returns. K Line Analyzer is not affiliated with or endorsed by Binance, TradingView, or Tonghuashun.

Do not add unsubstantiated or misleading claims such as “AI stock oracle,” “automatic price prediction,” “guaranteed win rate,” or “guaranteed profit.”

## Permissions

| Permission or origin                | User-facing function                                                               | Why it is required                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `storage`                           | Saves the analysis period and candle count                                         | Uses only `chrome.storage.local`; synchronization is not enabled        |
| `activeTab`                         | Identifies the active supported market tab after the user opens the panel          | Binds each request and result to the user's current tab                 |
| `sidePanel`                         | Displays the analysis workbench beside the market page                             | The Side Panel is the primary extension interface                       |
| `https://www.binance.com/*`         | Recognizes the current Binance market page and receives page context               | Runs only on explicitly supported Binance pages                         |
| `https://*.tradingview.com/*`       | Read-only observes market messages already streamed to the current chart           | The extension does not create an active TradingView market-data request |
| `https://stockpage.10jqka.com.cn/*` | Recognizes the current Tonghuashun stock page                                      | Runs only on explicitly supported Tonghuashun pages                     |
| `https://data-api.binance.vision/*` | Requests public candles for the current Binance pair when the user starts analysis | Requests use `credentials: "omit"`                                      |
| `https://d.10jqka.com.cn/*`         | Requests public candles for the current Tonghuashun stock code                     | Requests use `credentials: "omit"`                                      |

The production Manifest does not contain `localhost`, `127.0.0.1`, `<all_urls>`, Cookie, History, Web Request, or remote-code permissions.

## Privacy Practices Disclosure

Dashboard labels can change. Complete the current fields using the following behavior-based disclosure.

### Data types to disclose

1. **Website content:** the public market symbol, OHLCV, and volume data from the supported page or market response, used only to generate the local analysis requested by the user.
2. **Web browsing activity:** the domain, URL, and title of the current supported page, used only to identify the site, symbol, and correct active tab. The extension does not read general browsing history and does not run on unsupported pages.
3. **User settings**, if the Dashboard provides that category: analysis period and candle count, stored only in `chrome.storage.local`.

Do not select personally identifiable information, precise location, authentication information, personal communications, trading accounts/orders, or payment information. The current code does not process these categories.

### Data use

- Data is used only for the disclosed single purpose of providing local market analysis on supported pages.
- Market data, page context, and analysis results are not uploaded to a developer server.
- Data is not sold or used for advertising, credit assessment, user profiling, or unrelated analytics.
- Developers cannot manually read a user's local market data, browsing context, settings, or results.
- User settings remain in local Chrome storage until reset, extension data is cleared, or the extension is uninstalled.
- Active market requests go directly to the declared Binance or Tonghuashun HTTPS endpoints without cookies or login credentials.

### Limited Use certification

The following statements can be confirmed:

- Data use is limited to providing or improving the extension's disclosed single purpose.
- User data is not sold or transferred to advertising platforms, data brokers, or information resellers.
- User data is not used for personalized advertising or creditworthiness assessment.
- Human access is prohibited except for cases explicitly allowed by applicable policy.
- The privacy policy includes compliance with the Chrome Web Store User Data Policy and Limited Use requirements.

### Privacy policy URL

> https://github.com/LanShiLiang/Chrome_K_line_analyzer/blob/master/PRIVACY.md

Before submission, confirm in a signed-out browser that the URL is public and matches the uploaded version.

## Localized Store Assets

| Locale                       | Description                  | Screenshots           |
| ---------------------------- | ---------------------------- | --------------------- |
| English default              | This document                | `store-assets/en/`    |
| Simplified Chinese (`zh_CN`) | `WEB_STORE_LISTING.zh-CN.md` | `store-assets/zh-CN/` |

Use the global text-free small promotional tile at `store-assets/promo-small-440x280.png` for both locales.

## Submission Checklist

- [ ] The English and Simplified Chinese listings describe the same features and limitations.
- [ ] The production ZIP passes the complete package gate.
- [ ] English and Simplified Chinese locale E2E pass in real Chrome Side Panels.
- [ ] Binance and Tonghuashun active market-data paths pass real-site E2E.
- [ ] TradingView remains passive-only and its settings remain locked.
- [ ] English screenshots contain only the English UI; Chinese screenshots contain the Simplified Chinese UI.
- [ ] Internal state keywords such as `BUY` and `MARKUP` are not exposed directly as localized UI labels.
- [ ] The privacy policy and Dashboard disclosures match actual code behavior.
- [ ] The listing contains no keyword spam, affiliation claim, automated-trading claim, or return promise.
