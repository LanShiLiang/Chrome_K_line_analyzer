# K Line Analyzer

[English](./README.md) | [简体中文](./README.zh-CN.md)

Chrome Manifest V3 纯前端 K 线量价分析插件。插件可将用户主动框选的图表区间或当前行情上下文转换为本地分析：识别选区周期与日期，获取对应公开 OHLCV 窗口，并通过可解释的维科夫量价规则输出阶段、信号、置信度、关键价位和风险提示。

## 推荐使用方式

优先在 Binance 和同花顺行情页面使用本插件：

- **Binance 示例**：[BTC/USDT 现货行情](https://www.binance.com/en/trade/BTC_USDT?type=spot)。适合加密资产 K 线与成交量分析。
- **同花顺示例**：[贵州茅台 600519](https://stockpage.10jqka.com.cn/600519/)。适合 A 股个股 K 线与成交量分析，并使用红涨绿跌配色。

打开支持的行情页面并刷新后，点击浏览器工具栏中的 K Line Analyzer 图标，选择“打开侧边分析面板”，框选需要研究的 K 线，再点击“开始分析”。插件会在本地识别选区图像中的 K 线颜色、周期和日期，获取对应公开行情，并生成结论、依据和图表。

TradingView 作为兼容路径，仅分析页面已经推送且被插件被动捕获的行情；其可用性取决于当前图表数据。首次使用和日常使用建议选择 Binance 或同花顺。

## 功能

- 默认使用英文，并根据 Chrome 界面语言自动切换为简体中文。
- 插件名称、简介、Popup、Side Panel、错误、警告、阶段、信号和分析依据完整国际化。
- 页面主世界 WebSocket 只读监听，不修改宿主连接、收发帧和心跳。
- 支持 Binance、同花顺和 TradingView：前两者优先使用公开行情接口，TradingView 使用页面 WebSocket 被动数据。
- 公开行情请求遇到瞬时故障时严格串行重试；前一次请求结束后才会等待并发起下一次，不产生并发请求突发。
- Content Script 框选遮罩支持 Esc 取消；选区截图仅在本地运行内存中识别周期、日期和 K 线范围，分析与图表使用同一选区且不上传截图。
- Tab 级候选数据与分析上下文隔离。
- 数组、对象两类常见 OHLCV 格式标准化。
- 吸筹、Spring 测试、拉升、派发、下跌阶段识别。
- 买入、卖出、观望、风险信号及原因码。
- Lightweight Charts K 线与成交量展示。
- 用户可配置 30 分钟、1 小时、4 小时、日、周、月周期和最多 1000 根分析 K 线；输入框允许从 1 开始输入，计算时明确要求至少 20 根，分析与图表使用同一数据快照。
- 策略阈值由分析引擎统一维护，用户设置保存在 Chrome Storage。

## 环境要求

- Node.js 20+
- npm 10+
- Chrome 最新稳定版

## 开发

```bash
npm install
npm run dev
```

`npm run dev` 使用 `manifest.dev.json`，保留 `localhost` 和 `127.0.0.1` 测试页访问。打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，加载项目的 `dist` 目录。打开目标行情页并刷新，使 Inject Script 在网站创建 WebSocket 连接前完成 Hook。

`npm run build`、真实站点 E2E 和发布打包统一使用 `manifest.prod.json`。Production Manifest 只包含当前支持页面及 Binance、同花顺公开行情接口所需域名；构建审计会拒绝任何包含 `localhost`、`127.0.0.1` 或与生产清单不一致的产物。

## 验证

```bash
npm run typecheck
npm test
npm run test:e2e:locale
npm run test:e2e:binance
npm run test:e2e:tonghuashun
npm run test:e2e:release
npm run build
npm run package
```

`test:e2e:binance` 会构建并加载当前 `dist`，使用隔离的 Playwright Chromium 打开
`https://www.binance.com/en/trade/BTC_USDT?type=spot`；`test:e2e:tonghuashun` 使用同样流程打开 `https://stockpage.10jqka.com.cn/600519/`。两项测试都会通过 Popup 用户手势打开真实 Chrome Side Panel，验证开始分析、分析结论与依据、200/64 根 K 线非空画布、小于 20 根的可见校验、响应式布局和分析台重置；Binance 还验证真实选区截图与像素识别。`test:e2e:release` 与 `npm run package` 将两个真实站点都设为发布门禁。

## Chrome Web Store 发布材料

- `PRIVACY.md`：中英双语隐私政策，说明本地数据处理、支持站点、保留期限、第三方行情请求和 Limited Use。
- `docs/WEB_STORE_LISTING.md`：Developer Dashboard 默认英文商店文案。
- `docs/WEB_STORE_LISTING.zh-CN.md`：与英文版一致的简体中文商店文案。
- `assets/icons/`：Manifest 使用的 16、32、48、128 px PNG 图标及可编辑 SVG 源文件。
- `store-assets/en/`、`store-assets/zh-CN/`：英文和简体中文 1280×800 商店截图。
- `store-assets/promo-small-440x280.png`：全球共用的无文字小型宣传图。

运行 `npm run assets:store` 会先生成图标，再执行真实 Binance 与同花顺 E2E，并基于两个站点的最新 Side Panel 产物重新生成商店素材。

## 目录

```text
src/background    Service Worker 与 Tab Session
src/content       页面识别、框选和 Inject 桥接
src/inject        WebSocket Hook 与增量 K 线聚合
src/core/adapter  站点主动请求、WebSocket 协议解析、OHLCV 标准化与质量校验
src/core/config   用户配置迁移、合并与校验
src/core/analysis 维科夫量价策略引擎
src/drawer        分析面板、图表、国际化映射与实时策略设置
src/popup         插件快捷入口
tests             单元测试
docs/spec         原始企业评审版技术方案（实现基线）
```

## 文档

- [User Guide](./docs/USER_GUIDE.md) / [用户指南](./docs/USER_GUIDE.zh-CN.md)
- [FAQ](./docs/FAQ.md) / [常见问题](./docs/FAQ.zh-CN.md)
- `docs/IMPLEMENTATION.md`：当前代码实现、消息契约、扩展点和已知边界。
- `docs/spec/README.md`：原始技术方案文档包的阅读顺序和章节映射。
- `docs/spec/01_*.md` 至 `08_*.md`：总体架构、MV3 运行时、交互、采集适配、数据状态、策略引擎、测试验收和发布运维方案。

修改架构、权限、消息协议、行情数据模型或策略规则时，应同步更新对应方案和 `docs/IMPLEMENTATION.md`。

## 安全边界

- 不读取或存储 Cookie、Token、账号和交易账户信息。
- 捕获失败不会影响宿主页面原始请求。
- 所有计算和配置均保留在本地浏览器中。
- 当前受支持页面的 URL、标题和公开行情内容只用于识别市场上下文并生成本地分析。
- 主动行情请求仅访问 Manifest 明确声明的 Binance 与同花顺数据域名。
- 页面桥接数据仍属于不可信输入，进入分析前会经过结构检查、OHLCV 标准化和数量校验。

## 策略声明

分析结果仅供技术研究，不构成投资建议，不保证准确率或收益。
