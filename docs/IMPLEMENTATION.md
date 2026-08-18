# 实现说明

## 决策记录

| 决策     | 实现                                                                     | 原因                                                       |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| UI 宿主  | Chrome Side Panel                                                        | 不改变目标网站 DOM 布局，并可与行情图并排操作              |
| 数据捕获 | `document_start` 主世界 WebSocket Hook                                   | 行情站点以长连接推送为主；只读监听不修改宿主帧             |
| 构建边界 | UI/Service Worker 使用 ESM；MAIN/ISOLATED Content Script 分别构建为 IIFE | Manifest Content Script 不能直接执行带静态 `import` 的产物 |
| 适配方式 | Binance/同花顺主动请求 + TradingView WebSocket + 通用 OHLCV 归一化       | 站点协议与策略数据模型隔离                                 |
| 策略计算 | 单次快照编排 + 纯函数                                                    | 分析与图表严格复用同一批 K 线，可测试、可复现              |
| 用户配置 | 周期 + 分析 K 线数量                                                     | 消除窗口和阈值之间的冲突；策略阈值由引擎统一维护           |
| 数据存储 | Chrome Storage 配置；运行数据按 Tab 内存保存                             | 避免保存原始响应和敏感数据                                 |

界面品牌层使用深海蓝、冰蓝高光和低饱和蓝灰表面建立视觉层级；按钮、状态、选区与证据强调统一使用品牌蓝。K 线预览继续由 Lightweight Charts 按行情语义渲染涨跌与成交量颜色，不强制套用品牌色。Binance、TradingView 使用绿涨红跌；同花顺的策略结论、K 线实体/影线和成交量柱统一切换为红涨绿跌。

## 当前边界

- Binance 与同花顺优先通过匿名行情接口主动获取数据；失败时可回退到当前 Tab 已捕获的 WebSocket 候选。
- TradingView 仅被动解析页面 WebSocket 的 `timescale_update`/`du` K 线批次，不主动调用其非公开接口。
- TradingView 适配器解析长度前缀帧中的 `timescale_update`/`du` K 线批次；该站点协议不是公开稳定 API，升级后需用脱敏帧样本回归。
- 插件安装、重新加载或重新构建后必须刷新目标行情页，确保 Hook 在站点创建 WebSocket 连接之前运行。
- `npm run build` 会把 UI、Content Script 和 MAIN world 注入脚本并行构建到隔离临时目录；只有版本、引用可达性、敏感文件和脚本格式审计全部通过，才会整体替换 `dist`。如果出现残留文件、缺失依赖或 Content Script ESM 语法，构建直接失败并保留上一份产物。
- 所有站点数据必须先转换为统一 OHLCV，再由同一质量门槛和策略引擎处理。
- 用户可配置日/周/月周期以及 20–1000 根分析数量；默认 200 根。支撑阻力窗口等于分析数量，量能和突破阈值属于内部策略常量。
- Tab 导航会清理旧候选和框选；异步分析完成前如果页面已切换，本次结果会被拒绝。
- 框选范围用于交互确认；未获得图表坐标轴映射时，不以像素坐标裁切时间范围。
- Manifest 已拆分为 `manifest.dev.json` 与 `manifest.prod.json`：开发清单保留本地测试页，生产清单只允许三个支持站点及 Binance、同花顺公开行情接口。`npm run build`、真实站点 E2E 和发布 ZIP 均强制使用生产清单，审计会拒绝 localhost、127.0.0.1 或清单错配。
- 发布门禁会在真实 Chrome Side Panel 中分别打开 Binance BTC/USDT 与同花顺 600519，验证 Popup、200/64 根 K 线分析、图表、Tab 绑定、响应式缩放和重置；商店截图只从这两条最新主题验收产物生成。
- `PRIVACY.md` 与 `docs/WEB_STORE_LISTING.md` 记录实际数据边界、权限理由、Web Store Privacy practices 填写口径和 Limited Use 声明；产品 UI 同步提示行情及分析结果不上传开发者服务器。

## 下一阶段

1. 为各站点建立脱敏真实行情 fixtures，并覆盖协议变化、超时、限流和异常响应。
2. 增加完整 Chrome 扩展 E2E，覆盖 Tab 切换、扩展重载和快速连续修改配置。
3. 将页面桥接升级为更强的来源校验机制，降低宿主页伪造候选行情的风险。
4. 基于分市场、分周期的真实样本校准维科夫阈值，并建立策略版本号。
5. 在真实性能数据证明有必要时，再将分析迁移到 Web Worker。
