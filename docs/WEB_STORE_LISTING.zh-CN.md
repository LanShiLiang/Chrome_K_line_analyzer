# Chrome Web Store 发布文案与数据披露

[English](./WEB_STORE_LISTING.md) | [简体中文](./WEB_STORE_LISTING.zh-CN.md)

本文档是 Chrome Web Store Developer Dashboard 的填写底稿。提交前应逐项与当前生产 ZIP、`PRIVACY.md` 和实际产品行为核对。

## 单一用途

> 将用户主动框选的图表区间或当前受支持的行情上下文转换为浏览器本地 K 线量价与 Wyckoff 分析。

## 商店名称与说明

**名称**

> K Line Analyzer

**简短说明**

> 框选图表 K 线并匹配日期，本地分析 30 分钟至月线的量价结构与 Wyckoff 阶段。

**详细说明**

> K Line Analyzer 是一个专注于交易研究的 Chrome Side Panel 扩展。
>
> 推荐在 Binance 或同花顺行情页面使用。用户可以分析当前行情窗口，也可以主动框选图表区间；框选模式只读取所选矩形，在本地识别周期、将 K 线序列匹配到准确日期、获取对应公开 OHLCV 区间，并让分析结果与图表使用同一选区。TradingView 作为被动行情兼容路径保留。
>
> 核心能力：
>
> - Volume Price Analysis：统一分析 OHLCV 与成交量变化。
> - Wyckoff Analysis：识别吸筹、Spring 测试、拉升、派发和下跌等结构。
> - Local Processing：策略计算和分析结果留在浏览器本地，不上传至开发者服务器。
> - Adjustable Context：支持 30 分钟、1 小时、4 小时、日、周、月周期和最多 1000 根 K 线，计算时明确要求至少 20 根。
> - Local Selection Recognition：从用户主动框选的图表区域识别周期和准确日期范围，使用对应公开 K 线完成分析和绘图，不上传截图。
> - Resilient Market Access：公开行情发生瞬时故障时，仅在前一次请求结束后串行重试，不产生并发重试突发。
> - Explainable Results：展示结论依据、置信度和风险提示，而不是自动下单或收益承诺。
> - Localized Interface：默认使用英文，并根据 Chrome 界面语言自动切换为简体中文。
>
> 支持站点：
>
> - Binance（推荐）：根据当前交易对，从 Binance 公开行情接口获取 K 线。示例：https://www.binance.com/en/trade/BTC_USDT?type=spot
> - 同花顺（推荐）：根据当前证券代码，从同花顺公开行情接口获取 K 线。示例：https://stockpage.10jqka.com.cn/600519/
> - TradingView（兼容）：只读解析当前页面已有 WebSocket 行情，不修改网站连接；可用性取决于页面已经推送的数据。
>
> 使用步骤：打开上述示例或其他受支持行情页并刷新，点击 K Line Analyzer 图标，选择“打开侧边分析面板”，然后框选目标 K 线区间，或直接按已配置窗口开始分析。
>
> 扩展不读取 Cookie、Token、登录凭证、交易账户、订单或支付信息，不包含广告、遥测和远程代码。用户设置保存在 Chrome Storage 中。
>
> 分析结果仅供技术研究，不构成投资建议，不保证准确率或收益。K Line Analyzer 与 Binance、TradingView、同花顺不存在隶属或背书关系。

不要添加“AI 股票神器”“自动预测涨跌”“提高胜率”“稳赚”“赚钱工具”等无法证实或容易误导的表述。

## 权限说明

| 权限或域名                          | 对用户可见功能                                       | 必要性                                         |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| `storage`                           | 保存分析周期、K 线数量和策略设置                     | 仅使用 `chrome.storage.local`，不使用同步存储  |
| `activeTab`                         | 识别当前活动行情标签页，并截取用户主动框选的图表区域 | 绑定当前 Tab 并在本地完成选区图像识别          |
| `sidePanel`                         | 在行情页旁显示分析台                                 | 产品的唯一界面宿主                             |
| `https://www.binance.com/*`         | 识别当前 Binance 交易页并接收页面行情上下文          | 仅在明确支持的 Binance 页面运行 Content Script |
| `https://*.tradingview.com/*`       | 只读解析当前 TradingView 页面已有 WebSocket K 线消息 | TradingView 没有由扩展发起的行情请求           |
| `https://stockpage.10jqka.com.cn/*` | 识别当前同花顺证券页                                 | 仅在明确支持的同花顺页面运行 Content Script    |
| `https://data-api.binance.vision/*` | 用户开始分析时获取对应交易对的公开 K 线              | 请求使用 `credentials: "omit"`                 |
| `https://d.10jqka.com.cn/*`         | 用户开始分析时获取对应证券的公开 K 线                | 请求使用 `credentials: "omit"`                 |

生产 Manifest 不包含 `localhost`、`127.0.0.1`、`<all_urls>`、Cookie、History、Web Request 或远程代码权限。

## Privacy practices 数据披露

Dashboard 的具体字段名称可能随界面更新而变化，含义应按以下口径填写。

### 应披露的数据类型

1. **Website content / 网站内容**：用户主动框选的图表截图、识别到的 K 线颜色、当前公开市场标的、OHLCV 和成交量数据，仅用于匹配日期并生成用户请求的本地分析。
2. **Web browsing activity / 浏览活动**：当前受支持页面的域名、URL 和标题，仅用于识别站点、标的和正确的活动标签页。扩展不读取完整浏览历史，也不在不支持的页面运行。
3. **User settings / 用户设置**（若 Dashboard 提供对应选项）：分析周期、K 线数量和策略设置，仅保存在 `chrome.storage.local`。

不要勾选个人身份信息、精确位置、认证信息、个人通信、交易账户/订单或支付信息；当前代码不处理这些数据。公开市场行情不是用户的交易账户或支付信息。

### 数据用途

- 只用于扩展公开声明的单一用途：在支持的行情页提供本地量价与 Wyckoff 分析。
- 框选截图、行情、页面上下文和分析结果不上传至开发者服务器；截图只保留在扩展运行内存中。
- 不出售数据，不用于广告、信用评估、用户画像、通用市场研究或与产品目的无关的分析。
- 不允许开发者人工读取用户的本地行情、浏览上下文或分析结果。
- 用户设置只保存在 Chrome 本地存储，直到用户重置、清除扩展数据或卸载扩展。
- 主动行情请求只直接发送到 Binance 和同花顺的公开 HTTPS 行情服务，且不携带 Cookie 或登录凭证。

### Limited Use certification

可确认以下声明：

- 数据使用仅限于提供或改进扩展公开声明的单一用途。
- 不将用户数据出售或转移给广告平台、数据经纪商或信息转售商。
- 不将用户数据用于个性化广告或信用评估。
- 不允许人工读取用户数据，适用政策明确允许的例外除外。
- 隐私政策包含 Chrome Web Store User Data Policy 和 Limited Use 的遵守声明。

### 隐私政策 URL

仓库发布到默认分支后填写：

> https://github.com/LanShiLiang/Chrome_K_line_analyzer/blob/master/PRIVACY.md

提交前用无登录浏览器窗口确认该 URL 可公开访问、内容与上传版本一致。

## 商店素材

| 文件                                   |     尺寸 | 用途                       |
| -------------------------------------- | -------: | -------------------------- |
| `assets/icons/icon128.png`             |  128×128 | ZIP 内扩展图标和商店图标   |
| `store-assets/promo-small-440x280.png` |  440×280 | 全球共用的无文字小型宣传图 |
| `store-assets/en/`                     | 1280×800 | 英文商店的三张界面截图     |
| `store-assets/zh-CN/`                  | 1280×800 | 简体中文商店的三张界面截图 |

商店截图由真实 Binance 与同花顺 Side Panel 中英文 E2E 产物合成，不应在代码行为变化后长期复用。运行 `npm.cmd run assets:store` 可重新执行两个真实站点、两种语言的 E2E 并生成素材。

## 提交前核对

- 运行 `npm.cmd run package`，确认全部单元测试、类型检查、构建审计以及真实 Binance、同花顺 E2E 通过。
- 解压 `release/k-line-analyzer-0.1.2.zip`，确认根目录 `manifest.json` 与 `manifest.prod.json` 一致。
- 搜索 ZIP 内容，确认没有 `localhost`、`127.0.0.1`、源代码、Source Map、测试文件或商店宣传素材。
- 确认 ZIP 内包含 16、32、48、128 px PNG 图标，Manifest 的 `icons` 和 `action.default_icon` 均可解析。
- 上传三张 1280×800 最新主题截图、128×128 图标和 440×280 小型宣传图；确认其中包含 Binance 与同花顺实际使用场景。
- 逐字核对商店说明、Privacy practices、隐私政策与实际行为，避免相互矛盾。
- 在 single purpose 字段中填写本文的单一用途，不承诺预测准确率、胜率或收益。
- 提供可用的支持渠道，并确认开发者账号联系邮箱可正常收信。
