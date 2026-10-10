'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const BODY_LIMIT = 2_048;
const CSP = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function failure(message, code, status = 400) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function jsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let settled = false;
    function fail(error) {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(error);
    }
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(failure('刷新请求过大。', undefined, 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch {
        reject(failure('请求必须包含有效的 JSON 对象。'));
      }
    });
    request.on('aborted', () => fail(failure('刷新请求已中断。')));
    request.on('error', fail);
  });
}

// Every session captures one already-authorized canonical Markdown path. The HTTP
// protocol never accepts paths or resource URIs supplied by the browser.
function createBrowserPreviews({ watches, buildHtml, openBrowser, idleMs = 5 * 60 * 1000 } = {}) {
  if (!watches || ['open', 'refresh', 'release'].some(key => typeof watches[key] !== 'function')) {
    throw new TypeError('watches.open, watches.refresh and watches.release are required.');
  }
  if ([buildHtml, openBrowser].some(value => typeof value !== 'function')) {
    throw new TypeError('buildHtml and openBrowser are required.');
  }
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new TypeError('idleMs must be positive.');
  const sessions = new Map();
  let server;
  let listening;
  let origin;
  let authority;
  let closed = false;

  function dispose(session) {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.token);
    watches.release(session.output.watchId);
  }

  function ensureActive(session) {
    if (closed || session.closed) throw failure('浏览器预览已过期，请从插件重新打开。', 'PREVIEW_EXPIRED', 410);
  }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (!session.busy && now - session.lastUsed >= idleMs) dispose(session);
    }
  }, Math.min(idleMs, 30_000));
  cleanup.unref();

  async function reopen(session) {
    ensureActive(session);
    const descriptor = session.descriptor;
    if (await fs.realpath(descriptor.path) !== descriptor.path) throw failure('文件路径已重定向，请从插件重新打开。');
    // Tabs sharing this URL share its current watch. A second reconnect must
    // reuse the watch established by the first, rather than invalidate it.
    try {
      const current = await watches.refresh({
        watchId: session.output.watchId, revision: session.output.revision, path: descriptor.path
      });
      ensureActive(session);
      if (current.document) session.output = current.document;
      return session.output;
    } catch (error) {
      if (error.code !== 'WATCH_EXPIRED') throw error;
    }
    let next;
    try {
      next = await watches.open(descriptor);
    } catch (error) {
      // Preserve reopen's input-error classification before the initial render.
      if (error.pathRedirectedBeforeRender) throw failure('文件路径已重定向，请从插件重新打开。');
      throw error;
    }
    if (closed || session.closed) {
      watches.release(next.watchId);
      ensureActive(session);
    }
    watches.release(session.output.watchId);
    session.output = next;
    return next;
  }

  function send(response, status, body, contentType = 'application/json; charset=utf-8') {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP
    });
    response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
  }

  async function handle(request, response) {
    let session;
    let activeRequest = false;
    try {
      if (request.headers.host !== authority) throw failure('浏览器预览地址不匹配。', undefined, 403);
      if ((request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') {
        throw failure('拒绝来自其他网站的预览请求。', undefined, 403);
      }
      const route = /^\/([A-Za-z0-9_-]{32})\/(refresh|reopen|open-file)?$/.exec(request.url);
      if (!route) throw failure('找不到此预览地址。', undefined, 404);
      session = sessions.get(route[1]);
      if (!session) throw failure('浏览器预览已过期，请从插件重新打开。', 'PREVIEW_EXPIRED', 410);
      ensureActive(session);
      const action = route[2];
      if ((!action && request.method !== 'GET') || (action && request.method !== 'POST')) {
        throw failure('此预览地址不支持该请求方法。', undefined, 405);
      }
      if (action && (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw failure('刷新请求必须使用 application/json。', undefined, 415);
      }
      session.busy += 1;
      activeRequest = true;
      session.lastUsed = Date.now();
      let body;
      if (action) body = await jsonBody(request);
      const work = session.queue.then(async () => {
        ensureActive(session);
        if (!action) return buildHtml(session.output, session.preferences);
        if (action === 'open-file') throw failure('浏览器预览不支持打开本地文件链接，请在 Codex 中打开。', undefined, 400);
        const expectedKeys = action === 'refresh' ? ['watchId', 'revision'] : [];
        if (Object.keys(body).some(key => !expectedKeys.includes(key))) throw failure('刷新请求包含不支持的参数。');
        if (action === 'reopen') return reopen(session);
        if (typeof body.watchId !== 'string' || !Number.isSafeInteger(body.revision) || body.revision < 1) {
          throw failure('缺少有效的监听编号或版本。');
        }
        if (body.watchId !== session.output.watchId) throw failure('预览监听已过期。', 'WATCH_EXPIRED', 410);
        const next = await watches.refresh({ watchId: body.watchId, revision: body.revision, path: session.descriptor.path });
        ensureActive(session);
        if (next.document) session.output = next.document;
        return next;
      });
      session.queue = work.catch(() => {});
      const result = await work;
      send(response, 200, result, action ? undefined : 'text/html; charset=utf-8');
    } catch (error) {
      const code = error.code === 'WATCH_EXPIRED' ? 'WATCH_EXPIRED' : error.code === 'PREVIEW_EXPIRED' ? 'PREVIEW_EXPIRED' : undefined;
      send(response, error.status || (code ? 410 : 500), {
        error: error.code && !code ? `读取或刷新失败（${error.code}）。` : error.message || '浏览器预览失败。',
        ...(code ? { code } : {}), ...(code === 'WATCH_EXPIRED' ? { errorCode: code } : {})
      });
    } finally {
      if (activeRequest) {
        session.busy -= 1;
        session.lastUsed = Date.now();
      }
      // Invalid requests may carry a body too; discard it without buffering.
      request.resume();
    }
  }

  async function ensureServer() {
    if (closed) throw failure('浏览器预览服务已关闭。');
    if (!listening) {
      server = http.createServer((request, response) => { void handle(request, response); });
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 1_000;
      server.unref();
      listening = new Promise((resolve, reject) => {
        const removeStartupListeners = () => {
          server.removeListener('listening', onListen);
          server.removeListener('error', onError);
          server.removeListener('close', onClose);
        };
        const onError = error => {
          removeStartupListeners();
          reject(error);
        };
        const onClose = () => {
          removeStartupListeners();
          reject(failure('浏览器预览服务已关闭。'));
        };
        const onListen = () => {
          removeStartupListeners();
          authority = '127.0.0.1:' + server.address().port;
          origin = 'http://' + authority;
          resolve();
        };
        server.once('error', onError);
        server.once('close', onClose);
        server.once('listening', onListen);
        server.listen(0, '127.0.0.1');
      });
    }
    await listening;
    if (closed) throw failure('浏览器预览服务已关闭。');
  }

  async function open(descriptor, preferences) {
    if (closed) throw failure('浏览器预览服务已关闭。');
    if (typeof descriptor?.path !== 'string' || !path.isAbsolute(descriptor.path)) throw failure('缺少有效的文件路径。');
    const output = await watches.open({ path: descriptor.path, name: descriptor.name, resourceUri: descriptor.resourceUri });
    const session = {
      token: randomBytes(24).toString('base64url'),
      descriptor: { path: descriptor.path, name: descriptor.name, resourceUri: descriptor.resourceUri },
      output, preferences: { ...preferences }, lastUsed: Date.now(), busy: 1, closed: false, queue: Promise.resolve()
    };
    try {
      await ensureServer();
      sessions.set(session.token, session);
      const url = origin + '/' + session.token + '/';
      await openBrowser(url);
      ensureActive(session);
      return { url };
    } catch (error) {
      dispose(session);
      throw error;
    } finally {
      session.busy -= 1;
      session.lastUsed = Date.now();
    }
  }

  async function close() {
    closed = true;
    clearInterval(cleanup);
    for (const session of sessions.values()) dispose(session);
    if (server) {
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  }

  return { open, close };
}

module.exports = { createBrowserPreviews };
