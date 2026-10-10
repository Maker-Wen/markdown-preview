'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { readRegularFile } = require('./files.cjs');

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

// Sessions are created only for paths already authorized by the file-viewer host.
// Every later read revalidates that canonical path, including its parent directories.
function createDocumentWatches({ render, idleMs = 5 * 60 * 1000 } = {}) {
  if (typeof render !== 'function') throw new TypeError('render is required.');
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new TypeError('idleMs must be positive.');
  const sessions = new Map();
  let closed = false;

  function dispose(session) {
    session.closed = true;
    clearTimeout(session.debounce);
    session.watcher?.close();
    sessions.delete(session.id);
  }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (!session.busy && now - session.lastUsed >= idleMs) dispose(session);
    }
  }, Math.min(idleMs, 30_000));
  cleanup.unref();

  function pathRedirectionError(beforeInitialRender) {
    return Object.assign(new Error('文件路径已重定向，请重新打开预览。'), { pathRedirectedBeforeRender: beforeInitialRender });
  }

  async function checkPath(file, beforeInitialRender = false) {
    if (await fsp.realpath(file) !== file) {
      throw pathRedirectionError(beforeInitialRender);
    }
    const stat = await fsp.lstat(file, { bigint: true });
    if (!stat.isFile()) throw new Error('只能预览普通文件。');
    if (await fsp.realpath(file) !== file) {
      throw pathRedirectionError(beforeInitialRender);
    }
    return fingerprint(stat);
  }

  function ensureActive(session) {
    if (closed || session.closed) throw new Error('预览监听已结束，请重新打开文件。');
  }

  async function readSource(file) {
    const bytes = await readRegularFile(file);
    return { text: bytes.toString('utf8'), bytes: bytes.length };
  }

  async function renderSnapshot({ path: file, name, resourceUri }, source) {
    const rendered = await render(file, source.text);
    return { name, resourceUri, text: source.text, ...rendered, bytes: source.bytes };
  }

  async function update(session) {
    ensureActive(session);
    // A bounded retry avoids publishing a render whose source changed meanwhile.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await checkPath(session.path);
      ensureActive(session);
      if (!session.dirty && before === session.fingerprint) return;
      const source = await readSource(session.path);
      const afterRead = await checkPath(session.path);
      ensureActive(session);
      if (before !== afterRead) continue;
      if (source.text === session.text) {
        session.fingerprint = afterRead;
        session.dirty = false;
        return;
      }
      const snapshot = await renderSnapshot(session, source);
      const afterRender = await checkPath(session.path);
      ensureActive(session);
      if (afterRead !== afterRender) continue;
      session.text = source.text;
      session.fingerprint = afterRender;
      session.dirty = false;
      session.revision += 1;
      session.output = {
        ...snapshot,
        watchId: session.id, revision: session.revision
      };
      return;
    }
    throw new Error('文件正在持续变化，将在下次刷新时重试。');
  }

  async function open({ path: file, name, resourceUri }) {
    if (closed) throw new Error('预览监听已结束。');
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('缺少有效的文件路径。');
    await checkPath(file, true);
    if (closed) throw new Error('预览监听已结束。');
    const source = await readSource(file);
    if (closed) throw new Error('预览监听已结束。');
    await checkPath(file, true);
    if (closed) throw new Error('预览监听已结束。');
    // Open renders once; the first refresh catches saves made during this render.
    const initialOutput = await renderSnapshot({ path: file, name, resourceUri }, source);
    if (closed) throw new Error('预览监听已结束。');
    await checkPath(file);
    if (closed) throw new Error('预览监听已结束。');
    const id = randomBytes(24).toString('base64url');
    const session = {
      id, path: file, name, resourceUri, text: initialOutput.text,
      output: { ...initialOutput, watchId: id, revision: 1 }, revision: 1,
      // Checking once after the watch starts closes the initial-read/watch race.
      fingerprint: null, dirty: true, closed: false, busy: 0,
      lastUsed: Date.now(), queue: Promise.resolve(), watcher: null, debounce: null
    };
    try {
      session.watcher = fs.watch(path.dirname(file), { persistent: false }, (_event, filename) => {
        if (filename != null && filename.toString() !== path.basename(file)) return;
        clearTimeout(session.debounce);
        session.debounce = setTimeout(() => { session.dirty = true; }, 100);
        session.debounce.unref();
      });
      // Polling stat remains effective if the parent directory is moved or watch fails.
      session.watcher.on('error', () => {
        session.dirty = true;
        session.watcher?.close();
        session.watcher = null;
      });
    } catch {
      // Some filesystems do not provide native watchers; stat is the fallback.
    }
    sessions.set(id, session);
    return session.output;
  }

  async function refresh({ watchId, revision, path: resourcePath }) {
    const session = sessions.get(watchId);
    if (!session || closed) {
      const error = new Error('预览监听已过期，请重新打开文件。');
      error.code = 'WATCH_EXPIRED';
      throw error;
    }
    if (typeof resourcePath !== 'string' || !path.isAbsolute(resourcePath) ||
        await fsp.realpath(resourcePath) !== session.path) {
      throw new Error('缺少匹配的宿主文件上下文，请重新打开预览。');
    }
    session.lastUsed = Date.now();
    session.busy += 1;
    // Serial work prevents concurrent tool calls from publishing out of order.
    const work = session.queue.then(() => update(session));
    session.queue = work.catch(() => { session.dirty = true; });
    try {
      await work;
      const response = { watchId: session.id, revision: session.revision };
      if (revision !== session.revision) response.document = session.output;
      return response;
    } finally {
      session.busy -= 1;
      session.lastUsed = Date.now();
    }
  }

  function close() {
    closed = true;
    clearInterval(cleanup);
    for (const session of sessions.values()) dispose(session);
  }

  function release(watchId) {
    const session = sessions.get(watchId);
    if (session) dispose(session);
  }

  return { open, refresh, release, close };
}

module.exports = { createDocumentWatches };
