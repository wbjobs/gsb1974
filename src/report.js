import { METRICS, STRATEGIES, formatDateTime, formatMetric, strategyById } from './format.js';

export function createJsonReport(report) {
  return JSON.stringify(report, null, 2);
}

export function createCsvReport(report) {
  const header = [
    'strategy', 'metric', 'samples', 'median', 'mean', 'p95', 'min', 'max',
    'stddev', 'improvement_vs_baseline_pct', 'success', 'failures'
  ];
  const rows = report.strategies.flatMap(strategy =>
    METRICS.map(metric => {
      const stats = strategy.metricStats[metric.id];
      return [
        strategy.label,
        metric.label,
        stats.count,
        number(stats.median),
        number(stats.mean),
        number(stats.p95),
        number(stats.min),
        number(stats.max),
        number(stats.stddev),
        number(stats.vsBaseline),
        strategy.successCount,
        strategy.failureCount
      ];
    })
  );

  const trialHeader = [
    'iteration', 'strategy', 'success', 'elapsed_ms', 'discovery_to_complete_ms',
    'dns_ms', 'connect_ms', 'request_ms', 'first_byte_ms', 'download_ms',
    'long_task_ms', 'transfer_bytes', 'cache_hits', 'warnings'
  ];

  const trialRows = report.trials.map(trial => [
    trial.iteration,
    trial.strategy,
    trial.success,
    number(trial.metrics.elapsedMs),
    number(trial.metrics.discoveryToCompleteMs),
    number(trial.metrics.dnsMs),
    number(trial.metrics.connectMs),
    number(trial.metrics.requestMs),
    number(trial.metrics.firstByteMs),
    number(trial.metrics.downloadMs),
    number(trial.metrics.longTaskMs),
    number(trial.metrics.transferBytes),
    number(trial.metrics.cacheHits),
    trial.warnings.join(' | ')
  ]);

  return [
    '# Summary',
    toCsvLine(header),
    ...rows.map(toCsvLine),
    '',
    '# Trials',
    toCsvLine(trialHeader),
    ...trialRows.map(toCsvLine)
  ].join('\n');
}

export async function createHtmlReport(report, chart) {
  const chartDataUrl = chart ? await blobToDataUrl(chart) : '';
  const fastest = report.strategies.find(item => item.strategyId === report.fastestStrategyId);
  const steadiest = report.strategies.find(item => item.strategyId === report.steadiestStrategyId);
  const baseline = report.strategies.find(item => item.strategyId === report.baselineId);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Resource Hints 实验报告 ${escapeHtml(report.runId)}</title>
  <style>
    body { margin: 0; padding: 40px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
    main { max-width: 1100px; margin: auto; }
    section { background: white; border: 1px solid #e2e8f0; border-radius: 18px; padding: 24px; margin: 18px 0; }
    h1 { margin: 0 0 8px; } h2 { margin: 0 0 16px; }
    .muted { color: #64748b; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .card { border: 1px solid #e2e8f0; border-radius: 14px; padding: 16px; background: #f8fafc; }
    .card b { display: block; font-size: 24px; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: left; white-space: nowrap; }
    th { background: #f8fafc; }
    .warning { border-left: 4px solid #f59e0b; padding-left: 12px; color: #92400e; }
    img { width: 100%; border: 1px solid #e2e8f0; border-radius: 14px; }
    code { background: #f1f5f9; padding: 2px 5px; border-radius: 5px; }
  </style>
</head>
<body>
<main>
  <h1>Resource Hints 策略对比报告</h1>
  <p class="muted">${escapeHtml(report.runId)} · ${formatDateTime(report.createdAt)}</p>

  <section>
    <h2>结论</h2>
    <div class="grid">
      <div class="card">总耗时最快<b>${escapeHtml(fastest?.label || '—')}</b><span class="muted">中位数 ${formatMetric('elapsedMs', fastest?.metricStats.elapsedMs.median)}</span></div>
      <div class="card">波动最小<b>${escapeHtml(steadiest?.label || '—')}</b><span class="muted">标准差 ${formatMetric('elapsedMs', steadiest?.metricStats.elapsedMs.stddev)}</span></div>
      <div class="card">基线<b>${escapeHtml(baseline?.label || '—')}</b><span class="muted">中位数 ${formatMetric('elapsedMs', baseline?.metricStats.elapsedMs.median)}</span></div>
    </div>
  </section>

  ${chartDataUrl ? `<section><h2>Canvas 图表快照</h2><img alt="策略图表" src="${chartDataUrl}"></section>` : ''}

  <section>
    <h2>实验配置</h2>
    <p>迭代 ${report.config.iterations} 次；每策略 ${report.config.resourceCount} 个独立源资源；并发 ${report.config.concurrency}；发现延迟 ${report.config.discoveryDelayMs} ms；服务端延迟 ${report.config.delayMs} ms；响应 ${report.config.sizeBytes} B。</p>
    <p>策略：${report.config.strategies.map(id => `<code>${escapeHtml(strategyById(id).label)}</code>`).join(' ')}</p>
  </section>

  <section>
    <h2>指标汇总</h2>
    <table>
      <thead><tr><th>策略</th><th>总耗时中位数</th><th>P95</th><th>相对基线</th><th>平均 DNS</th><th>平均连接</th><th>平均下载</th><th>成功/失败</th></tr></thead>
      <tbody>
        ${report.strategies.map(strategy => `<tr>
          <td>${escapeHtml(strategy.label)}</td>
          <td>${formatMetric('elapsedMs', strategy.metricStats.elapsedMs.median)}</td>
          <td>${formatMetric('elapsedMs', strategy.metricStats.elapsedMs.p95)}</td>
          <td>${formatDelta(strategy.metricStats.elapsedMs.vsBaseline)}</td>
          <td>${formatMetric('dnsMs', strategy.metricStats.dnsMs.median)}</td>
          <td>${formatMetric('connectMs', strategy.metricStats.connectMs.median)}</td>
          <td>${formatMetric('downloadMs', strategy.metricStats.downloadMs.median)}</td>
          <td>${strategy.successCount}/${strategy.failureCount}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>全部指标</h2>
    <table>
      <thead><tr><th>策略</th>${METRICS.map(metric => `<th>${escapeHtml(metric.label)}</th>`).join('')}</tr></thead>
      <tbody>
        ${report.strategies.map(strategy => `<tr>
          <td>${escapeHtml(strategy.label)}</td>
          ${METRICS.map(metric => `<td>${formatMetric(metric.id, strategy.metricStats[metric.id].median)}</td>`).join('')}
        </tr>`).join('')}
      </tbody>
    </table>
  </section>

  <section>
    <h2>异常与限制</h2>
    ${report.warnings.length ? `<ul>${report.warnings.map(item => `<li class="warning">${escapeHtml(item.scope)}：${escapeHtml(item.message)}</li>`).join('')}</ul>` : '<p>未捕获运行时警告。</p>'}
    <p class="muted">User Agent: ${escapeHtml(report.environment.userAgent)}</p>
  </section>
</main>
</body>
</html>`;
}

function toCsvLine(values) {
  return values.map(value => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',');
}

function number(value) {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function formatDelta(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
