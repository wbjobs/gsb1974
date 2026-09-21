import {
  METRICS,
  STRATEGIES,
  downloadBlob,
  formatDateTime,
  formatMetric
} from './format.js';
import {
  cancelToken,
  createDefaultConfig,
  detectCapabilities,
  runBenchmark,
  validateConfig
} from './benchmark.js';
import { StrategyChart } from './chart.js';
import { createCsvReport, createHtmlReport, createJsonReport } from './report.js';

const elements = {
  healthStatus: document.querySelector('#healthStatus'),
  iterations: document.querySelector('#iterations'),
  resourceCount: document.querySelector('#resourceCount'),
  delayMs: document.querySelector('#delayMs'),
  sizeKb: document.querySelector('#sizeKb'),
  discoveryDelayMs: document.querySelector('#discoveryDelayMs'),
  concurrency: document.querySelector('#concurrency'),
  runButton: document.querySelector('#runButton'),
  stopButton: document.querySelector('#stopButton'),
  runState: document.querySelector('#runState'),
  progress: document.querySelector('#progress'),
  warningBox: document.querySelector('#warningBox'),
  errorBox: document.querySelector('#errorBox'),
  summaryGrid: document.querySelector('#summaryGrid'),
  metricSelect: document.querySelector('#metricSelect'),
  chartCanvas: document.querySelector('#chartCanvas'),
  chartEmpty: document.querySelector('#chartEmpty'),
  resultBody: document.querySelector('#resultTable tbody')
};

const capabilities = detectCapabilities();
const chart = new StrategyChart(elements.chartCanvas, elements.chartEmpty);
let report = null;
let activeController = null;

initialize();

function initialize() {
  populateMetrics();
  bindEvents();
  renderCapabilityWarnings();
  checkHealth();
}

function populateMetrics() {
  elements.metricSelect.innerHTML = METRICS.map(metric =>
    `<option value="${metric.id}">${metric.label}</option>`
  ).join('');
}

function bindEvents() {
  elements.runButton.addEventListener('click', startRun);
  elements.stopButton.addEventListener('click', () => activeController?.abort());
  elements.metricSelect.addEventListener('change', event => chart.setMetric(event.target.value));

  document.querySelectorAll('.segmented button').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.segmented button').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      chart.setMode(button.dataset.mode);
    });
  });

  document.querySelectorAll('[data-export]').forEach(button => {
    button.addEventListener('click', () => exportReport(button.dataset.export));
  });
}

function readConfig() {
  const config = createDefaultConfig();
  config.iterations = Number(elements.iterations.value);
  config.resourceCount = Number(elements.resourceCount.value);
  config.delayMs = Number(elements.delayMs.value);
  config.sizeBytes = Number(elements.sizeKb.value) * 1024;
  config.discoveryDelayMs = Number(elements.discoveryDelayMs.value);
  config.concurrency = Number(elements.concurrency.value);
  config.strategies = [...document.querySelectorAll('.strategy-picker input:checked')].map(input => input.value);
  return config;
}

function setRunning(running) {
  elements.runButton.disabled = running;
  elements.stopButton.disabled = !running;
  document.querySelectorAll('.controls input, .controls fieldset').forEach(element => {
    element.disabled = running;
  });
  document.querySelectorAll('[data-export]').forEach(button => {
    button.disabled = running || !report;
  });
}

async function startRun() {
  clearNotices();
  const config = readConfig();
  const errors = validateConfig(config);

  if (errors.length) {
    showError(errors.join('；'));
    return;
  }

  report = null;
  activeController = cancelToken();
  setRunning(true);
  elements.progress.value = 0;
  elements.runState.textContent = '运行中：每个策略使用独立源端口，避免连接复用污染';
  renderEmptyResults();

  try {
    report = await runBenchmark(config, {
      signal: activeController.signal,
      onProgress: progress => {
        elements.progress.value = Math.round(progress * 100);
      },
      onTrial: (trial, trials) => {
        elements.runState.textContent = `已完成 ${trials.length} 轮：${trial.strategy} 第 ${trial.iteration} 次，${formatMetric('elapsedMs', trial.metrics.elapsedMs)}`;
      },
      onWarning: warning => appendWarning(`${warning.scope}：${warning.message}`)
    });

    report.trials = report.trials || [];
    if (activeController.signal.aborted) {
      appendWarning('实验已手动停止，报告仅包含已完成试验。');
    }
    renderReport(report);
    elements.runState.textContent = `完成：${formatDateTime(report.createdAt)}`;
  } catch (error) {
    if (error.name === 'AbortError') {
      appendWarning('实验已停止。');
      elements.runState.textContent = '已停止';
    } else {
      showError(`实验失败：${error.message}。请确认通过 npm start 启动，而不是直接打开 file://。`);
      elements.runState.textContent = '运行失败';
    }
  } finally {
    setRunning(false);
    activeController = null;
  }
}

function renderReport(nextReport) {
  report = nextReport;
  chart.setMetric(elements.metricSelect.value);
  chart.setReport(report);
  renderSummary(report);
  renderTable(report);
  renderWarnings(report);
  document.querySelectorAll('[data-export]').forEach(button => {
    button.disabled = false;
  });
}

function renderSummary(nextReport) {
  const fastest = nextReport.strategies.find(item => item.strategyId === nextReport.fastestStrategyId);
  const steadiest = nextReport.strategies.find(item => item.strategyId === nextReport.steadiestStrategyId);
  const baseline = nextReport.strategies.find(item => item.strategyId === nextReport.baselineId);
  const improvement = fastest && baseline
    ? fastest.metricStats.elapsedMs.vsBaseline
    : null;

  const cards = [
    ['最快策略', fastest?.label || '—', `P95 ${formatMetric('elapsedMs', fastest?.metricStats.elapsedMs.p95)}`, 'best'],
    ['相对基线', formatPercent(improvement), `基线：${baseline?.label || '—'}`, improvement > 0 ? 'best' : ''],
    ['最稳定', steadiest?.label || '—', `标准差 ${formatMetric('elapsedMs', steadiest?.metricStats.elapsedMs.stddev)}`, ''],
    ['试验总数', String(nextReport.trials.length), `${nextReport.config.iterations} 次迭代 × ${nextReport.config.strategies.length} 策略`, ''],
    ['资源数量', String(nextReport.config.resourceCount), '每轮均为独立端口源', ''],
    ['异常数量', String(nextReport.warnings.length), '详见报告异常章节', nextReport.warnings.length ? '' : 'best']
  ];

  elements.summaryGrid.innerHTML = cards.map(([label, value, hint, extra]) =>
    `<article class="summary-card ${extra}">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      <div class="hint">${escapeHtml(hint)}</div>
    </article>`
  ).join('');
}

function renderTable(nextReport) {
  elements.resultBody.innerHTML = nextReport.strategies.map(strategy => {
    const stats = strategy.metricStats.elapsedMs;
    const deltaClass = stats.vsBaseline > 0 ? 'delta-positive' : stats.vsBaseline < 0 ? 'delta-negative' : 'delta-neutral';
    return `<tr>
      <td>
        <span class="strategy-name"><span class="dot" style="background:${strategy.color}"></span>${escapeHtml(strategy.label)}</span>
      </td>
      <td>${formatMetric('elapsedMs', stats.median)}</td>
      <td>${formatMetric('elapsedMs', stats.p95)}</td>
      <td>${formatMetric('elapsedMs', stats.min)} / ${formatMetric('elapsedMs', stats.max)}</td>
      <td class="${deltaClass}">${formatPercent(stats.vsBaseline)}</td>
      <td>${strategy.successCount}/${strategy.count}</td>
      <td>${formatMetric('longTaskMs', strategy.metricStats.longTaskMs.median)}</td>
      <td>${strategy.warningCount}</td>
    </tr>`;
  }).join('');
}

function renderEmptyResults() {
  elements.summaryGrid.innerHTML = '';
  elements.resultBody.innerHTML = '';
}

async function exportReport(type) {
  if (!report) return;
  const safeRunId = report.runId.replace(/[^a-z0-9_-]/gi, '_');

  try {
    if (type === 'json') {
      downloadBlob(createJsonReport(report), `${safeRunId}.json`, 'application/json;charset=utf-8');
      return;
    }
    if (type === 'csv') {
      downloadBlob(createCsvReport(report), `${safeRunId}.csv`, 'text/csv;charset=utf-8');
      return;
    }
    const pngBlob = await chart.toPngBlob();
    if (type === 'png') {
      downloadBlob(pngBlob, `${safeRunId}-chart.png`, 'image/png');
      return;
    }
    if (type === 'html') {
      const html = await createHtmlReport(report, pngBlob);
      downloadBlob(html, `${safeRunId}-report.html`, 'text/html;charset=utf-8');
    }
  } catch (error) {
    showError(`导出失败：${escapeHtml(error.message)}`);
  }
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('服务不可用');
    const health = await response.json();
    elements.healthStatus.textContent = `本地实验服务正常 · ${health.activeSessions} 个活动会话`;
    elements.healthStatus.className = 'status-pill ok';
  } catch {
    elements.healthStatus.textContent = '服务不可用：请使用 npm start';
    elements.healthStatus.className = 'status-pill bad';
    showError('无法访问本地实验服务。请运行 npm start 后打开终端输出的 http://127.0.0.1:3000。');
  }
}

function renderCapabilityWarnings() {
  if (!capabilities.supportsCanvas) showError('当前浏览器不支持 Canvas。');
  if (!capabilities.supportsPerformanceObserver) appendWarning('当前浏览器缺少 PerformanceObserver，无法得到完整 Resource Timing。');
  if (!capabilities.supportsResourceTiming) appendWarning('当前浏览器不支持 resource 类型的 PerformanceObserver。');
  if (!capabilities.supportsLongTask) appendWarning('当前浏览器不支持 longtask 观测，长任务指标会降级为 0。');
  if (!capabilities.supportsReportExport) appendWarning('当前浏览器缺少 Blob/URL API，报告导出可能不可用。');
}

function renderWarnings(nextReport) {
  nextReport.warnings.forEach(item => appendWarning(`${item.scope}：${item.message}`));
}

function clearNotices() {
  elements.warningBox.hidden = true;
  elements.warningBox.innerHTML = '';
  elements.errorBox.hidden = true;
  elements.errorBox.innerHTML = '';
}

function appendWarning(message) {
  elements.warningBox.hidden = false;
  const item = document.createElement('div');
  item.textContent = message;
  elements.warningBox.append(item);
}

function showError(message) {
  elements.errorBox.hidden = false;
  elements.errorBox.textContent = message;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '改善 ' : value < 0 ? '劣化 ' : '';
  return `${prefix}${Math.abs(value).toFixed(1)}%`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}
