'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { createDocumentWatches } = require('./watch.cjs');

async function fixture(t, options = {}) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-watch-'));
  const directory = await fsp.realpath(temporary);
  const file = path.join(directory, 'document.md');
  const renders = [];
  const watches = createDocumentWatches({
    ...options,
    render: async (file, text) => {
      renders.push(text);
      return options.render ? options.render(file, text) : { html: '<p>' + text + '</p>', toc: '' };
    }
  });
  t.after(async () => { watches.close(); await fsp.rm(directory, { recursive: true, force: true }); });
  await fsp.writeFile(file, 'original');
  const initial = await watches.open({ path: file, name: path.basename(file), resourceUri: 'codex-resource://test' });
  const refresh = revision => watches.refresh({ watchId: initial.watchId, revision: revision ?? initial.revision, path: file });
  return { directory, file, renders, watches, initial, refresh };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('saved text refreshes once; unchanged content does not render or bump revision', async t => {
  const { file, initial, refresh, renders } = await fixture(t);
  assert.equal(initial.name, 'document.md');
  assert.equal(initial.resourceUri, 'codex-resource://test');
  assert.equal(initial.text, 'original');
  assert.equal(initial.bytes, 8);
  assert.equal(initial.html, '<p>original</p>');
  assert.equal(initial.toc, '');
  assert.equal(initial.revision, 1);
  assert.match(initial.watchId, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(await refresh(), { watchId: initial.watchId, revision: 1 });
  await fsp.writeFile(file, 'changed');
  const changed = await refresh();
  assert.equal(changed.revision, 2);
  assert.equal(changed.document.text, 'changed');
  assert.equal(changed.document.bytes, 7);
  assert.equal(changed.document.html, '<p>changed</p>');
  await fsp.writeFile(file, 'changed');
  assert.deepEqual(await refresh(2), { watchId: initial.watchId, revision: 2 });
  assert.deepEqual(renders, ['original', 'changed']);
  assert.equal((await refresh(1)).document.text, 'changed');
});

test('first refresh catches a save during initial rendering', async t => {
  const started = deferred();
  const release = deferred();
  const { file, watches, renders } = await fixture(t, {
    render: async (_file, text) => {
      if (text === 'old render') { started.resolve(); await release.promise; }
      return { html: '<p>' + text + '</p>', toc: '' };
    }
  });
  await fsp.writeFile(file, 'old render');
  const opening = watches.open({ path: file, name: 'document.md', resourceUri: 'codex-resource://race' });
  try {
    await started.promise;
    await fsp.writeFile(file, 'new before watch');
  } finally {
    release.resolve();
  }
  const initial = await opening;
  assert.equal(initial.text, 'old render');
  assert.equal(initial.revision, 1);
  const latest = await watches.refresh({ watchId: initial.watchId, revision: 1, path: file });
  assert.equal(latest.document.text, 'new before watch');
  assert.equal(latest.revision, 2);
  assert.deepEqual(renders, ['original', 'old render', 'new before watch']);
});

test('atomic replacement and delete/recreate recover with the existing session', async t => {
  const { directory, file, refresh, renders } = await fixture(t);
  const replacement = path.join(directory, 'save.tmp');
  await fsp.writeFile(replacement, 'atomic');
  await fsp.rename(replacement, file);
  assert.equal((await refresh()).document.text, 'atomic');
  await fsp.unlink(file);
  await assert.rejects(refresh(2), { code: 'ENOENT' });
  await assert.rejects(refresh(2), { code: 'ENOENT' });
  await fsp.writeFile(file, 'recreated');
  const recovered = await refresh(2);
  assert.equal(recovered.revision, 3);
  assert.equal(recovered.document.text, 'recreated');
  assert.deepEqual(renders, ['original', 'atomic', 'recreated']);
});

test('sessions and host file contexts are isolated', async t => {
  const { directory, file, initial, watches, refresh } = await fixture(t);
  const other = path.join(directory, 'other.md');
  await fsp.writeFile(other, 'other original');
  const second = await watches.open({ path: other, name: 'other.md', resourceUri: 'codex-resource://other' });
  assert.notEqual(initial.watchId, second.watchId);
  await assert.rejects(watches.refresh({ watchId: initial.watchId, revision: 1, path: other }), /宿主文件上下文/);
  await assert.rejects(watches.refresh({ watchId: initial.watchId, revision: 1 }), /宿主文件上下文/);
  await fsp.writeFile(other, 'other changed');
  assert.equal((await watches.refresh({ watchId: second.watchId, revision: 1, path: other })).document.text, 'other changed');
  assert.equal((await refresh()).revision, 1);
  await assert.rejects(watches.refresh({ watchId: 'unknown', revision: 1, path: file }), { code: 'WATCH_EXPIRED' });
});

test('symlink replacement and parent path redirection cannot read another document', async t => {
  const { directory, file, initial, watches, refresh, renders } = await fixture(t);
  const outside = path.join(directory, 'outside.md');
  await fsp.writeFile(outside, 'private outside');
  await fsp.unlink(file);
  await fsp.symlink(outside, file);
  await assert.rejects(refresh(), /宿主文件上下文/);
  await assert.rejects(watches.open({ path: file, name: 'document.md', resourceUri: 'codex-resource://symlink' }), /重定向/);
  await fsp.unlink(file);
  await fsp.writeFile(file, 'restored');
  assert.equal((await refresh()).document.text, 'restored');

  const nested = path.join(directory, 'nested');
  const redirected = path.join(directory, 'redirected');
  await fsp.mkdir(nested);
  await fsp.mkdir(redirected);
  const nestedFile = path.join(nested, 'nested.md');
  await fsp.writeFile(nestedFile, 'inside');
  await fsp.writeFile(path.join(redirected, 'nested.md'), 'outside');
  const nestedWatch = await watches.open({ path: nestedFile, name: 'nested.md', resourceUri: 'codex-resource://nested' });
  await fsp.rename(nested, nested + '-old');
  await fsp.symlink(redirected, nested);
  await assert.rejects(watches.refresh({ watchId: nestedWatch.watchId, revision: 1, path: nestedFile }), /宿主文件上下文/);
  assert.deepEqual(renders, ['original', 'restored', 'inside']);
  assert.equal(initial.revision, 1);
});

test('directories and FIFOs are rejected without blocking', async t => {
  const { directory, file, watches, refresh, renders } = await fixture(t);
  await assert.rejects(watches.open({ path: directory, name: 'directory.md', resourceUri: 'codex-resource://directory' }), /普通文件/);
  await fsp.unlink(file);
  await fsp.mkdir(file);
  await assert.rejects(refresh(), /普通文件/);
  await fsp.rmdir(file);
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [file]);
    await assert.rejects(refresh(), /普通文件/);
    await assert.rejects(watches.open({ path: file, name: 'document.md', resourceUri: 'codex-resource://fifo' }), /普通文件/);
  }
  assert.deepEqual(renders, ['original']);
});

test('concurrent refreshes never publish a render superseded while it was running', async t => {
  const started = deferred();
  const release = deferred();
  const { file, refresh, renders } = await fixture(t, {
    render: async (_file, text) => {
      if (text === 'older') { started.resolve(); await release.promise; }
      return { html: '<p>' + text + '</p>', toc: '' };
    }
  });
  await fsp.writeFile(file, 'older');
  const first = refresh();
  await started.promise;
  await fsp.writeFile(file, 'newer');
  const second = refresh();
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.document.text), ['newer', 'newer']);
  assert.deepEqual(results.map(result => result.revision), [2, 2]);
  assert.deepEqual(renders, ['original', 'older', 'newer']);
});

test('render failures preserve revision and recover on a later refresh', async t => {
  let fail = true;
  const { file, refresh } = await fixture(t, {
    render: async (_file, text) => {
      if (fail && text !== 'original') throw new Error('render failed');
      return { html: '<p>' + text + '</p>', toc: '' };
    }
  });
  await fsp.writeFile(file, 'retry');
  await assert.rejects(refresh(), /render failed/);
  fail = false;
  const recovered = await refresh();
  assert.equal(recovered.revision, 2);
  assert.equal(recovered.document.text, 'retry');
});

test('idle sessions expire and close releases native watchers', async t => {
  const originalWatch = fs.watch;
  const created = [];
  fs.watch = (...args) => {
    assert.equal(args[1].persistent, false);
    const watcher = originalWatch(...args);
    const originalClose = watcher.close.bind(watcher);
    const record = { closed: false };
    watcher.close = () => { record.closed = true; return originalClose(); };
    created.push(record);
    return watcher;
  };
  let data;
  try { data = await fixture(t, { idleMs: 30 }); }
  finally { fs.watch = originalWatch; }
  await new Promise(resolve => setTimeout(resolve, 90));
  await assert.rejects(data.refresh(), { code: 'WATCH_EXPIRED' });
  assert.equal(created.length, 1);
  assert.equal(created[0].closed, true);
  data.watches.close();
  await assert.rejects(data.watches.open({ path: data.file, name: 'document.md', resourceUri: 'codex-resource://closed' }), /已结束/);
});

test('close rejects an in-flight render and future refreshes', async t => {
  const started = deferred();
  const release = deferred();
  const { file, watches, refresh } = await fixture(t, {
    render: async (_file, text) => {
      if (text === 'changed') { started.resolve(); await release.promise; }
      return { html: text, toc: '' };
    }
  });
  await fsp.writeFile(file, 'changed');
  const pending = refresh();
  await started.promise;
  watches.close();
  release.resolve();
  await assert.rejects(pending, /已结束/);
  await assert.rejects(refresh(), { code: 'WATCH_EXPIRED' });
});

test('close during initial rendering rejects open without registering a native watcher', async t => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-opening-'));
  const directory = await fsp.realpath(temporary);
  const file = path.join(directory, 'document.md');
  const started = deferred();
  const release = deferred();
  const watches = createDocumentWatches({
    render: async (_file, text) => {
      started.resolve();
      await release.promise;
      return { html: '<p>' + text + '</p>', toc: '' };
    }
  });
  t.after(async () => { watches.close(); await fsp.rm(directory, { recursive: true, force: true }); });
  await fsp.writeFile(file, 'original');
  const originalWatch = fs.watch;
  const created = [];
  fs.watch = (...args) => {
    const watcher = originalWatch(...args);
    created.push(watcher);
    return watcher;
  };
  try {
    const opening = watches.open({ path: file, name: 'document.md', resourceUri: 'codex-resource://opening' });
    await started.promise;
    watches.close();
    release.resolve();
    await assert.rejects(opening, /已结束/);
    assert.equal(created.length, 0);
    await assert.rejects(watches.open({ path: file, name: 'document.md', resourceUri: 'codex-resource://closed' }), /已结束/);
  } finally {
    release.resolve();
    watches.close();
    fs.watch = originalWatch;
  }
});
