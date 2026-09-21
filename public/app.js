'use strict';

/* -----------------------------------------------------------
 * Resource Hints 策略对比实验台
 * 策略: none / preconnect / preload / prefetch / combined
 * 采集: iframe 内 PerformanceObserver -> postMessage
 * 可视化: 原生 Canvas (对比柱状图 + 资源瀑布图)
 * --------------------------------------------------------- */

var STRATEGIES = [
  { id: 'none', label: '无提示(基线)' },
  { id: 'preconnect', label: 'preconnect' },
  { id: 'preload', label: 'preload' },
  { id: 'prefetch', label: 'prefetch' },
  { id: 'combined', label: '组合策略' }
];

var RUN_TIMEOUT_MS = 20000;
var MAX_RESOURCES = 100;

var state = {
  results: {},
  order: [],
  running: false,
  selected: null,
  runCounter: 0
};

var el = {
  run: document.getElementById('btn-run'),
  rerun: document.getElementById('btn-rerun'),
  json: document.getElementById('btn-export-json'),
  csv: document.getElementById('btn-export-csv'),
  print: document.getElementById('btn-print'),
  status: document.getElementById('run-status'),
  bars: document.getElementById('chart-bars'),
  waterfall: document.getElementById('chart-waterfall'),
  metrics: document.getElementById('metrics-table'),
  tabs: document.getElementById('strategy-tabs'),
  errors: document.getElementById('error-log'),
  harness: document.getElementById('harness')
};

var pending = {};

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

function logError(message, isInfo) {
  var muted = el.errors.querySelector('.muted');
  if (muted) muted.remove();
  var row = document.createElement('div');
  row.className = 'entry' + (isInfo ? ' info' : '');
  row.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
  el.errors.insertBefore(row, el.errors.firstChild);
}

function strategyLabel(id) {
  for (var i = 0; i < STRATEGIES.length; i++) {
    if (STRATEGIES[i].id === id) return STRATEGIES[i].label;
  }
  return id;
}

function isCdn(name) {
  return /\/cdn\//.test(name) || name.indexOf('api.js') !== -1 || name.indexOf('avatar') !== -1;
}

function resourceKind(r) {
  if (isCdn(r.name)) return 'cdn';
  if (/\.css($|\?)/.test(r.name) || r.initiatorType === 'css') return 'css';
  if (/\.js($|\?)/.test(r.name) || r.initiatorType === 'script') return 'js';
  if (r.initiatorType === 'img' || /\.(svg|png|jpg|jpeg|gif|webp)($|\?)/.test(r.name)) return 'img';
  return 'js';
}

var KIND_COLOR = {
  css: '#4ea8ff',
  js: '#f0b429',
  img: '#58d68d',
  cdn: '#b07cff'
};

/* ---------------- runner: 串行运行策略，避免带宽竞争 ---------------- */

window.addEventListener('message', function (ev) {
  var data = ev.data;
  if (!data || data.type !== 'strategy-result' || !pending[data.runId]) return;
  var ctx = pending[data.runId];
  clearTimeout(ctx.timer);
  delete pending[data.runId];
  try {
    ctx.resolve(data.payload || {});
  } catch (err) {
    logError('解析结果失败 (' + ctx.strategy + '): ' + err.message);
    ctx.resolve({ strategy: ctx.strategy, resources: [], errors: ['结果解析异常: ' + err.message] });
  }
});

function runStrategy(strategy) {
  return new Promise(function (resolve) {
    var runId = 'r' + (++state.runCounter) + '-' + Date.now();
    var timer = setTimeout(function () {
      if (!pending[runId]) return;
      delete pending[runId];
      try { el.harness.src = 'about:blank'; } catch (e) {}
      logError(strategy + ' 策略运行超时 (' + RUN_TIMEOUT_MS + 'ms)，标记为失败');
      resolve({
        strategy: strategy,
        resources: [],
        errors: ['运行超时 ' + RUN_TIMEOUT_MS + 'ms'],
        navigation: null,
        paint: {},
        prefetchProbe: null
      });
    }, RUN_TIMEOUT_MS);

    pending[runId] = { strategy: strategy, timer: timer, resolve: resolve };
    try {
      el.harness.src = '/test?strategy=' + encodeURIComponent(strategy) + '&run=' + runId;
    } catch (err) {
      clearTimeout(timer);
      delete pending[runId];
      logError('无法启动 iframe (' + strategy + '): ' + err.message);
      resolve({ strategy: strategy, resources: [], errors: [err.message] });
    }
  });
}

function normalizeResult(payload) {
  var resources = Array.isArray(payload.resources) ? payload.resources.slice(0, MAX_RESOURCES) : [];
  var errors = Array.isArray(payload.errors) ? payload.errors.slice() : [];
  var nav = payload.navigation || null;
  var probe = payload.prefetchProbe || null;

  var loadMs = nav ? nav.loadEventEnd : null;
  if (loadMs == null) {
    resources.forEach(function (r) {
      var end = (r.responseEnd || r.startTime + (r.duration || 0));
      if (end > (loadMs || 0)) loadMs = end;
    });
  }

  return {
    strategy: payload.strategy,
    finishedAt: new Date().toISOString(),
    loadMs: loadMs != null ? Math.round(loadMs) : null,
    fcpMs: payload.paint && payload.paint['first-contentful-paint'] != null
      ? Math.round(payload.paint['first-contentful-paint']) : null,
    nextPageMs: probe && probe.injectToOnloadMs != null ? probe.injectToOnloadMs : null,
    nextPageFromCache: probe ? !!probe.servedFromCache : false,
    resourceCount: resources.length,
    errorCount: errors.length,
    observerSupported: payload.observerSupported !== false,
    resources: resources,
    errors: errors,
    navigation: nav,
    paint: payload.paint || {},
    prefetchProbe: probe
  };
}

function runAll(strategyList) {
  if (state.running) return Promise.resolve();
  state.running = true;
  updateButtons();
  var list = strategyList || STRATEGIES.map(function (s) { return s.id; });

  function next(index) {
    if (index >= list.length) return Promise.resolve();
    var s = list[index];
    setStatus('正在运行策略: ' + strategyLabel(s) + ' (' + (index + 1) + '/' + list.length + ')', 'running');
    return runStrategy(s).then(function (payload) {
      var result = normalizeResult(payload);
      storeResult(s, result);
      if (result.errors.length) {
        result.errors.forEach(function (msg) { logError('[' + s + '] ' + msg); });
      }
      if (!result.observerSupported) {
        logError('[' + s + '] 浏览器不支持 PerformanceObserver，数据可能不完整', false);
      }
      renderAll(s);
      return next(index + 1);
    });
  }

  return next(0).then(function () {
    state.running = false;
    var failed = list.filter(function (s) { return state.results[s] && state.results[s].errorCount > 0; }).length;
    setStatus(failed ? '完成，但有 ' + failed + ' 个策略出现异常，请查看异常日志。' : '全部策略运行完成，可对比或导出报告。',
      failed ? 'error' : 'done');
    updateButtons();
  }).catch(function (err) {
    state.running = false;
    updateButtons();
    setStatus('运行失败: ' + err.message, 'error');
    logError('runAll 异常: ' + err.message);
  });
}

function storeResult(strategy, result) {
  state.results[strategy] = result;
  if (state.order.indexOf(strategy) === -1) state.order.push(strategy);
  if (!state.selected) state.selected = strategy;
}

/* ---------------- Canvas 基础工具 (HiDPI) ---------------- */

function prepareCanvas(canvas) {
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var rect = canvas.getBoundingClientRect();
  var cssWidth = Math.max(320, rect.width);
  // rect.height 是布局(CSS)高度；canvas.height 已含 DPR，不能直接用，否则会逐帧倍增
  var cssHeight = rect.height || parseInt(canvas.getAttribute('height'), 10) || 260;
  var targetW = Math.round(cssWidth * dpr);
  var targetH = Math.round(cssHeight * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#161d2e';
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.font = '12px -apple-system, Segoe UI, sans-serif';
  ctx.textBaseline = 'middle';
  return { ctx: ctx, w: cssWidth, h: cssHeight };
}

function niceMax(value) {
  if (!isFinite(value) || value <= 0) return 100;
  var pow = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
  var n = value / pow;
  var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

/* ---------------- 对比柱状图 ---------------- */

function drawBars() {
  var c;
  try {
    c = prepareCanvas(el.bars);
  } catch (err) {
    logError('对比图渲染失败: ' + err.message);
    return;
  }
  var ctx = c.ctx, w = c.w, h = c.h;
  var ids = STRATEGIES.map(function (s) { return s.id; }).filter(function (id) { return state.results[id]; });
  if (!ids.length) {
    drawEmpty(ctx, w, h, '暂无数据，请先运行策略');
    return;
  }

  var padL = 70, padR = 16, padT = 28, padB = 46;
  var plotW = w - padL - padR;
  var plotH = h - padT - padB;

  var series = [
    { key: 'loadMs', name: 'load (ms)', color: '#4ea8ff' },
    { key: 'fcpMs', name: 'FCP (ms)', color: '#58d68d' },
    { key: 'nextPageMs', name: 'next-page (ms)', color: '#f0b429' }
  ];

  var maxV = 0;
  ids.forEach(function (id) {
    var r = state.results[id];
    series.forEach(function (s) {
      if (typeof r[s.key] === 'number' && r[s.key] > maxV) maxV = r[s.key];
    });
  });
  maxV = niceMax(maxV);

  // 网格 + y 轴刻度
  ctx.strokeStyle = '#243049';
  ctx.fillStyle = '#6f7c97';
  var ticks = 5;
  for (var t = 0; t <= ticks; t++) {
    var y = padT + plotH - (plotH * t / ticks);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxV * t / ticks) + '', padL - 8, y);
  }

  var groupW = plotW / ids.length;
  var barW = Math.min(26, groupW / (series.length + 2));

  ids.forEach(function (id, i) {
    var r = state.results[id];
    var groupX = padL + groupW * i;
    series.forEach(function (s, j) {
      var val = r[s.key];
      var x = groupX + groupW / 2 - (series.length * barW) / 2 + j * (barW + 2);
      var bh = typeof val === 'number' ? Math.max(1, plotH * val / maxV) : 0;
      ctx.fillStyle = val == null ? '#2a3550' : s.color;
      ctx.fillRect(x, padT + plotH - bh, barW, bh);
      if (typeof val === 'number') {
        ctx.fillStyle = '#cdd7ec';
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(val) + '', x + barW / 2, padT + plotH - bh - 8);
      }
    });
    ctx.fillStyle = r.errorCount ? '#ff9a9a' : '#cdd7ec';
    ctx.textAlign = 'center';
    ctx.fillText(strategyLabel(id), groupX + groupW / 2, h - padB + 18);
  });

  // 图例
  series.forEach(function (s, i) {
    var lx = padL + i * 130;
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 8, 10, 10);
    ctx.fillStyle = '#8b97b0';
    ctx.textAlign = 'left';
    ctx.fillText(s.name, lx + 15, 13);
  });
}

function drawEmpty(ctx, w, h, text) {
  ctx.fillStyle = '#6f7c97';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2);
}

/* ---------------- 瀑布图 (分阶段) ---------------- */

function shade(hex, factor) {
  var n = parseInt(hex.slice(1), 16);
  var r = Math.round(((n >> 16) & 255) * factor);
  var g = Math.round(((n >> 8) & 255) * factor);
  var b = Math.round((n & 255) * factor);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function drawWaterfall() {
  var c;
  try {
    c = prepareCanvas(el.waterfall);
  } catch (catchErr) {
    logError('瀑布图渲染失败: ' + catchErr.message);
    return;
  }
  var ctx = c.ctx, w = c.w, h = c.h;
  var result = state.selected ? state.results[state.selected] : null;
  if (!result) {
    drawEmpty(ctx, w, h, '选择一个策略查看其资源瀑布');
    return;
  }

  var padL = 150, padR = 46, padT = 14, padB = 34;
  var plotW = w - padL - padR;
  var resources = result.resources.slice(0, MAX_RESOURCES);
  if (!resources.length) {
    drawEmpty(ctx, w, h, result.errorCount ? '该策略运行失败，无资源数据' : '没有采集到资源');
    return;
  }
  var rowH = Math.min(26, (h - padT - padB) / resources.length);
  var barH = Math.max(8, rowH - 8);

  var maxEnd = 0;
  resources.forEach(function (res) {
    var end = res.responseEnd || res.startTime + (res.duration || 0);
    if (end > maxEnd) maxEnd = end;
  });
  if (result.loadMs) maxEnd = Math.max(maxEnd, result.loadMs);
  maxEnd = niceMax(maxEnd * 1.05);
  var xOf = function (ms) { return padL + plotW * ms / maxEnd; };

  ctx.strokeStyle = '#243049';
  ctx.fillStyle = '#6f7c97';
  for (var t = 0; t <= 6; t++) {
    var ms = maxEnd * t / 6;
    var x = xOf(ms);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, h - padB);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(ms) + 'ms', x, h - padB + 16);
  }

  resources.forEach(function (res, i) {
    var y = padT + i * rowH;
    var start = res.startTime || 0;
    var end = res.responseEnd || start + (res.duration || 0);
    var reqStart = res.requestStart && res.requestStart > start ? res.requestStart : start;
    var respStart = res.responseStart && res.responseStart >= reqStart ? res.responseStart : reqStart;
    var kind = resourceKind(res);
    var color = KIND_COLOR[kind] || '#8b97b0';

    ctx.textAlign = 'right';
    ctx.fillStyle = '#a9b6d0';
    var name = res.name.length > 24 ? '…' + res.name.slice(-23) : res.name;
    ctx.fillText(name, padL - 8, y + barH / 2);

    // 排队/连接阶段 (start -> requestStart): 深色
    fillBar(ctx, xOf(start), xOf(reqStart), y, barH, shade(color, 0.45));
    // 等待响应 (requestStart -> responseStart): 中色
    fillBar(ctx, xOf(reqStart), xOf(respStart), y, barH, shade(color, 0.75));
    // 下载 (responseStart -> responseEnd): 正色
    fillBar(ctx, xOf(respStart), xOf(end), y, barH, color);

    // 总耗时标签
    var dur = Math.round((end - start) * 10) / 10;
    if (xOf(end) + 44 < w) {
      ctx.fillStyle = '#8b97b0';
      ctx.textAlign = 'left';
      ctx.fillText(dur + 'ms', Math.min(xOf(end) + 4, w - padR - 38), y + barH / 2);
    }

    // 缓存命中标记
    if (res.fromCache === true) {
      ctx.fillStyle = '#58d68d';
      ctx.textAlign = 'left';
      ctx.fillText('cache', xOf(start) + 2, y + barH / 2);
    }
  });

  // load 事件线
  if (result.loadMs) {
    var lx = xOf(result.loadMs);
    ctx.strokeStyle = '#ff6b6b';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(lx, padT);
    ctx.lineTo(lx, padT + resources.length * rowH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ff9a9a';
    ctx.textAlign = 'center';
    ctx.fillText('load ' + Math.round(result.loadMs) + 'ms', lx, padT - 6 > 4 ? padT - 4 : padT + 4);
  }
}

function fillBar(ctx, x1, x2, y, barH, color) {
  if (x2 - x1 < 0.5) return;
  ctx.fillStyle = color;
  ctx.fillRect(x1, y, Math.max(1, x2 - x1), barH);
}

/* ---------------- 指标表 / 标签页 / 导出 ---------------- */

function renderMetrics() {
  var ids = STRATEGIES.map(function (s) { return s.id; }).filter(function (id) { return state.results[id]; });
  if (!ids.length) {
    el.metrics.innerHTML = '<p class="muted">尚未运行。</p>';
    return;
  }

  var baseline = state.results.none || null;
  var rows = ids.map(function (id) {
    var r = state.results[id];
    var diff = baseline && r.loadMs != null && baseline.loadMs != null ? r.loadMs - baseline.loadMs : null;
    var diffCell = diff == null ? '—'
      : (diff <= -1 ? '<td class="good">▼ ' + Math.abs(Math.round(diff)) + 'ms</td>'
        : diff >= 1 ? '<td class="bad">▲ ' + Math.round(diff) + 'ms</td>'
        : '<td>±0ms</td>');
    var cacheCell = r.nextPageMs == null ? '—'
      : Math.round(r.nextPageMs) + 'ms' + (r.nextPageFromCache ? ' <span class="good">⚡缓存</span>' : '');
    return '<tr class="' + (state.selected === id ? 'active' : '') + '">' +
      '<td>' + strategyLabel(id) + '</td>' +
      '<td>' + (r.loadMs != null ? Math.round(r.loadMs) : '—') + '</td>' +
      '<td>' + (r.fcpMs != null ? Math.round(r.fcpMs) : '—') + '</td>' +
      '<td>' + cacheCell + '</td>' +
      '<td>' + r.resourceCount + '</td>' +
      diffCell +
      '<td>' + (r.errorCount ? '<span class="bad">' + r.errorCount + '</span>' : '0') + '</td>' +
      '</tr>';
  }).join('');

  el.metrics.innerHTML =
    '<table><thead><tr>' +
    '<th>策略</th><th>load</th><th>FCP</th><th>next-page</th><th>资源数</th><th>vs 基线</th><th>异常</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderTabs() {
  el.tabs.innerHTML = '';
  STRATEGIES.forEach(function (s) {
    var r = state.results[s.id];
    if (!r) return;
    var btn = document.createElement('button');
    btn.textContent = s.label;
    btn.className = (state.selected === s.id ? 'active ' : '') + (r.errorCount ? 'failed' : '');
    btn.addEventListener('click', function () {
      state.selected = s.id;
      renderAll(s.id);
    });
    el.tabs.appendChild(btn);
  });
}

function buildReport() {
  var summary = state.order.map(function (id) {
    var r = state.results[id];
    return {
      strategy: id,
      label: strategyLabel(id),
      loadMs: r.loadMs,
      fcpMs: r.fcpMs,
      nextPageMs: r.nextPageMs,
      nextPageFromCache: r.nextPageFromCache,
      resourceCount: r.resourceCount,
      errorCount: r.errorCount
    };
  });
  return {
    tool: 'resource-hints-lab',
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    summary: summary,
    details: state.results
  };
}

function download(filename, content, mime) {
  try {
    var blob = new Blob([content], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  } catch (err) {
    logError('导出失败: ' + err.message);
    setStatus('导出失败: ' + err.message, 'error');
  }
}

function exportJSON() {
  download('resource-hints-report-' + Date.now() + '.json',
    JSON.stringify(buildReport(), null, 2), 'application/json');
}

function exportCSV() {
  var header = ['strategy', 'resource', 'kind', 'initiatorType', 'startTimeMs',
    'requestStartMs', 'responseStartMs', 'responseEndMs', 'durationMs',
    'transferSize', 'fromCache'];
  var lines = [header.join(',')];
  function esc(v) {
    if (v == null) return '';
    return '"' + String(v).replace(/"/g, '""') + '"';
  }
  state.order.forEach(function (id) {
    var r = state.results[id];
    r.resources.forEach(function (res) {
      lines.push([
        esc(id), esc(res.name), esc(resourceKind(res)), esc(res.initiatorType),
        res.startTime, res.requestStart || '', res.responseStart || '',
        res.responseEnd || '', res.duration,
        res.transferSize == null ? '' : res.transferSize,
        res.fromCache == null ? '' : res.fromCache
      ].join(','));
    });
    if (!r.resources.length) {
      lines.push([esc(id), esc('(no resources)'), '', '', '', '', '', '', '', '', ''].join(','));
    }
  });
  download('resource-hints-waterfall-' + Date.now() + '.csv',
    lines.join('\n'), 'text/csv;charset=utf-8');
}

/* ---------------- 渲染调度 & 事件 ---------------- */

var rafPending = false;
function renderAll(keepSelection) {
  if (keepSelection && state.results[keepSelection]) state.selected = keepSelection;
  renderMetrics();
  renderTabs();
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(function () {
    rafPending = false;
    try {
      drawBars();
      drawWaterfall();
    } catch (err) {
      logError('图表渲染异常: ' + err.message);
    }
  });
}

function hasResults() {
  return state.order.length > 0;
}

function updateButtons() {
  el.run.disabled = state.running;
  el.rerun.disabled = state.running || !state.selected;
  el.json.disabled = state.running || !hasResults();
  el.csv.disabled = state.running || !hasResults();
  el.print.disabled = !hasResults();
}

el.run.addEventListener('click', function () {
  el.errors.innerHTML = '<p class="muted">无异常。</p>';
  state.results = {};
  state.order = [];
  state.selected = null;
  renderAll();
  updateButtons();
  runAll();
});

el.rerun.addEventListener('click', function () {
  if (state.selected) runAll([state.selected]);
});

el.json.addEventListener('click', exportJSON);
el.csv.addEventListener('click', exportCSV);
el.print.addEventListener('click', function () { window.print(); });

var resizeTimer = null;
window.addEventListener('resize', function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () { renderAll(); }, 120);
});

// 环境自检
(function bootChecks() {
  var problems = [];
  if (typeof PerformanceObserver === 'undefined') problems.push('当前浏览器不支持 PerformanceObserver');
  if (!window.URL || !URL.createObjectURL) problems.push('当前浏览器不支持 Blob 导出');
  problems.forEach(function (p) { logError(p); });
  if (!problems.length) logError('环境自检通过：PerformanceObserver / Blob / Canvas 可用', true);
  drawBars();
  drawWaterfall();
  updateButtons();
})();
