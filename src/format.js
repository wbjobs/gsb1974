export const STRATEGIES = [
  {
    id: 'none',
    label: '无策略',
    short: '基线',
    color: '#64748b',
    description: '不注入 Resource Hint，发现资源后直接请求。'
  },
  {
    id: 'dns-prefetch',
    label: 'dns-prefetch',
    short: 'DNS',
    color: '#f59e0b',
    description: '仅提前执行域名解析。'
  },
  {
    id: 'preconnect',
    label: 'preconnect',
    short: '连接',
    color: '#8b5cf6',
    description: '提前建立 DNS、TCP 以及可能的 TLS 连接。'
  },
  {
    id: 'preload',
    label: 'preload',
    short: '预载',
    color: '#2563eb',
    description: '高优先级提前获取当前页面确定需要的资源。'
  },
  {
    id: 'prefetch',
    label: 'prefetch',
    short: '预取',
    color: '#10b981',
    description: '低优先级获取后续可能使用的资源。'
  }
];

export const METRICS = [
  { id: 'elapsedMs', label: '总耗时', unit: 'ms', description: '从注入策略到全部资源完成' },
  { id: 'discoveryToCompleteMs', label: '发现后耗时', unit: 'ms', description: '从业务代码发现资源到全部完成' },
  { id: 'firstByteMs', label: '平均 TTFB', unit: 'ms', description: '每个资源请求开始到首字节的平均值' },
  { id: 'dnsMs', label: 'DNS', unit: 'ms', description: '域名解析阶段平均值' },
  { id: 'connectMs', label: '连接', unit: 'ms', description: 'TCP/TLS 连接阶段平均值' },
  { id: 'requestMs', label: '请求等待', unit: 'ms', description: '请求发送到响应开始的平均值' },
  { id: 'downloadMs', label: '下载', unit: 'ms', description: '首字节到响应结束的平均值' },
  { id: 'longTaskMs', label: '长任务', unit: 'ms', description: '实验期间 PerformanceObserver 捕获的长任务' },
  { id: 'transferBytes', label: '网络传输', unit: 'B', description: 'Resource Timing transferSize 总和' }
];

export function strategyById(id) {
  return STRATEGIES.find(strategy => strategy.id === id) || STRATEGIES[0];
}

export function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

export function formatMs(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return `${formatNumber(value / 1000, 2)} s`;
  return `${formatNumber(value, value < 10 ? 1 : 0)} ms`;
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${formatNumber(value / 1024, 1)} KB`;
  return `${formatNumber(value / 1024 / 1024, 2)} MB`;
}

export function formatMetric(metricId, value) {
  const metric = METRICS.find(item => item.id === metricId);
  if (!metric || value == null) return '—';
  return metric.unit === 'B' ? formatBytes(value) : formatMs(value);
}

export function formatDateTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function downloadBlob(content, filename, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
