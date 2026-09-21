# Resource Hints 策略对比实验台

对比 `preload` / `prefetch` / `preconnect`（含无提示基线与组合策略）的实际加载效果，
用 `PerformanceObserver` 采集、原生 Canvas 可视化，并支持导出报告。

## 运行

```bash
node server.js
# 可选: PORT=3000 CDN_PORT=3001 HOST=127.0.0.1 node server.js
```

- 打开 http://localhost:3000 —— 仪表盘
- 主站 :3000 提供页面与同源资源；:3001 模拟第三方 CDN 源
- 点击 **“运行全部策略”**，5 个策略在隐藏 iframe 中**串行**执行（避免带宽竞争干扰结果）

静态冒烟测试（不需要浏览器/端口）：

```bash
node smoke-test.js
```

## 五种策略

| 策略 | 行为 |
|---|---|
| `none` | 基线，无任何提示 |
| `preconnect` | 提前连接 CDN 源（:3001），复用已完成的“握手” |
| `preload` | 提前高优先级拉取关键 css / js / img |
| `prefetch` | 低优先级预热 `next-page.js`；页面 load 后再注入该脚本验证缓存命中 |
| `combined` | preconnect + preload 叠加 |

测试页固定加载 7 个同源资源 + 2 个跨源资源，服务端注入可控延迟：

- 同源资源各自 250–800ms 的模拟传输延迟（`/res/:name`）
- CDN 对每条 TCP 连接的**首个请求**额外收取 400ms 模拟握手（`X-Simulated-Handshake`），
  keep-alive 上的后续请求不收取 —— 因此 preconnect 的连接预热收益可被稳定观测
- 每次运行 URL 带 `run=<id>` 做缓存隔离；`Cache-Control: max-age=120`
  保证 prefetch 在同一次页面加载内可命中缓存

## 采集与可视化

- 测试页内联脚本通过 `PerformanceObserver({type:'resource', buffered:true})` 采集，
  并补充 `navigation`、`paint` 时序，经 `postMessage` 回传仪表盘
- **对比柱状图**（Canvas）：各策略 load / FCP / next-page 注入到 onload 耗时
- **资源瀑布图**（Canvas）：按资源绘制 `startTime → responseEnd`，
  分段着色排队连接 / 等待 / 下载，标注 cache 命中与 load 事件线；支持按策略切换
- **指标表**：load、FCP、next-page、资源数、相对基线差值、异常数

## 报告导出

- **JSON**：`resource-hints-report-<ts>.json`，含摘要 + 每个策略的完整时序明细
- **CSV**：`resource-hints-waterfall-<ts>.csv`，每个资源一行（阶段时间、transferSize、缓存标记）
- **打印 / 存 PDF**：浏览器原生打印，自带打印样式

## 异常与性能

- iframe 上报 20s 超时 → 该策略标记失败并记录日志，不阻塞其余策略
- 测试页内 `error` 捕获（资源加载失败）、PerformanceObserver 初始化失败降级到
  `getEntriesByType` 快照、12s 兜底上报
- 仪表盘环境自检（PerformanceObserver / Blob / Canvas 可用性）
- 图表 HiDPI 适配（DPR 上限 2）、`requestAnimationFrame` 合帧重绘、resize 防抖、
  每策略资源数上限 100 条、Observer 上报后 disconnect

## 文件

```
server.js          # 双端口服务器 + 测试页生成（零依赖）
public/index.html  # 仪表盘
public/app.js      # 运行器 / Canvas 图表 / 导出
public/style.css
smoke-test.js      # 静态逻辑测试
```
