'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const HOST = process.env.HOST || '127.0.0.1';
const MAIN_PORT = Number(process.env.PORT) || 3000;
const CDN_PORT = Number(process.env.CDN_PORT) || 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Simulated resource catalog. delay = server processing / transfer latency.
const CATALOG = {
  'critical.css': { type: 'css', delay: 250, body: '/* critical stylesheet */\nbody{margin:0}' },
  'app.js':       { type: 'js',  delay: 350, body: '/* app bundle */\nwindow.__appLoaded=Date.now();' },
  'vendor.js':    { type: 'js',  delay: 450, body: '/* vendor bundle */' },
  'hero.svg':     { type: 'img', delay: 400 },
  'photo1.svg':   { type: 'img', delay: 600 },
  'photo2.svg':   { type: 'img', delay: 800 },
  'next-page.js': { type: 'js',  delay: 500, body: '/* next-page bundle, normally fetched later */' },
};

// Resources served from the simulated cross-origin CDN.
const CDN_CATALOG = {
  'api.js':     { type: 'js',  delay: 300, body: '/* third-party analytics api */' },
  'avatar.svg': { type: 'img', delay: 350 },
};

// Artificial handshake cost charged only on the first request of a TCP
// keep-alive connection. preconnect warms the socket in advance, so this cost
// overlaps with other work instead of adding to the critical path.
const HANDSHAKE_DELAY = 400;

function svgBody(name) {
  const hue = (name.charCodeAt(0) * 37) % 360;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">' +
    `<rect width="100%" height="100%" fill="hsl(${hue},60%,70%)"/>` +
    `<text x="50%" y="52%" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#222">${name}</text>` +
    '</svg>'
  );
}

function respondResource(res, name, item) {
  const isImage = item.type === 'img';
  res.setHeader('Content-Type', isImage ? 'image/svg+xml' : item.type === 'css' ? 'text/css' : 'text/javascript');
  // Cacheable so prefetch/preload can demonstrate cache hits; callers cache-bust per run.
  res.setHeader('Cache-Control', 'public, max-age=120');
  res.setHeader('Timing-Allow-Origin', '*');
  res.setHeader('X-Resource-Name', name);
  res.setHeader('X-Simulated-Delay', String(item.delay));
  setTimeout(() => {
    res.end(isImage ? svgBody(name) : item.body);
  }, item.delay);
}

function staticHandler(req, res, pathname) {
  const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found: ' + pathname);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function buildTestPage(strategy, runId) {
  const cdnOrigin = `http://localhost:${CDN_PORT}`;
  const u = (name, extra) => `/res/${name}?run=${runId}${extra ? '&' + extra : ''}`;
  const cdnU = (name) => `${cdnOrigin}/cdn/${name}?run=${runId}`;

  const preloadHints = [
    `<link rel="preload" href="${u('critical.css')}" as="style">`,
    `<link rel="preload" href="${u('app.js')}" as="script">`,
    `<link rel="preload" href="${u('hero.svg')}" as="image">`,
  ].join('\n    ');

  let hints = '';
  if (strategy === 'preconnect') {
    hints = `<link rel="preconnect" href="${cdnOrigin}">`;
  } else if (strategy === 'preload') {
    hints = preloadHints;
  } else if (strategy === 'prefetch') {
    hints = `<link rel="prefetch" href="${u('next-page.js')}">`;
  } else if (strategy === 'combined') {
    hints = `<link rel="preconnect" href="${cdnOrigin}">\n    ${preloadHints}`;
  }

  // For the prefetch strategy the next-page bundle is requested AFTER load;
  // other strategies request it as well, but without a prior hint.
  // The probe measures injection -> script onload, which is ~0 when the
  // prefetch cache already holds the response.
  const injectNextPage =
    "setTimeout(function(){\n" +
    "      var s=document.createElement('script');\n" +
    "      window.__probeStart=performance.now();\n" +
    "      s.onload=function(){ window.__probeDone=true; window.__probeEnd=performance.now(); };\n" +
    "      s.src='" + u('next-page.js') + "';\n" +
    "      document.body.appendChild(s);\n" +
    "    }, 400);";

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>test: ${strategy}</title>
    ${hints}
<link rel="stylesheet" href="${u('critical.css')}">
<script src="${u('vendor.js')}"><\/script>
</head>
<body>
<h1>策略：${strategy}</h1>
<img src="${u('hero.svg')}" alt="hero">
<img src="${u('photo1.svg')}" alt="photo1">
<img src="${u('photo2.svg')}" alt="photo2">
<script src="${u('app.js')}"><\/script>
<script src="${cdnU('api.js')}"><\/script>
<img src="${cdnU('avatar.svg')}" alt="avatar">
<script>
(function () {
  var result = {
    runId: ${JSON.stringify(runId)},
    strategy: ${JSON.stringify(strategy)},
    startedAt: new Date().toISOString(),
    resources: [],
    errors: [],
    paint: {},
    navigation: null,
    prefetchProbe: null,
    observerSupported: typeof PerformanceObserver !== 'undefined'
  };

  function serialize(e) {
    return {
      name: e.name.split('?')[0],
      initiatorType: e.initiatorType,
      startTime: Math.round(e.startTime * 100) / 100,
      duration: Math.round(e.duration * 100) / 100,
      requestStart: e.requestStart,
      responseStart: e.responseStart,
      responseEnd: e.responseEnd,
      transferSize: typeof e.transferSize === 'number' ? e.transferSize : null,
      encodedBodySize: e.encodedBodySize,
      fromCache: typeof e.transferSize === 'number' ? e.transferSize === 0 : null
    };
  }

  window.addEventListener('error', function (ev) {
    result.errors.push(ev.message || (ev.target && ev.target.src) || 'unknown error');
  }, true);

  function snapshotResources() {
    result.resources = performance.getEntriesByType('resource').map(serialize);
  }

  var po = null;
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      po = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (e.entryType === 'resource') result.resources.push(serialize(e));
        });
      });
      po.observe({ type: 'resource', buffered: true });
    }
  } catch (err) {
    result.errors.push('PerformanceObserver init failed: ' + err.message);
  }

  function report(probe) {
    try {
      snapshotResources();
      // de-dup buffered observer + snapshot entries by name+startTime
      var seen = {};
      result.resources = result.resources.filter(function (r) {
        var key = r.name + '|' + r.startTime;
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      }).sort(function (a, b) { return a.startTime - b.startTime; });

      result.navigation = (function () {
        var n = performance.getEntriesByType('navigation')[0];
        if (!n) return null;
        return {
          domContentLoaded: Math.round(n.domContentLoadedEventEnd),
          loadEventEnd: Math.round(n.loadEventEnd),
          responseEnd: Math.round(n.responseEnd),
          duration: Math.round(n.duration * 100) / 100
        };
      })();

      performance.getEntriesByType('paint').forEach(function (p) {
        result.paint[p.name] = Math.round(p.startTime * 100) / 100;
      });

      result.prefetchProbe = probe || null;

      if (po) { try { po.disconnect(); } catch (e) {} }

      parent.postMessage({ type: 'strategy-result', runId: ${JSON.stringify(runId)}, payload: result }, '*');
    } catch (e) {
      result.errors.push('report failed: ' + e.message);
      parent.postMessage({ type: 'strategy-result', runId: ${JSON.stringify(runId)}, payload: result }, '*');
    }
  }

  window.addEventListener('load', function () {
    ${injectNextPage}
    setTimeout(function () {
      var probed = false;
      function finishProbe() {
        if (probed) return;
        probed = true;
        var entries = performance.getEntriesByType('resource')
          .filter(function (e) { return e.name.indexOf('next-page.js') !== -1; });
        var last = entries[entries.length - 1];
        report({
          injectToOnloadMs: window.__probeStart && window.__probeDone
            ? Math.round((window.__probeEnd - window.__probeStart) * 100) / 100
            : null,
          resourceDuration: last ? Math.round(last.duration * 100) / 100 : null,
          transferSize: last ? last.transferSize : null,
          servedFromCache: last ? last.transferSize === 0 : null
        });
      }
      var tick = setInterval(function () {
        if (window.__probeDone) { clearInterval(tick); finishProbe(); }
      }, 50);
      // fail-safe: report even if the late script never loads
      setTimeout(function () { clearInterval(tick); finishProbe(); }, 4000);
    }, 300);
  });

  // Safety net: if load never fires, still report.
  setTimeout(function () {
    if (!result.navigation) report(null);
  }, 12000);
})();
<\/script>
</body>
</html>`;
}

const mainServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  if (pathname === '/test') {
    const strategy = ['none', 'preconnect', 'preload', 'prefetch', 'combined'].indexOf(query.strategy) !== -1
      ? query.strategy : 'none';
    const runId = String(query.run || Date.now());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(buildTestPage(strategy, runId));
  }

  const resMatch = pathname.match(/^\/res\/([\w.-]+)$/);
  if (resMatch) {
    const item = CATALOG[resMatch[1]];
    if (!item) { res.writeHead(404); return res.end('unknown resource'); }
    return respondResource(res, resMatch[1], item);
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, cdnPort: CDN_PORT }));
  }

  staticHandler(req, res, pathname);
});

const seenSockets = new WeakSet();
const cdnServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const match = parsed.pathname.match(/^\/cdn\/([\w.-]+)$/);
  if (!match) { res.writeHead(404); return res.end('not found'); }
  const item = CDN_CATALOG[match[1]];
  if (!item) { res.writeHead(404); return res.end('unknown cdn resource'); }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Timing-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=120');

  const isFirstOnSocket = !seenSockets.has(req.socket);
  seenSockets.add(req.socket);
  const handshake = isFirstOnSocket ? HANDSHAKE_DELAY : 0;
  res.setHeader('X-Simulated-Handshake', String(handshake));
  res.setHeader('X-Simulated-Delay', String(item.delay));

  setTimeout(() => respondResource(res, match[1], item), handshake);
});

if (require.main === module) {
  mainServer.listen(MAIN_PORT, HOST, () => {
    console.log(`[main] dashboard + test pages: http://${HOST}:${MAIN_PORT}`);
  });
  cdnServer.listen(CDN_PORT, HOST, () => {
    console.log(`[cdn ] simulated third-party origin: http://${HOST}:${CDN_PORT} (handshake=${HANDSHAKE_DELAY}ms)`);
  });
}

module.exports = {
  buildTestPage,
  mainServer,
  cdnServer,
  CATALOG,
  CDN_CATALOG,
  HANDSHAKE_DELAY,
  MAIN_PORT,
  CDN_PORT
};
