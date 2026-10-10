'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createBrowserPreviews } = require('./browser-preview.cjs');
const { createDocumentWatches } = require('./watch.cjs');

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text,
          json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function post(url, action, body = {}, headers = {}) {
  return request(url + action, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { idleMs, launch, render: customRender, watchIdleMs, onRelease } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-browser-preview-'));
  const directory = await fs.realpath(temporary);
  const launched = [];
  const released = [];
  const watched = [];
  const render = customRender || (async (_file, text) => ({ html: '<p>' + text + '</p>', toc: '' }));
  const watches = createDocumentWatches({ render, ...(watchIdleMs ? { idleMs: watchIdleMs } : {}) });
  const wrappedWatches = {
    open: async (...args) => { const result = await watches.open(...args); watched.push(result); return result; },
    refresh: (...args) => watches.refresh(...args),
    release: id => { released.push(id); watches.release(id); onRelease?.(id); }
  };
  const buildHtml = async (output, preferences) => '<!doctype html><title>Preview</title><script type="application/json">' +
    JSON.stringify({ output, preferences }) + '</script>';
  const previews = createBrowserPreviews({ watches: wrappedWatches, buildHtml,
    openBrowser: async url => { launched.push(url); if (launch) await launch(url); }, ...(idleMs ? { idleMs } : {}) });
  t.after(async () => { await previews.close(); watches.close(); await fs.rm(directory, { recursive: true, force: true }); });
  async function document(name = 'document.md', text = 'original') {
    const file = path.join(directory, name);
    await fs.writeFile(file, text);
    const descriptor = { path: file, name, resourceUri: 'codex-resource://test/' + name };
    return { file, descriptor };
  }
  return { directory, previews, watches, launched, released, watched, document };
}

function pageOutput(page) {
  return JSON.parse(page.text.match(/<script type="application\/json">(.+)<\/script>/)[1]);
}

test('service starts lazily on loopback and serves token-scoped HTML with the initial preferences', async t => {
  const { previews, launched, watched, document } = await fixture(t);
  assert.deepEqual(launched, []);
  assert.deepEqual(watched, []);
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, { theme: 'dark', toc: false });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/$/);
  assert.deepEqual(launched, [url]);
  const page = await request(url);
  assert.equal(page.status, 200);
  const initial = pageOutput(page);
  assert.equal(initial.output.text, 'original');
  assert.match(initial.output.watchId, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(initial.preferences, { theme: 'dark', toc: false });
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['access-control-allow-origin'], undefined);
});

test('HTTP refresh catches normal and atomic saves and GET reload retains the newest output', async t => {
  const { previews, document } = await fixture(t);
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  const { output } = pageOutput(await request(url));
  assert.deepEqual((await post(url, 'refresh', { watchId: output.watchId, revision: 1 })).json,
    { watchId: output.watchId, revision: 1 });
  await fs.writeFile(doc.file, 'normal save');
  const saved = await post(url, 'refresh', { watchId: output.watchId, revision: 1 });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.document.text, 'normal save');
  const temporary = doc.file + '.tmp';
  await fs.writeFile(temporary, 'atomic save');
  await fs.rename(temporary, doc.file);
  const atomic = await post(url, 'refresh', { watchId: output.watchId, revision: 2 });
  assert.equal(atomic.json.revision, 3);
  assert.equal(atomic.json.document.text, 'atomic save');
  assert.equal(pageOutput(await request(url)).output.text, 'atomic save');
});

test('unsupported routes return 404 without launching the browser', async t => {
  const { previews, launched, document } = await fixture(t);
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  assert.equal((await post(url, 'open-browser')).status, 404);
  assert.equal((await post(url, 'open-browser', { url: 'https://example.com' })).status, 404);
  assert.equal((await request(url + 'open-browser')).status, 404);
  assert.equal((await post(url, 'viewer-revision')).status, 404);
  assert.equal((await post(url, 'viewer-revision', { path: '/etc/passwd' })).status, 404);
  assert.equal((await request(url + 'viewer-revision')).status, 404);
  assert.deepEqual(launched, [url]);
  assert.deepEqual(pageOutput(await request(url)).preferences, {});
});

test('reopen replaces an expired watch, releases it and reads only the captured document', async t => {
  const { previews, watches, released, document } = await fixture(t);
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  const { output } = pageOutput(await request(url));
  watches.release(output.watchId);
  const expired = await post(url, 'refresh', { watchId: output.watchId, revision: 1 });
  assert.equal(expired.status, 410);
  assert.equal(expired.json.errorCode, 'WATCH_EXPIRED');
  await fs.writeFile(doc.file, 'reopened contents');
  const reopened = await post(url, 'reopen');
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.text, 'reopened contents');
  assert.equal(reopened.json.revision, 1);
  assert.notEqual(reopened.json.watchId, output.watchId);
  assert.ok(released.includes(output.watchId));
  assert.equal((await post(url, 'refresh', { watchId: output.watchId, revision: 1 })).json.code, 'WATCH_EXPIRED');
  assert.equal((await post(url, 'reopen', { path: '/etc/passwd' })).status, 400);
});

test('browser sessions have independent watches and cannot refresh another session', async t => {
  const { previews, watches, document } = await fixture(t);
  const first = await document('first.md', 'first');
  const second = await document('second.md', 'second');
  const embedded = await watches.open(first.descriptor);
  const [{ url: firstUrl }, { url: secondUrl }] = await Promise.all([
    previews.open(first.descriptor, {}), previews.open(second.descriptor, {})
  ]);
  const firstOutput = pageOutput(await request(firstUrl)).output;
  const secondOutput = pageOutput(await request(secondUrl)).output;
  assert.notEqual(firstOutput.watchId, embedded.watchId);
  assert.notEqual(firstOutput.watchId, secondOutput.watchId);
  assert.notEqual(firstUrl, secondUrl);
  await fs.writeFile(second.file, 'second changed');
  assert.equal((await post(firstUrl, 'refresh', { watchId: secondOutput.watchId, revision: 1 })).status, 410);
  assert.equal((await post(firstUrl, 'refresh', { watchId: firstOutput.watchId, revision: 1 })).json.revision, 1);
  assert.equal((await post(secondUrl, 'refresh', { watchId: secondOutput.watchId, revision: 1 })).json.document.text, 'second changed');
  await previews.close();
  assert.equal((await watches.refresh({ watchId: embedded.watchId, revision: 1, path: first.file })).revision, 1);
});

test('two tabs reconnecting the same expired session converge on one active watch', async t => {
  const { previews, watches, released, watched, document } = await fixture(t);
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  const firstTab = pageOutput(await request(url)).output;
  const secondTab = pageOutput(await request(url)).output;
  assert.equal(firstTab.watchId, secondTab.watchId);
  watches.release(firstTab.watchId);
  const stale = await Promise.all([firstTab, secondTab].map(tab =>
    post(url, 'refresh', { watchId: tab.watchId, revision: tab.revision })));
  assert.ok(stale.every(result => result.json.code === 'WATCH_EXPIRED'));
  await fs.writeFile(doc.file, 'changed before reconnect');
  const reopened = await Promise.all([post(url, 'reopen'), post(url, 'reopen')]);
  assert.ok(reopened.every(result => result.status === 200));
  assert.equal(reopened[0].json.watchId, reopened[1].json.watchId);
  assert.notEqual(reopened[0].json.watchId, firstTab.watchId);
  assert.equal(reopened[0].json.text, 'changed before reconnect');
  assert.equal(watched.length, 2);
  assert.deepEqual(released, [firstTab.watchId]);
  await fs.writeFile(doc.file, 'both tabs update');
  const refreshed = await Promise.all(reopened.map(tab =>
    post(url, 'refresh', { watchId: tab.json.watchId, revision: tab.json.revision })));
  assert.ok(refreshed.every(result => result.status === 200 && result.json.document.text === 'both tabs update'));
  const reused = await post(url, 'reopen');
  assert.equal(reused.json.watchId, reopened[0].json.watchId);
  assert.equal(reused.json.text, 'both tabs update');
  assert.equal(watched.length, 2);
});

test('expired reopen publishes its single read and the next refresh catches a save during render', { timeout: 3_000 }, async t => {
  const started = deferred();
  const resume = deferred();
  const rendered = [];
  let holdReopen = false;
  const { previews, watches, watched, document } = await fixture(t, {
    render: async (_file, text) => {
      rendered.push(text);
      if (holdReopen) {
        holdReopen = false;
        started.resolve();
        await resume.promise;
      }
      return { html: '<p>' + text + '</p>', toc: '' };
    }
  });
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  const initial = pageOutput(await request(url)).output;
  watches.release(initial.watchId);
  await fs.writeFile(doc.file, 'read before save');
  holdReopen = true;
  const reopening = post(url, 'reopen');
  await started.promise;
  await fs.writeFile(doc.file, 'saved during reopen render');
  resume.resolve();
  const reopened = await reopening;
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.text, 'read before save');
  assert.equal(reopened.json.html, '<p>read before save</p>');
  assert.equal(reopened.json.revision, 1);
  assert.notEqual(reopened.json.watchId, initial.watchId);
  assert.equal(watched.length, 2);
  assert.deepEqual(rendered, ['original', 'read before save']);
  const refreshed = await post(url, 'refresh', {
    watchId: reopened.json.watchId, revision: reopened.json.revision
  });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.revision, 2);
  assert.equal(refreshed.json.document.text, 'saved during reopen render');
  assert.deepEqual(rendered, ['original', 'read before save', 'saved during reopen render']);
});

test('close during an expired reopen render releases the newly opened watch', { timeout: 3_000 }, async t => {
  const started = deferred();
  const resume = deferred();
  const releasedNewWatch = deferred();
  let holdReopen = false;
  let initialId;
  const { previews, watches, watched, released, document } = await fixture(t, {
    render: async (_file, text) => {
      if (holdReopen) {
        holdReopen = false;
        started.resolve();
        await resume.promise;
      }
      return { html: '<p>' + text + '</p>', toc: '' };
    },
    onRelease: id => { if (id !== initialId) releasedNewWatch.resolve(); }
  });
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  const initial = pageOutput(await request(url)).output;
  initialId = initial.watchId;
  watches.release(initialId);
  await fs.writeFile(doc.file, 'unpublished reopen');
  holdReopen = true;
  const reopening = post(url, 'reopen').then(response => ({ response }), error => ({ error }));
  await started.promise;
  const closing = previews.close();
  resume.resolve();
  await closing;
  await releasedNewWatch.promise;
  const result = await reopening;
  assert.equal(result.response, undefined);
  assert.equal(result.error.code, 'ECONNRESET');
  assert.equal(watched.length, 2);
  const reopened = watched[1];
  assert.notEqual(reopened.watchId, initialId);
  assert.ok(released.includes(initialId));
  assert.ok(released.includes(reopened.watchId));
  await assert.rejects(watches.refresh({
    watchId: reopened.watchId, revision: 1, path: doc.file
  }), { code: 'WATCH_EXPIRED' });
  await assert.rejects(request(url), { code: 'ECONNREFUSED' });
});

test('host, origin and fetch-site guards reject cross-site access without CORS', async t => {
  const { previews, document } = await fixture(t);
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  const origin = new URL(url).origin;
  const cases = [
    { headers: { Host: 'evil.example' } },
    { headers: { Host: 'localhost:' + new URL(url).port } },
    { headers: { Origin: 'https://evil.example' } },
    { headers: { Origin: 'null' } },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } }
  ];
  for (const options of cases) {
    const denied = await request(url, options);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request(url, { headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await post(url, 'reopen', {}, { Origin: 'https://evil.example' })).status, 403);
});

test('only exact routes, supported methods and bounded JSON inputs are accepted', async t => {
  const { previews, document } = await fixture(t);
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  const { output } = pageOutput(await request(url));
  const origin = new URL(url).origin;
  for (const pathname of ['/', '/etc/passwd', new URL(url).pathname + '?path=private', new URL(url).pathname + '../private', new URL(url).pathname + '%72efresh']) {
    assert.equal((await request(origin + pathname)).status, 404);
  }
  assert.equal((await request(origin + '/' + 'x'.repeat(32) + '/')).status, 410);
  assert.equal((await request(url, { method: 'POST' })).status, 405);
  assert.equal((await request(url + 'refresh')).status, 405);
  assert.equal((await request(url, { method: 'OPTIONS' })).status, 405);
  assert.equal((await request(url + 'refresh', { method: 'POST', body: '{}' })).status, 415);
  for (const body of ['{', 'null', '[]', 'true']) {
    assert.equal((await post(url, 'refresh', body)).status, 400);
  }
  for (const body of [{}, { watchId: output.watchId, revision: 0 }, { watchId: output.watchId, revision: 1.5 },
    { watchId: output.watchId, revision: 1, path: '/etc/passwd' }, { watchId: 42, revision: 1 }]) {
    assert.equal((await post(url, 'refresh', body)).status, 400);
  }
  assert.equal((await post(url, 'refresh', ' '.repeat(2049))).status, 413);
  const localLink = await post(url, 'open-file', { path: '/etc/passwd' });
  assert.equal(localLink.status, 400);
  assert.match(localLink.json.error, /不支持打开本地文件/);
  assert.equal((await post(url, 'refresh', { watchId: output.watchId, revision: 1 })).status, 200);
});

test('read errors retain session state and later refresh recovers', async t => {
  const { previews, document } = await fixture(t);
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  const { output } = pageOutput(await request(url));
  await fs.unlink(doc.file);
  const unavailable = await post(url, 'refresh', { watchId: output.watchId, revision: 1 });
  assert.equal(unavailable.status, 500);
  assert.match(unavailable.json.error, /ENOENT/);
  assert.equal(pageOutput(await request(url)).output.text, 'original');
  await fs.writeFile(doc.file, 'restored');
  assert.equal((await post(url, 'refresh', { watchId: output.watchId, revision: 1 })).json.document.text, 'restored');
});

test('reopen rejects canonical-path redirection', async t => {
  const { previews, document } = await fixture(t);
  const doc = await document();
  const outside = await document('private.md', 'private contents');
  const { url } = await previews.open(doc.descriptor, {});
  await fs.unlink(doc.file);
  await fs.symlink(outside.file, doc.file);
  const redirected = await post(url, 'reopen');
  assert.equal(redirected.status, 400);
  assert.match(redirected.json.error, /重定向/);
  assert.ok(!redirected.text.includes('private contents'));
});

test('expired reopen redirection after reading preserves the browser error and skips render', async t => {
  const rendered = [];
  const { previews, watches, watched, document } = await fixture(t, {
    render: async (_file, text) => {
      rendered.push(text);
      return { html: '<p>' + text + '</p>', toc: '' };
    }
  });
  const doc = await document();
  const outside = await document('private.md', 'private contents');
  const { url } = await previews.open(doc.descriptor, {});
  const initial = pageOutput(await request(url)).output;
  watches.release(initial.watchId);
  await fs.writeFile(doc.file, 'read before redirect');
  const originalOpen = fs.open;
  let redirectedAfterRead = false;
  try {
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === doc.file) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          if (!redirectedAfterRead && result.bytesRead > 0) {
            redirectedAfterRead = true;
            await fs.unlink(doc.file);
            await fs.symlink(outside.file, doc.file);
          }
          return result;
        };
      }
      return handle;
    };
    const redirected = await post(url, 'reopen');
    assert.equal(redirectedAfterRead, true);
    assert.equal(redirected.status, 400);
    assert.equal(redirected.json.error, '文件路径已重定向，请从插件重新打开。');
    assert.ok(!redirected.text.includes('private contents'));
    assert.deepEqual(rendered, ['original']);
    assert.equal(watched.length, 1);
    assert.deepEqual(pageOutput(await request(url)).output, initial);
  } finally {
    fs.open = originalOpen;
  }
});

test('expired reopen redirection during render preserves the watch error and prior snapshot', async t => {
  const rendered = [];
  let redirectDuringRender = false;
  let documentPath;
  let outsidePath;
  const { previews, watches, watched, document } = await fixture(t, {
    render: async (_file, text) => {
      rendered.push(text);
      if (redirectDuringRender) {
        redirectDuringRender = false;
        await fs.unlink(documentPath);
        await fs.symlink(outsidePath, documentPath);
      }
      return { html: '<p>' + text + '</p>', toc: '' };
    }
  });
  const doc = await document();
  const outside = await document('private.md', 'private contents');
  documentPath = doc.file;
  outsidePath = outside.file;
  const { url } = await previews.open(doc.descriptor, {});
  const initial = pageOutput(await request(url)).output;
  watches.release(initial.watchId);
  await fs.writeFile(doc.file, 'render before redirect');
  redirectDuringRender = true;
  const redirected = await post(url, 'reopen');
  assert.equal(redirectDuringRender, false);
  assert.equal(redirected.status, 500);
  assert.equal(redirected.json.error, '文件路径已重定向，请重新打开预览。');
  assert.ok(!redirected.text.includes('private contents'));
  assert.deepEqual(rendered, ['original', 'render before redirect']);
  assert.equal(watched.length, 1);
  assert.deepEqual(pageOutput(await request(url)).output, initial);
});

test('launch failures clean up their watch and close stops the HTTP server', async t => {
  let attemptedUrl;
  const { previews, watched, released, document } = await fixture(t, { launch: async url => {
    attemptedUrl = url;
    throw new Error('browser launch failed');
  } });
  const doc = await document();
  await assert.rejects(previews.open(doc.descriptor, {}), /browser launch failed/);
  assert.deepEqual(released, [watched[0].watchId]);
  assert.equal((await request(attemptedUrl)).status, 410);
  await previews.close();
  await assert.rejects(request(attemptedUrl), { code: 'ECONNREFUSED' });
  await assert.rejects(previews.open(doc.descriptor, {}), /已关闭/);
});

test('closing before the first listen event rejects pending open and releases its watch', async () => {
  const released = [];
  const launches = [];
  const initial = { text: 'initial', watchId: 'w'.repeat(32), revision: 1 };
  const previews = createBrowserPreviews({
    watches: { open: async () => initial, refresh: async () => {}, release: id => released.push(id) },
    buildHtml: async () => '',
    openBrowser: async url => launches.push(url)
  });
  let deadline;
  try {
    const opening = previews.open({ path: path.join(os.tmpdir(), 'document.md'), name: 'document.md' }, {});
    const closing = Promise.resolve().then(() => previews.close());
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('pending open did not settle after close')), 1_000);
    });
    await assert.rejects(Promise.race([opening, timeout]), /服务已关闭/);
    await closing;
    assert.deepEqual(released, [initial.watchId]);
    assert.deepEqual(launches, []);
  } finally {
    clearTimeout(deadline);
    await previews.close();
  }
});

test('idle cleanup releases browser watches, while refresh and GET renew the lease', async t => {
  const { previews, released, document } = await fixture(t, { idleMs: 160 });
  const doc = await document();
  const { url } = await previews.open(doc.descriptor, {});
  const { output } = pageOutput(await request(url));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal((await post(url, 'refresh', { watchId: output.watchId, revision: 1 })).status, 200);
    assert.equal((await request(url)).status, 200);
  }
  assert.deepEqual(released, []);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((await request(url)).status, 410);
  assert.deepEqual(released, [output.watchId]);
});
