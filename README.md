# K Line Analyzer

Chrome Manifest V3 纯前端 K 线量价分析插件。插件按站点选择主动行情接口或页面 WebSocket，将数据统一为 OHLCV，并通过可解释的维科夫量价规则输出阶段、信号、置信度、关键价位和风险提示。

## 功能

- 页面主世界 WebSocket 只读监听，不修改宿主连接、收发帧和心跳。
- 支持 Binance、同花顺和 TradingView：前两者优先使用公开行情接口，TradingView 使用页面 WebSocket 被动数据。
- Content Script 框选遮罩，支持 Esc 取消。
- Tab 级候选数据与分析上下文隔离。
- 数组、对象两类常见 OHLCV 格式标准化。
- 吸筹、Spring 测试、拉升、派发、下跌阶段识别。
- 买入、卖出、观望、风险信号及原因码。
- Lightweight Charts K 线与成交量展示。
- 用户可配置日/周/月周期和 20–1000 根分析 K 线；分析与图表使用同一数据快照。
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

打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，加载项目的 `dist` 目录。打开目标行情页并刷新，使 Inject Script 在网站创建 WebSocket 连接前完成 Hook。

## 验证

```bash
npm run typecheck
npm test
npm run test:e2e:binance
npm run build
npm run package
```

`test:e2e:binance` 会构建并加载当前 `dist`，使用隔离的 Playwright Chromium 打开
`https://www.binance.com/en/trade/ETH_USDT?type=spot`，通过 popup 用户手势打开真实 Chrome Side Panel，验证开始分析、分析结论与依据、200/64 根 K 线非空画布、参数即时重算和分析台重置。`npm run package` 已将该真实站点 E2E 设为发布门禁。

## 目录

```text
src/background    Service Worker 与 Tab Session
src/content       页面识别、框选和 Inject 桥接
src/inject        WebSocket Hook 与增量 K 线聚合
src/core/adapter  站点主动请求、WebSocket 协议解析、OHLCV 标准化与质量校验
src/core/config   用户配置迁移、合并与校验
src/core/analysis 维科夫量价策略引擎
src/drawer        分析面板、图表与实时策略设置
src/popup         插件快捷入口
tests             单元测试
docs/spec         原始企业评审版技术方案（实现基线）
```

## 文档

- `docs/IMPLEMENTATION.md`：当前代码实现、消息契约、扩展点和已知边界。
- `docs/spec/README.md`：原始技术方案文档包的阅读顺序和章节映射。
- `docs/spec/01_*.md` 至 `08_*.md`：总体架构、MV3 运行时、交互、采集适配、数据状态、策略引擎、测试验收和发布运维方案。

修改架构、权限、消息协议、行情数据模型或策略规则时，应同步更新对应方案和 `docs/IMPLEMENTATION.md`。

## 安全边界

- 不读取或存储 Cookie、Token、账号和交易账户信息。
- 捕获失败不会影响宿主页面原始请求。
- 所有计算和配置均保留在本地浏览器中。
- 主动行情请求仅访问 Manifest 明确声明的 Binance 与同花顺数据域名。
- 页面桥接数据仍属于不可信输入，进入分析前会经过结构检查、OHLCV 标准化和数量校验。

## 策略声明

分析结果仅供技术研究，不构成投资建议，不保证准确率或收益。
