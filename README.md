# Resource Hints 策略对比实验室

一个零运行时依赖的本地 Web 应用，用于对比 `none`、`dns-prefetch`、`preconnect`、`preload`、`prefetch` 的实际效果，并通过 Canvas 展示和导出报告。

## 启动

```bash
npm start
```

然后打开终端输出的地址：

```text
http://127.0.0.1:3000
```

要求 Node.js 18+。不要直接用 `file://` 打开页面，否则无法创建本地实验端点。

## 功能

- 策略：支持无策略、`dns-prefetch`、`preconnect`、`preload`、`prefetch`。
- 对比：每个策略按随机顺序执行多轮，输出中位数、P95、最小/最大值、标准差和相对基线变化。
- 可视化：Canvas 提供耗时对比、中位数资源时间线、稳定性三种视图，支持悬浮详情和 PNG 导出。
- 报告：可导出 JSON、CSV、PNG 和单文件 HTML 报告；HTML 内嵌图表和异常信息，可离线查看。
- 性能：资源池限制并发，默认每轮 8 个资源、8 并发；连接类策略每资源一个独立源，获取类策略每轮一个独立源。
- 异常：覆盖服务不可用、请求失败、超时、用户停止、PerformanceObserver/Long Task 不支持、opaque Resource Timing、捕获条目缺失等情况。

## 实验设计

每次点击“开始对比”时，前端会向 Node 服务申请一次性实验会话：

- `dns-prefetch`、`preconnect`：为每个资源创建独立临时 HTTP 端口，避免连接池复用。
- `preload`、`prefetch`：每轮使用一个独立临时端口，端口内通过不同资源路径区分资源。
- 每轮只注入当前策略的 Resource Hint。
- 策略顺序随机，降低固定执行顺序和系统抖动带来的偏差。
- 每轮先注入提示，再等待“发现延迟”，模拟页面稍后才发现关键资源。
- 使用 `PerformanceObserver({ type: 'resource', buffered: true })` 和 `longtask` 采集真实浏览器条目。
- 服务端返回 `Timing-Allow-Origin: *`，避免跨源 Resource Timing 变成 opaque 数据。

本地回环无法真实模拟公网 DNS、TLS 和拥塞，因此：

- `dns-prefetch` 在本地可能几乎没有差异。
- `preconnect` 通常更容易观察到连接阶段提前。
- `preload`/`prefetch` 会体现“提前发现资源”的收益，但浏览器优先级和缓存策略仍可能不同。

## 指标

- 总耗时：从注入提示到所有业务资源完成。
- 发现后耗时：从业务代码开始加载资源到全部完成。
- DNS、连接、请求等待、TTFB、下载：Resource Timing 的资源平均值。
- 长任务：实验期间 Long Task 总时长。
- 网络传输：`transferSize` 总和；缓存命中时可能为 0。

## 验收对照

- 不同策略效果可对比：表格和 Canvas 同时展示中位数、P95、范围与相对基线。
- 可视化准确：时间线来自 Resource Timing 的绝对阶段时间，并使用独立端口避免连接复用污染。
- 报告可导出：JSON、CSV、PNG、HTML 四种导出方式均可离线保存。
- 性能可接受：默认 3 轮 × 5 策略 × 8 资源，创建 57 个临时端口，请求池并发为 8；服务端会话 10 分钟后自动回收。
- 异常可处理：请求失败、停止、不支持的观测 API、opaque timing、缺失条目都会进入警告区域和报告。

## 开发检查

```bash
npm run check
```

该命令只做 JavaScript 语法检查，不依赖测试框架。
