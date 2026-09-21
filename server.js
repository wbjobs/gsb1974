import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const maxTargetsPerSession = 120;
const sessionTtlMs = 10 * 60 * 1000;
const maxBodyBytes = 8 * 1024;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

const sessions = new Map();

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > maxBodyBytes) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('JSON 格式无效'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function applyCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,DELETE,POST');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Timing-Allow-Origin', '*');
}

function handleTargetRequest(request, response, session, targetIndex) {
  applyCorsHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: '只支持 GET 请求' });
    return;
  }

  const target = session.targets[targetIndex];
  const url = new URL(request.url, target.origin);

  if (!url.pathname.match(/^\/resource(?:\/\d+)?$/)) {
    sendJson(response, 404, { error: '目标资源不存在' });
    return;
  }

  if (url.searchParams.get('session') !== session.id) {
    sendJson(response, 400, { error: '会话编号不匹配' });
    return;
  }

  const delayMs = clampNumber(url.searchParams.get('delayMs'), session.delayMs, 0, 3000);
  const sizeBytes = clampNumber(url.searchParams.get('size'), session.sizeBytes, 0, 262144);
  const trace = url.searchParams.get('trace') || '';

  const etag = `"${session.id}-${targetIndex}-${trace}"`;
  const clientEtag = request.headers['if-none-match'];

  if (clientEtag === etag) {
    response.writeHead(304, {
      'Cache-Control': 'public, max-age=60, immutable',
      'ETag': etag,
      'Access-Control-Allow-Origin': '*',
      'Timing-Allow-Origin': '*'
    });
    response.end();
    return;
  }

  const timer = setTimeout(() => {
    const payload = {
      ok: true,
      session: session.id,
      target: targetIndex,
      trace,
      serverDelayMs: delayMs,
      padding: 'x'.repeat(sizeBytes)
    };
    const body = JSON.stringify(payload);
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'public, max-age=60, immutable',
      'ETag': etag,
      'Access-Control-Allow-Origin': '*',
      'Timing-Allow-Origin': '*'
    });
    response.end(body);
  }, delayMs);

  request.on('aborted', () => clearTimeout(timer));
  response.on('close', () => clearTimeout(timer));
}

function createTargetServer(session, targetIndex) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      handleTargetRequest(request, response, session, targetIndex);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        origin,
        url: `${origin}/resource?session=${encodeURIComponent(session.id)}&target=${targetIndex}&delayMs=${session.delayMs}&size=${session.sizeBytes}`
      });
    });
  });
}

async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return false;

  clearTimeout(session.cleanupTimer);
  sessions.delete(id);

  await Promise.allSettled(
    session.targets.map(target => new Promise(resolve => {
      target.server.close(() => resolve());
    }))
  );
  return true;
}

async function createSession(request, response) {
  const body = await readJsonBody(request);
  const count = clampNumber(body.count, 25, 1, maxTargetsPerSession);
  const delayMs = clampNumber(body.delayMs, 120, 0, 3000);
  const sizeBytes = clampNumber(body.sizeBytes, 128, 0, 262144);
  const id = randomUUID();
  const session = {
    id,
    delayMs,
    sizeBytes,
    createdAt: new Date().toISOString(),
    targets: [],
    cleanupTimer: null
  };

  try {
    const targets = [];
    for (let offset = 0; offset < count; offset += 24) {
      const batch = await Promise.all(
        Array.from(
          { length: Math.min(24, count - offset) },
          (_, batchIndex) => createTargetServer(session, offset + batchIndex)
        )
      );
      targets.push(...batch);
    }
    session.targets = targets;
    session.cleanupTimer = setTimeout(() => void closeSession(id), sessionTtlMs);
    sessions.set(id, session);

    sendJson(response, 201, {
      id,
      count,
      delayMs,
      sizeBytes,
      targets: targets.map((target, index) => ({
        index,
        origin: target.origin,
        url: target.url
      }))
    });
  } catch (error) {
    await Promise.allSettled(
      session.targets.map(target => new Promise(resolve => target.server.close(() => resolve())))
    );
    sendJson(response, 500, { error: `无法创建实验端点：${error.message}` });
  }
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  const requestedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(rootDir, `.${requestedPath}`);

  if (!filePath.startsWith(rootDir)) {
    sendJson(response, 403, { error: '禁止访问' });
    return;
  }

  let fileHandle;
  try {
    fileHandle = await readFile(filePath);
  } catch {
    sendJson(response, 404, { error: '文件不存在' });
    return;
  }

  const contentType = mimeTypes[extname(filePath)] || 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fileHandle.length,
    'Cache-Control': 'no-cache'
  });

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!response.headersSent) sendJson(response, 500, { error: '读取文件失败' });
    response.end();
  });
  stream.pipe(response);
}

const server = http.createServer(async (request, response) => {
  applyCorsHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, 'http://127.0.0.1');

  try {
    if (url.pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        mode: 'resource-hints-lab',
        maxTargetsPerSession,
        activeSessions: sessions.size
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      await createSession(request, response);
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === 'DELETE' && sessionMatch) {
      const closed = await closeSession(decodeURIComponent(sessionMatch[1]));
      sendJson(response, closed ? 200 : 404, { ok: closed });
      return;
    }

    if (request.method === 'GET') {
      await serveStatic(request, response);
      return;
    }

    sendJson(response, 404, { error: '接口不存在' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(response, statusCode, { error: error.message || '服务器异常' });
  }
});

async function shutdown() {
  await Promise.allSettled([
    new Promise(resolve => server.close(() => resolve())),
    ...[...sessions.keys()].map(id => closeSession(id))
  ]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

server.listen(port, host, () => {
  console.log(`Resource Hints Lab: http://${host}:${port}`);
});
