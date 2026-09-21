'use strict';

/* 静态冒烟测试：在不监听端口的前提下验证页面生成、提示注入与目录完整性。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildTestPage, CATALOG, CDN_CATALOG } = require('./server');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (err) {
    failures++;
    console.error('  ✗ ' + name + '\n    ' + err.message);
  }
}

console.log('测试页 hint 注入:');
const runId = 'test-run-1';
const pages = {};
['none', 'preconnect', 'preload', 'prefetch', 'combined'].forEach(function (s) {
  pages[s] = buildTestPage(s, runId);
  test(s + ' 页面包含 harness 上报脚本', () => {
    assert.ok(pages[s].indexOf("postMessage") !== -1);
    assert.ok(pages[s].indexOf("strategy-result") !== -1);
  });
  test(s + ' 引用 9 个资源(7 主站 + 2 CDN)', () => {
    Object.keys(CATALOG).forEach(n => assert.ok(pages[s].includes('/res/' + n), 'missing ' + n));
    Object.keys(CDN_CATALOG).forEach(n => assert.ok(pages[s].includes('/cdn/' + n), 'missing ' + n));
  });
});

test('none 不含任何 hint', () => {
  assert.ok(!/rel="(preload|prefetch|preconnect)"/.test(pages.none.replace(/策略：none/g, '')));
});
test('preconnect 注入到 CDN 源', () => {
  assert.ok(pages.preconnect.includes('rel="preconnect"'));
  assert.ok(/preconnect" href="http:\/\/127\.0\.0\.1|localhost:3001/.test(pages.preconnect) ||
            pages.preconnect.includes(':3001'));
});
test('preload 注入 3 条关键资源', () => {
  const matches = pages.preload.match(/rel="preload"/g) || [];
  assert.strictEqual(matches.length, 3);
  assert.ok(pages.preload.includes('as="style"'));
  assert.ok(pages.preload.includes('as="script"'));
  assert.ok(pages.preload.includes('as="image"'));
});
test('prefetch 注入 next-page.js', () => {
  assert.ok(pages.prefetch.includes('rel="prefetch"'));
  assert.ok(pages.prefetch.includes('next-page.js'));
});
test('combined 同时含 preconnect + preload', () => {
  assert.ok(pages.combined.includes('rel="preconnect"'));
  assert.strictEqual((pages.combined.match(/rel="preload"/g) || []).length, 3);
});
test('所有资源 URL 带 runId(缓存隔离)', () => {
  assert.ok(pages.preload.includes('?run=' + runId));
});
test('harness 含异常监听与超时兜底', () => {
  assert.ok(pages.none.includes("addEventListener('error'"));
  assert.ok(pages.none.includes('12000'));
});

console.log('前端逻辑(纯函数沙箱):');
const appSrc = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const elements = {};
function fakeCanvas() {
  return {
    height: 260, getBoundingClientRect: () => ({ width: 800 }),
    getContext: () => ({
      setTransform() {}, clearRect() {}, fillRect() {}, fillText() {}, beginPath() {},
      moveTo() {}, lineTo() {}, stroke() {}, fill() {}, save() {}, restore() {},
      scale() {}, measureText: () => ({ width: 10 })
    })
  };
}
['btn-run','btn-rerun','btn-export-json','btn-export-csv','btn-print','run-status',
 'chart-bars','chart-waterfall','metrics-table','strategy-tabs','error-log','harness'
].forEach(id => {
  elements[id] = id.indexOf('chart') === 0 ? fakeCanvas()
    : id === 'harness' ? { src: '' }
    : { innerHTML: '', textContent: '', className: '', disabled: false,
        querySelector: () => null, querySelectorAll: () => [], insertBefore() {},
        appendChild() {}, addEventListener() {} };
});
const sandbox = {
  console, navigator: { userAgent: 'node-test' },
  document: {
    getElementById: id => elements[id],
    createElement: () => ({ click() {}, remove() {}, style: {} }),
    body: { appendChild() {} }
  },
  window: { addEventListener() {}, print() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: cb => cb(),
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  PerformanceObserver: function () {},
  devicePixelRatio: 1
};
sandbox.window.URL = sandbox.URL;
vm.createContext(sandbox);
vm.runInContext(appSrc, sandbox);

test('app.js 可在浏览器 API 桩下完成初始化', () => {
  assert.strictEqual(typeof sandbox.runStrategy, 'function');
  assert.strictEqual(typeof sandbox.buildReport, 'function');
});

test('normalizeResult 计算 loadMs/截断资源数(间接验证导出数据结构)', () => {
  const normalize = vm.runInContext('normalizeResult', sandbox);
  const many = Array.from({ length: 150 }, (_, i) => ({
    name: '/res/app.js', initiatorType: 'script', startTime: i, duration: 10, responseEnd: i + 10
  }));
  const out = normalize({
    strategy: 'preload', resources: many, errors: [],
    navigation: { loadEventEnd: 999 }, paint: { 'first-contentful-paint': 123.4 },
    prefetchProbe: { injectToOnloadMs: 2, servedFromCache: true },
    observerSupported: true
  });
  assert.strictEqual(out.loadMs, 999);
  assert.strictEqual(out.fcpMs, 123);
  assert.strictEqual(out.resourceCount, 100);
  assert.strictEqual(out.nextPageMs, 2);
  assert.strictEqual(out.nextPageFromCache, true);

  const fallback = normalize({ strategy: 'none', resources: [
    { name: '/res/x.js', startTime: 5, duration: 10, responseEnd: 15 }
  ], errors: [], navigation: null, paint: {}, prefetchProbe: null });
  assert.strictEqual(fallback.loadMs, 15);
});

test('buildReport 汇总结构完整', () => {
  vm.runInContext(`storeResult('none', normalizeResult({
    strategy: 'none', resources: [], errors: [],
    navigation: { loadEventEnd: 100 }, paint: {}, prefetchProbe: null
  }));`, sandbox);
  const report = vm.runInContext('buildReport()', sandbox);
  assert.strictEqual(report.tool, 'resource-hints-lab');
  assert.ok(Array.isArray(report.summary));
  assert.strictEqual(report.summary[0].loadMs, 100);
  assert.ok(report.details.none);
});

test('drawBars/drawWaterfall 对空数据不抛异常', () => {
  assert.doesNotThrow(() => vm.runInContext('drawBars();drawWaterfall();', sandbox));
});

console.log(failures === 0 ? '\n全部通过 ✔' : '\n有 ' + failures + ' 个失败');
process.exit(failures === 0 ? 0 : 1);
