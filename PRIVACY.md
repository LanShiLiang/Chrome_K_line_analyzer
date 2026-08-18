# K Line Analyzer 隐私政策 / Privacy Policy

生效日期：2026 年 8 月 19 日
Effective date: August 19, 2026

## 单一用途 / Single purpose

K Line Analyzer 的单一用途是在用户浏览受支持的行情页面时，在浏览器本地提供 K 线量价与 Wyckoff 分析。分析结果仅供交易研究，不构成投资建议。

K Line Analyzer has one purpose: to provide local candlestick, volume-price, and Wyckoff analysis while the user browses a supported market page. Results are for trading research only and are not investment advice.

## 处理的数据 / Data handled

扩展仅为上述用途处理以下数据：

- 当前受支持页面的域名、URL、页面标题和由 URL 表示的市场标的，用于识别 Binance、TradingView 或同花顺行情页并将分析绑定到正确的标签页。
- 公开市场行情数据，包括时间、开盘价、最高价、最低价、收盘价和成交量（OHLCV）。
- 用户在扩展中选择的分析周期、K 线数量和其他策略设置。
- 用户的页面框选坐标，仅用于当前标签页的交互确认。

The extension handles only the following data for that purpose:

- The supported page's domain, URL, title, and market symbol represented in the URL, to recognize Binance, TradingView, or Tonghuashun pages and bind analysis to the correct tab.
- Public market data, including timestamp, open, high, low, close, and volume (OHLCV).
- Analysis period, candle count, and other strategy settings selected by the user.
- Page-selection coordinates, used only to confirm the interaction in the current tab.

## 各站点用途 / Supported-site use

- **Binance**：从用户当前交易页 URL 识别交易对；用户开始分析时，扩展通过 `https://data-api.binance.vision` 获取相应的公开 K 线数据，请求不携带 Cookie 或登录凭证。
- **TradingView**：只读解析用户当前页面已有 WebSocket 连接中的 K 线行情消息；扩展不修改连接、请求、响应或心跳，也不会为了分析另建开发者服务器连接。
- **同花顺**：从用户当前股票页 URL 识别证券代码；用户开始分析时，扩展通过 `https://d.10jqka.com.cn` 获取相应的公开 K 线数据，请求不携带 Cookie 或登录凭证。

- **Binance:** The extension derives the trading pair from the current trade-page URL. When the user starts analysis, it requests the corresponding public candlestick data from `https://data-api.binance.vision` without cookies or login credentials.
- **TradingView:** The extension read-only parses candlestick messages from the WebSocket connection already used by the current page. It does not alter the connection, requests, responses, or heartbeat, and it does not create a connection to a developer server for analysis.
- **Tonghuashun:** The extension derives the security code from the current stock-page URL. When the user starts analysis, it requests the corresponding public candlestick data from `https://d.10jqka.com.cn` without cookies or login credentials.

## 本地存储与保留 / Local storage and retention

行情数据、页面上下文、框选坐标和分析结果只保留在扩展运行内存中，不写入开发者服务器或长期数据库。它们会在标签页状态被重置、扩展运行上下文结束或浏览器清理运行状态时消失。

用户设置保存在 `chrome.storage.local`，直到用户在扩展中重置设置、清除扩展数据或卸载扩展。扩展不使用 Chrome Storage Sync。

Market data, page context, selection coordinates, and analysis results remain only in extension runtime memory. They are not written to a developer server or long-term database and disappear when tab state is reset, the extension runtime ends, or the browser clears runtime state.

User settings are stored in `chrome.storage.local` until the user resets settings in the extension, clears extension data, or uninstalls the extension. The extension does not use Chrome Storage Sync.

## 不收集和不共享的数据 / Data not collected or shared

扩展不读取、收集或存储姓名、邮箱、精确位置、Cookie、登录凭证、认证 Token、交易账户、持仓、订单、支付信息、个人通信或用户生成内容。扩展不包含广告、分析埋点或遥测，不出售用户数据，也不把行情数据、浏览活动、用户设置或分析结果上传至开发者服务器或提供给数据经纪商、广告平台或其他第三方。

为了取得用户请求的公开行情，浏览器会直接连接上述 Binance 或同花顺行情服务；这些服务可能像其他网络服务一样接收到必要的网络信息（例如 IP 地址）。其数据处理受各自的隐私条款约束。TradingView 路径复用用户已访问页面的既有连接。

The extension does not read, collect, or store names, email addresses, precise location, cookies, login credentials, authentication tokens, trading accounts, positions, orders, payment information, personal communications, or user-generated content. It contains no advertising, analytics, or telemetry; it does not sell user data; and it does not upload market data, browsing activity, settings, or analysis results to a developer server or disclose them to data brokers, advertising platforms, or other third parties.

To obtain public market data requested by the user, the browser connects directly to the Binance or Tonghuashun market-data service listed above. Like other network services, those providers may receive network information necessary to serve the request, such as the user's IP address, under their own privacy terms. The TradingView path uses the connection already established by the page the user visited.

## 安全与 Limited Use / Security and Limited Use

扩展只通过 HTTPS/WSS 处理网络行情，主动请求显式使用 `credentials: "omit"`。扩展只将所处理的数据用于其公开声明的单一用途。

K Line Analyzer 对所获信息的使用遵守 Chrome Web Store User Data Policy，包括 Limited Use 要求。扩展不会将用户数据用于个性化广告、信用评估、与单一用途无关的分析或其他禁止用途，也不允许开发者人工读取用户的本地行情或分析数据。

The extension handles network market data only over HTTPS/WSS, and active requests explicitly use `credentials: "omit"`. It uses handled data only for its disclosed single purpose.

K Line Analyzer's use of information complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. The extension does not use user data for personalized advertising, creditworthiness, analytics unrelated to its single purpose, or other prohibited purposes, and the developer cannot manually read the user's local market or analysis data.

## 变更与联系 / Changes and contact

如数据处理方式发生变化，本政策和 Chrome Web Store 披露会在新版本生效前更新，并按适用政策向用户作出明确说明。隐私问题可通过项目的 [GitHub Issues](https://github.com/LanShiLiang/Chrome_K_line_analyzer/issues) 联系开发者；请勿在公开 Issue 中提交账户、交易或其他敏感信息。

If data handling changes, this policy and the Chrome Web Store disclosures will be updated before the new version takes effect, and users will be clearly informed as required. For privacy questions, contact the developer through the project's [GitHub Issues](https://github.com/LanShiLiang/Chrome_K_line_analyzer/issues). Do not post account, trading, or other sensitive information in a public issue.
