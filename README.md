# K Line Analyzer

Chrome Manifest V3 纯前端 K 线量价分析插件。插件在用户当前访问的行情页面内捕获 Fetch/XHR 响应，将候选数据标准化为 OHLCV，并通过可解释的维科夫量价规则输出阶段、信号、置信度、关键价位和风险提示。

## 功能

- 页面主世界 Fetch/XHR Hook，不修改宿主请求和响应。
- Content Script 框选遮罩，支持 Esc 取消。
- Tab 级候选数据与分析上下文隔离。
- 数组、对象两类常见 OHLCV 格式标准化。
- 吸筹、Spring 测试、拉升、派发、下跌阶段识别。
- 买入、卖出、观望、风险信号及原因码。
- Lightweight Charts K 线与成交量展示。
- 本地策略参数与 Chrome Storage 配置。

## 环境要求

- Node.js 20+
- npm 10+
- Chrome 最新稳定版

## 开发

```bash
npm install
npm run dev
```

打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，加载项目的 `dist` 目录。打开目标行情页并刷新，使 Inject Script 能在页面请求发生前完成 Hook。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run package
```

## 目录

```text
src/background    Service Worker 与 Tab Session
src/content       页面识别、框选和 Inject 桥接
src/inject        Fetch/XHR Hook
src/core/adapter  OHLCV 标准化与质量校验
src/core/analysis 维科夫量价策略引擎
src/drawer        分析面板与图表
src/popup         插件快捷入口
src/options       全局参数设置
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
- 当前 MVP 为便于通用站点验证声明了宽域名权限；正式商店发布前必须按支持站点收敛 `host_permissions`。

## 策略声明

分析结果仅供技术研究，不构成投资建议，不保证准确率或收益。
