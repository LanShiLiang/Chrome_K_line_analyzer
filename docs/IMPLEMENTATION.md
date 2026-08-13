# 实现说明

## 决策记录

| 决策     | 实现                                                                     | 原因                                                       |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| UI 宿主  | Chrome Side Panel                                                        | 不改变目标网站 DOM 布局，并可与行情图并排操作              |
| 数据捕获 | `document_start` 主世界 WebSocket Hook                                   | 行情站点以长连接推送为主；只读监听不修改宿主帧             |
| 构建边界 | UI/Service Worker 使用 ESM；MAIN/ISOLATED Content Script 分别构建为 IIFE | Manifest Content Script 不能直接执行带静态 `import` 的产物 |
| 适配方式 | TradingView/Binance WebSocket 适配器 + 通用 OHLCV 归一化                 | 协议解析与策略数据模型解耦，便于按站点独立回归             |
| 策略计算 | 纯函数                                                                   | 可测试、可复现、可迁移到 Web Worker                        |
| 数据存储 | Chrome Storage 配置；运行数据按 Tab 内存保存                             | 避免保存原始响应和敏感数据                                 |

## 当前边界

- 当前版本只采集 WebSocket 行情，不再采集 Fetch/XHR。
- TradingView 适配器解析长度前缀帧中的 `timescale_update`/`du` K 线批次；该站点协议不是公开稳定 API，升级后需用脱敏帧样本回归。
- Binance 适配器支持官方 Kline 原始流与 combined stream 消息结构；实时流会按时间戳增量合并。
- 插件安装、重新加载或重新构建后必须刷新目标行情页，确保 Hook 在站点创建 WebSocket 连接之前运行。
- `npm run build` 会把 UI、Content Script 和 MAIN world 注入脚本并行构建到隔离临时目录；只有版本、引用可达性、敏感文件和脚本格式审计全部通过，才会整体替换 `dist`。如果出现残留文件、缺失依赖或 Content Script ESM 语法，构建直接失败并保留上一份产物。
- 通用解析器优先识别数组和对象 OHLCV；复杂嵌套响应需增加站点适配器。
- 框选范围用于交互确认；未获得图表坐标轴映射时，不以像素坐标裁切时间范围。
- 正式发布前应将 Manifest 的宽域名权限替换为已验收站点白名单。

## 下一阶段

1. 确定首批两个行情网站并添加独立 Adapter 与 fixtures。
2. 增加 IndexedDB 分析历史和诊断包导出。
3. 增加 Playwright 扩展 E2E 与 Mock 行情页面。
4. 基于真实样本校准维科夫阈值，并建立策略版本号。
