import { METRICS, STRATEGIES, strategyById } from './format.js';

const DEFAULT_CONFIG = {
  iterations: 3,
  resourceCount: 8,
  delayMs: 120,
  sizeBytes: 1024,
  discoveryDelayMs: 180,
  concurrency: 8,
  strategies: STRATEGIES.map(item => item.id)
};

const MAX_TRIALS = 30;
const MAX_TRIAL_RESOURCES = 120;

export function createDefaultConfig() {
  return { ...DEFAULT_CONFIG, strategies: [...DEFAULT_CONFIG.strategies] };
}

export function detectCapabilities() {
  const supportsPerformanceObserver = 'PerformanceObserver' in window;
  const supportsResourceTiming =
    'PerformanceObserver' in window &&
    PerformanceObserver.supportedEntryTypes &&
    PerformanceObserver.supportedEntryTypes.includes('resource');
  const supportsLongTask =
    'PerformanceObserver' in window &&
    PerformanceObserver.supportedEntryTypes &&
    PerformanceObserver.supportedEntryTypes.includes('longtask');
  const supportsFetch = 'fetch' in window && 'AbortController' in window;

  return {
    supportsFetch,
    supportsPerformanceObserver,
    supportsResourceTiming,
    supportsLongTask,
    supportsCanvas: typeof document.createElement('canvas').getContext === 'function',
    supportsReportExport:
      'Blob' in window && 'URL' in window && typeof URL.createObjectURL === 'function'
  };
}

export function validateConfig(config) {
  const errors = [];
  const iterations = Number(config.iterations);
  const resourceCount = Number(config.resourceCount);
  const concurrency = Number(config.concurrency);

  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10) {
    errors.push('迭代次数必须为 1 到 10 的整数。');
  }
  if (!Number.isInteger(resourceCount) || resourceCount < 1 || resourceCount > 60) {
    errors.push('每策略资源数必须为 1 到 60 的整数。');
  }
  const trialCount = iterations * (Array.isArray(config.strategies) ? config.strategies.length : 0);
  if (trialCount > 0 && resourceCount * trialCount > MAX_TRIAL_RESOURCES) {
    errors.push(`为控制本地性能，独立源总数不能超过 ${MAX_TRIAL_RESOURCES}；请减少迭代数、策略数或资源数。`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    errors.push('并发请求必须为 1 到 64 的整数。');
  }
  if (!Number.isFinite(Number(config.delayMs)) || config.delayMs < 0 || config.delayMs > 3000) {
    errors.push('服务端延迟必须为 0 到 3000 毫秒。');
  }
  if (!Number.isFinite(Number(config.discoveryDelayMs)) || config.discoveryDelayMs < 0 || config.discoveryDelayMs > 2000) {
    errors.push('发现延迟必须为 0 到 2000 毫秒。');
  }
  if (!Number.isFinite(Number(config.sizeBytes)) || config.sizeBytes < 0 || config.sizeBytes > 262144) {
    errors.push('响应体积必须为 0 到 256 KB。');
  }
  if (!Array.isArray(config.strategies) || config.strategies.length < 2) {
    errors.push('至少选择两个策略才能对比。');
  }
  const invalid = config.strategies.filter(id => !STRATEGIES.some(item => item.id === id));
  if (invalid.length) errors.push(`存在未知策略：${invalid.join(', ')}`);
  if (iterations * (config.strategies?.length || 0) > MAX_TRIALS) {
    errors.push(`单次最多运行 ${MAX_TRIALS} 个策略试验。`);
  }
  return errors;
}

export async function runBenchmark(inputConfig, callbacks = {}) {
  const config = normalizeConfig(inputConfig);
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join(' '));

  const capabilities = detectCapabilities();
  if (!capabilities.supportsFetch) {
    throw new Error('当前浏览器不支持 fetch 或 AbortController，无法运行真实网络实验。');
  }

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`;
  const totalTrials = config.iterations * config.strategies.length;
  const session = await createLocalSession(totalTrials, config);
  const trials = [];
  const warnings = new Map();

  const addWarning = (scope, message) => {
    const key = `${scope}:${message}`;
    warnings.set(key, { scope, message });
    callbacks.onWarning?.({ scope, message });
  };

  if (!capabilities.supportsPerformanceObserver) {
    addWarning('browser', 'PerformanceObserver 不可用，网络阶段数据将使用总耗时降级估算。');
  } else if (!capabilities.supportsResourceTiming) {
    addWarning('browser', 'Resource Timing 不可用，网络阶段数据将使用总耗时降级估算。');
  }
  if (!capabilities.supportsLongTask) {
    addWarning('browser', 'Long Task 观测不可用，长任务指标将显示为 0。');
  }

  try {
    for (let iteration = 0; iteration < config.iterations; iteration += 1) {
      const orderedStrategies = shuffled(config.strategies);
      for (const strategyId of orderedStrategies) {
        const requiredTargets = (strategyId === 'dns-prefetch' || strategyId === 'preconnect')
          ? config.resourceCount
          : 1;
        const targetServers = session.targets.splice(0, requiredTargets);
        if (targetServers.length < requiredTargets) {
          throw new Error('本地实验端点数量不足，请减少迭代数或资源数。');
        }
        const targets = buildStrategyTargets(strategyId, targetServers, config.resourceCount);

        try {
          const trial = await runTrial({
            runId,
            iteration: iteration + 1,
            strategyId,
            targets,
            config,
            capabilities,
            addWarning,
            signal: callbacks.signal
          });
          trials.push(trial);
          callbacks.onTrial?.(trial, trials);
          callbacks.onProgress?.(trials.length / totalTrials, trial);
        } catch (error) {
          if (error.name === 'AbortError') break;
          throw error;
        }
      }
    }

    const summary = aggregateResults({ runId, config, trials, capabilities, warnings: [...warnings.values()] });
    if (callbacks.signal?.aborted) summary.cancelled = true;
    return summary;
  } finally {
    await new Promise(resolve => setTimeout(resolve, 100));
    await closeLocalSession(session.id);
  }
}

export function cancelToken() {
  const controller = new AbortController();
  return controller;
}

function normalizeConfig(input) {
  const config = { ...DEFAULT_CONFIG, ...input };
  config.iterations = Number(config.iterations);
  config.resourceCount = Number(config.resourceCount);
  config.delayMs = Number(config.delayMs);
  config.sizeBytes = Number(config.sizeBytes);
  config.discoveryDelayMs = Number(config.discoveryDelayMs);
  config.concurrency = Number(config.concurrency);
  config.strategies = [...new Set(input.strategies || DEFAULT_CONFIG.strategies)];
  return config;
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

async function createLocalSession(config) {
  const count = config.strategies.reduce((sum, strategyId) => {
    const needsResourceOrigin = strategyId === 'dns-prefetch' || strategyId === 'preconnect';
    return sum + (needsResourceOrigin
      ? config.iterations * config.resourceCount
      : config.iterations);
  }, 0);
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      count,
      delayMs: config.delayMs,
      sizeBytes: config.sizeBytes
    })
  });
  if (!response.ok) {
    let message = `实验服务返回 ${response.status}`;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function closeLocalSession(sessionId) {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  } catch {
    // 页面关闭或会话超时会由服务端回收。
  }
}

function buildStrategyTargets(strategyId, targetServers, resourceCount) {
  if (strategyId === 'dns-prefetch' || strategyId === 'preconnect') {
    return targetServers;
  }

  const [server] = targetServers;
  return Array.from({ length: resourceCount }, (_, index) => {
    const url = new URL(server.url);
    url.pathname = `/resource/${index}`;
    return {
      index,
      origin: server.origin,
      url: url.toString()
    };
  });
}

function buildTrialUrl(baseUrl, traceId, index) {
  const url = new URL(baseUrl, window.location.origin);
  url.searchParams.set('trace', traceId);
  url.searchParams.set('i', String(index));
  return url.toString();
}

function wait(durationMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('实验已取消', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('实验已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function addHint(rel, href, addWarning, traceId) {
  const link = document.createElement('link');
  link.rel = rel;
  link.href = href;
  if (rel === 'preconnect') link.crossOrigin = 'anonymous';
  link.dataset.resourceHintsLab = 'true';
  link.dataset.labTrace = traceId;
  link.addEventListener('load', () => {
    link.dataset.loaded = 'true';
  });
  link.addEventListener('error', () => addWarning(rel, `浏览器报告 ${href} 的 ${rel} 提示失败。`));
  document.head.appendChild(link);
  return link;
}

function addFetchHint(rel, href, addWarning, traceId) {
  const link = document.createElement('link');
  link.rel = rel;
  link.href = href;
  link.as = 'fetch';
  link.crossOrigin = 'anonymous';
  link.dataset.resourceHintsLab = 'true';
  link.dataset.labTrace = traceId;
  link.addEventListener('load', () => {
    link.dataset.loaded = 'true';
  });
  link.addEventListener('error', () => addWarning(rel, `浏览器报告 ${href} 的 ${rel} 提示失败。`));
  document.head.appendChild(link);
  return link;
}

async function runTrial({
  runId,
  iteration,
  strategyId,
  targets,
  config,
  capabilities,
  addWarning,
  signal
}) {
  const traceId = `${runId}-i${iteration}-${strategyId}`;
  const epoch = performance.now();
  const resources = targets.map((target, index) => ({
    index,
    origin: target.origin,
    url: buildTrialUrl(target.url, traceId, index),
    epoch
  }));
  const resourcesWithEpoch = resources;
  const observer = createResourceObserver(resourcesWithEpoch, capabilities, addWarning);
  const longTasks = [];
  const longTaskObserver = createLongTaskObserver(longTasks, capabilities);
  const insertedHints = [];

  performance.mark?.(`${traceId}:start`);

  try {
    if (strategyId === 'dns-prefetch' || strategyId === 'preconnect') {
      [...new Set(resources.map(resource => resource.origin))].forEach(origin => {
        insertedHints.push(addHint(strategyId, origin, addWarning, traceId));
      });
    }

    if (strategyId === 'preload' || strategyId === 'prefetch') {
      resources.forEach(resource => {
        insertedHints.push(addFetchHint(strategyId, resource.url, addWarning, traceId));
      });
    }

    await wait(config.discoveryDelayMs, signal);
    const discoveryAt = performance.now() - epoch;
    performance.mark?.(`${traceId}:discover`);

    const results = await runResourcePool({
      resources: resourcesWithEpoch,
      concurrency: config.concurrency,
      epoch,
      signal
    });

    await wait(250);

    const resourceMetrics = observer.collect();
    const endedAt = performance.now() - epoch;
    const failures = results.filter(result => result.error);
    const warningsForTrial = [];

    if (failures.length) {
      const message = `${failures.length}/${resources.length} 个资源请求失败：${failures[0].error}`;
      warningsForTrial.push(message);
      addWarning(strategyId, message);
    }

    if (resourceMetrics.length < resources.length) {
      const message = `仅捕获 ${resourceMetrics.length}/${resources.length} 条 Resource Timing。`;
      warningsForTrial.push(message);
      addWarning(strategyId, message);
    }

    const metrics = summarizeResources({
      resources: resourcesWithEpoch,
      results,
      resourceMetrics,
      longTasks,
      elapsedMs: endedAt,
      discoveryToCompleteMs: endedAt - discoveryAt
    });

    if (metrics.opaqueCount > 0 && capabilities.supportsResourceTiming) {
      const message = metrics.opaqueCount
        ? `${metrics.opaqueCount} 个资源是跨域 opaque timing，阶段图已降级。`
        : '存在跨域 opaque timing。';
      warningsForTrial.push(message);
      addWarning(strategyId, message);
    }

    return {
      runId,
      iteration,
      strategyId,
      strategy: strategyById(strategyId).label,
      startedAt: new Date(Date.now() - endedAt).toISOString(),
      epoch,
      discoveryAt,
      endedAt,
      success: failures.length === 0,
      error: failures[0]?.error || null,
      warnings: warningsForTrial,
      metrics,
      resources: resourceMetrics,
      longTasks: longTasks.map(task => ({ startTime: task.start - epoch, duration: task.duration }))
    };
  } finally {
    observer.disconnect();
    longTaskObserver?.disconnect();
    insertedHints.forEach(hint => {
      hint.disabled = true;
      hint.dataset.removedByLab = 'true';
    });
    performance.clearMarks?.(`${traceId}:start`);
    performance.clearMarks?.(`${traceId}:discover`);
  }
}

async function runResourcePool({ resources, concurrency, epoch, signal }) {
  let cursor = 0;
  const results = new Array(resources.length);

  async function worker(workerId) {
    while (cursor < resources.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fetchResource(resources[index], epoch, workerId, signal);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, resources.length) }, (_, id) => worker(id)));
  return results;
}

async function fetchResource(resource, epoch, workerId, externalSignal) {
  const controller = new AbortController();
  const start = performance.now() - epoch;
  const timeout = setTimeout(() => controller.abort(), 30000);
  const abortExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortExternal, { once: true });

  try {
    const response = await fetch(resource.url, {
      cache: 'default',
      credentials: 'omit',
      mode: 'cors',
      signal: controller.signal
    });
    const firstByte = performance.now() - epoch;
    const body = await response.arrayBuffer();
    const end = performance.now() - epoch;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      index: resource.index,
      url: resource.url,
      workerId,
      ok: true,
      status: response.status,
      start,
      firstByte,
      end,
      bytes: body.byteLength
    };
  } catch (error) {
    const cancelledByUser = externalSignal?.aborted;
    return {
      index: resource.index,
      url: resource.url,
      workerId,
      ok: false,
      status: 0,
      start,
      firstByte: null,
      end: performance.now() - epoch,
      bytes: 0,
      error: error.name === 'AbortError' && cancelledByUser ? '实验已取消' :
        error.name === 'AbortError' ? '请求超时（30000ms）' : error.message
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortExternal);
  }
}

function createResourceObserver(resources, capabilities, addWarning) {
  const entriesByUrl = new Map();
  let observer = null;
  const expectedUrls = new Set(resources.map(resource => resource.url));

  const remember = entry => {
    if (!expectedUrls.has(entry.name)) return;
    const entries = entriesByUrl.get(entry.name) || [];
    entries.push(entry);
    entriesByUrl.set(entry.name, entries);
  };

  if (capabilities.supportsResourceTiming) {
    try {
      observer = new PerformanceObserver(list => {
        list.getEntries().forEach(remember);
      });
      observer.observe({ type: 'resource', buffered: true });
      performance.getEntriesByType?.('resource').forEach(remember);
    } catch (error) {
      addWarning('PerformanceObserver', `Resource Timing 初始化失败：${error.message}`);
      observer = null;
    }
  }

  return {
    disconnect() {
      observer?.disconnect();
    },
    collect() {
      performance.getEntriesByType?.('resource').forEach(remember);
      return resources.map(resource => {
        const entries = entriesByUrl.get(resource.url) || [];
        const business = entries.find(entry => entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest');
        const earliest = entries.reduce((selected, entry) => {
          if (!selected || (entry.startTime || 0) < (selected.startTime || 0)) return entry;
          return selected;
        }, null);
        const latest = entries.reduce((selected, entry) => {
          if (!selected || (entry.responseEnd || 0) > (selected.responseEnd || 0)) return entry;
          return selected;
        }, null);
        return normalizeResourceEntry(resource, earliest, business || latest);
      });
    }
  };
}

function createLongTaskObserver(longTasks, capabilities) {
  if (!capabilities.supportsLongTask) return null;
  try {
    const observer = new PerformanceObserver(list => {
      list.getEntries().forEach(entry => longTasks.push(entry));
    });
    observer.observe({ type: 'longtask', buffered: false });
    return observer;
  } catch {
    return null;
  }
}

function normalizeResourceEntry(resource, entry, businessEntry) {
  if (!entry) {
    return {
      index: resource.index,
      url: resource.url,
      found: false,
      opaque: false,
      initiatorType: null,
      startTime: null,
      relativeStart: null,
      responseEnd: null,
      finalResponseEnd: null,
      businessStart: null,
      dnsStart: null,
      dnsEnd: null,
      connectStart: null,
      connectEnd: null,
      requestStart: null,
      responseStart: null,
      dnsMs: null,
      connectMs: null,
      tlsMs: null,
      requestMs: null,
      firstByteMs: null,
      downloadMs: null,
      transferBytes: null,
      encodedBodySize: null,
      decodedBodySize: null
    };
  }

  const secureStart = entry.secureConnectionStart || 0;
  const connectEnd = entry.connectEnd || 0;
  const connectStart = entry.connectStart || 0;
  const requestStart = entry.requestStart || 0;
  const responseStart = entry.responseStart || 0;
  const responseEnd = entry.responseEnd || 0;
  const domainLookupStart = entry.domainLookupStart || 0;
  const domainLookupEnd = entry.domainLookupEnd || 0;
  const opaque = domainLookupStart === 0 && connectStart === 0 && requestStart === 0;
  const relativeStart = entry.startTime - resource.epoch;
  const finalResponseEnd = Math.max(entry.responseEnd || 0, businessEntry?.responseEnd || 0) - resource.epoch;
  const businessStart = businessEntry && businessEntry !== entry ? businessEntry.startTime - resource.epoch : relativeStart;

  return {
    index: resource.index,
    url: resource.url,
    found: true,
    opaque,
    initiatorType: entry.initiatorType,
    startTime: entry.startTime,
    relativeStart,
    responseEnd,
    finalResponseEnd,
    businessStart,
    dnsStart: domainLookupStart ? domainLookupStart - resource.epoch : relativeStart,
    dnsEnd: domainLookupEnd ? domainLookupEnd - resource.epoch : relativeStart,
    connectStart: connectStart ? connectStart - resource.epoch : relativeStart,
    connectEnd: connectEnd ? connectEnd - resource.epoch : relativeStart,
    requestStart: requestStart ? requestStart - resource.epoch : relativeStart,
    responseStart: responseStart ? responseStart - resource.epoch : responseEnd - resource.epoch,
    dnsMs: domainLookupEnd && domainLookupStart ? domainLookupEnd - domainLookupStart : 0,
    connectMs: connectEnd && connectStart ? connectEnd - connectStart : 0,
    tlsMs: secureStart && connectEnd ? connectEnd - secureStart : 0,
    requestMs: responseStart && requestStart ? responseStart - requestStart : 0,
    firstByteMs: responseStart && requestStart ? responseStart - requestStart : 0,
    downloadMs: responseEnd && responseStart ? responseEnd - responseStart : 0,
    transferBytes: entry.transferSize || 0,
    encodedBodySize: entry.encodedBodySize || 0,
    decodedBodySize: entry.decodedBodySize || 0
  };
}

function summarizeResources({
  resources,
  results,
  resourceMetrics,
  longTasks,
  elapsedMs,
  discoveryToCompleteMs
}) {
  const resultByIndex = new Map(results.map(result => [result.index, result]));
  const found = resourceMetrics.filter(item => item.found);
  const visible = found.filter(item => !item.opaque);
  const successResults = results.filter(result => result.ok);

  const averageVisible = selector => {
    const values = visible.map(selector).filter(value => Number.isFinite(value) && value > 0);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  };

  const transferBytes = found.reduce((sum, item) => sum + (item.transferBytes || 0), 0);
  const timeline = resourceMetrics
    .map(item => {
      const result = resultByIndex.get(item.index);
      if (!item.found || !result?.ok) return null;
      const start = Number.isFinite(item.relativeStart) ? item.relativeStart : result.start;
      const end = Number.isFinite(item.finalResponseEnd) ? item.finalResponseEnd : result.end;
      const visibleStart = start;
      const dns = item.opaque ? 0 : item.dnsMs;
      const connect = item.opaque ? 0 : item.connectMs;
      const firstByte = Number.isFinite(result.firstByte)
        ? Math.max(0, result.firstByte - visibleStart)
        : item.firstByteMs;
      const request = item.opaque ? Math.max(0, firstByte) : item.requestMs;
      const download = item.opaque ? Math.max(0, end - visibleStart - request) : item.downloadMs;

      return {
        index: item.index,
        start,
        businessStart: Number.isFinite(item.businessStart) ? item.businessStart : result.start,
        end,
        dns,
        connect,
        request: Math.max(0, request),
    download: Math.max(0, download),
    dnsStart: item.opaque ? start : item.dnsStart,
    dnsEnd: item.opaque ? start : item.dnsEnd,
    connectStart: item.opaque ? start : item.connectStart,
    connectEnd: item.opaque ? start : item.connectEnd,
    requestStart: item.opaque ? start : item.requestStart,
    responseStart: item.opaque ? start : item.responseStart,
    responseEnd: end,
    initiatorType: item.initiatorType,
        cacheHit: item.found && item.transferBytes === 0 && item.encodedBodySize > 0
      };
    })
    .filter(Boolean);

  return {
    elapsedMs,
    discoveryToCompleteMs,
    dnsMs: averageVisible(item => item.dnsMs),
    connectMs: averageVisible(item => item.connectMs),
    tlsMs: averageVisible(item => item.tlsMs),
    requestMs: averageVisible(item => item.requestMs),
    firstByteMs: averageVisible(item => item.firstByteMs),
    downloadMs: averageVisible(item => item.downloadMs),
    longTaskMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
    longTaskCount: longTasks.length,
    transferBytes,
    bodyBytes: successResults.reduce((sum, result) => sum + result.bytes, 0),
    successCount: successResults.length,
    failureCount: resources.length - successResults.length,
    foundCount: found.length,
    opaqueCount: found.filter(item => item.opaque).length,
    cacheHits: timeline.filter(item => item.cacheHit).length,
    timeline
  };
}

function aggregateResults({ runId, config, trials, capabilities, warnings }) {
  const selectedOrder = STRATEGIES.map(item => item.id).filter(id => config.strategies.includes(id));
  const baselineId = selectedOrder.includes('none') ? 'none' : selectedOrder[0];

  const strategies = selectedOrder.map(strategyId => {
    const strategyTrials = trials.filter(trial => trial.strategyId === strategyId);
    const metricStats = {};

    for (const metric of METRICS) {
      const values = strategyTrials
        .map(trial => trial.metrics[metric.id])
        .filter(value => Number.isFinite(value));
      metricStats[metric.id] = describeValues(values);
    }

    const timelines = strategyTrials
      .map(trial => trial.metrics.timeline)
      .filter(timeline => Array.isArray(timeline) && timeline.length);

    return {
      strategyId,
      label: strategyById(strategyId).label,
      description: strategyById(strategyId).description,
      color: strategyById(strategyId).color,
      count: strategyTrials.length,
      successCount: strategyTrials.filter(trial => trial.success).length,
      failureCount: strategyTrials.filter(trial => !trial.success).length,
      warningCount: strategyTrials.reduce((sum, trial) => sum + trial.warnings.length, 0),
      cacheHits: median(strategyTrials.map(trial => trial.metrics.cacheHits || 0)),
      metricStats,
      timeline: medianTimelines(timelines),
      trials: strategyTrials
    };
  });

  const baseline = strategies.find(item => item.strategyId === baselineId);
  for (const strategy of strategies) {
    for (const metric of METRICS) {
      const current = strategy.metricStats[metric.id].median;
      const base = baseline?.metricStats[metric.id].median;
      strategy.metricStats[metric.id].vsBaseline =
        Number.isFinite(current) && Number.isFinite(base) && base !== 0
          ? ((base - current) / base) * 100
          : null;
    }
  }

  const successful = strategies.filter(item => item.successCount > 0);
  const fastest = [...successful].sort(
    (a, b) => (a.metricStats.elapsedMs.median ?? Number.POSITIVE_INFINITY) -
      (b.metricStats.elapsedMs.median ?? Number.POSITIVE_INFINITY)
  )[0];
  const steadiest = [...successful].sort(
    (a, b) => (a.metricStats.elapsedMs.stddev ?? Number.POSITIVE_INFINITY) -
      (b.metricStats.elapsedMs.stddev ?? Number.POSITIVE_INFINITY)
  )[0];

  return {
    runId,
    createdAt: new Date().toISOString(),
    config,
    capabilities,
    environment: getEnvironment(),
    warnings,
    baselineId,
    fastestStrategyId: fastest?.strategyId || null,
    steadiestStrategyId: steadiest?.strategyId || null,
    trials,
    strategies
  };
}

function describeValues(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const variance = values.length
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    : null;

  return {
    values: sorted,
    count: sorted.length,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    mean,
    median: median(sorted),
    p95: percentile(sorted, 95),
    stddev: variance == null ? null : Math.sqrt(variance),
    vsBaseline: null
  };
}

function median(values) {
  return percentile([...values].sort((a, b) => a - b), 50);
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = ((percentileValue / 100) * (sortedValues.length - 1));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function medianTimelines(timelines) {
  if (!timelines.length) return null;
  const maxLength = Math.max(...timelines.map(timeline => timeline.length));
  const stages = [
    'start', 'businessStart', 'dnsStart', 'dnsEnd', 'connectStart', 'connectEnd',
    'requestStart', 'responseStart', 'responseEnd', 'dns', 'connect',
    'request', 'download', 'end'
  ];
  const rows = [];

  for (let index = 0; index < maxLength; index += 1) {
    const row = { index };
    for (const stage of stages) {
      row[stage] = median(
        timelines
          .map(timeline => timeline[index]?.[stage])
          .filter(value => Number.isFinite(value))
      );
      if (!Number.isFinite(row[stage])) row[stage] = 0;
    }
    rows.push(row);
  }

  return {
    start: median(rows.map(row => row.start)),
    businessStart: median(rows.map(row => row.businessStart)),
    dnsStart: median(rows.map(row => row.dnsStart)),
    dnsEnd: median(rows.map(row => row.dnsEnd)),
    connectStart: median(rows.map(row => row.connectStart)),
    connectEnd: median(rows.map(row => row.connectEnd)),
    requestStart: median(rows.map(row => row.requestStart)),
    responseStart: median(rows.map(row => row.responseStart)),
    responseEnd: median(rows.map(row => row.responseEnd)),
    dns: median(rows.map(row => row.dns)),
    connect: median(rows.map(row => row.connect)),
    request: median(rows.map(row => row.request)),
    download: median(rows.map(row => row.download)),
    end: median(rows.map(row => row.end)),
    rows
  };
}

function getEnvironment() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: navigator.deviceMemory || null,
    effectiveType: connection?.effectiveType || null,
    downlink: connection?.downlink || null,
    platform: navigator.platform || null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null
  };
}
