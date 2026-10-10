'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { test } = require('node:test');
const { getBrowserCommand, openBrowser } = require('./browser.cjs');

test('each platform opens an HTTP URL through its default URL handler with separate arguments', () => {
  const url = 'http://127.0.0.1:43123/token/';
  assert.deepEqual(getBrowserCommand(url, 'darwin'), { file: '/usr/bin/open', args: [url] });
  assert.deepEqual(getBrowserCommand(url, 'win32'), { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] });
  assert.deepEqual(getBrowserCommand(url, 'linux'), { file: 'xdg-open', args: [url] });
  assert.throws(() => getBrowserCommand(url, 'unknown'), /不支持/);
});

test('loopback addresses and Unicode paths are normalized before launching', () => {
  for (const host of ['localhost', '127.0.0.1', '127.12.34.56', '[::1]']) {
    const url = `http://${host}:43123/中文 文件/?标题=第一 章#目录`;
    const { args } = getBrowserCommand(url, 'linux');
    assert.equal(args[0], new URL(url).href);
    assert.ok(args[0].includes('%E4%B8%AD%E6%96%87%20'));
  }
  assert.equal(getBrowserCommand('HTTP://LOCALHOST:80', 'linux').args[0], 'http://localhost/');
});

test('non-HTTP, non-loopback, credentialed, malformed, and control-character URLs are rejected', () => {
  const invalid = [
    '', ' ', null, undefined, {}, 12, '/tmp/document.html',
    'file:///tmp/document.html', 'javascript:alert(1)', 'https://127.0.0.1/',
    'http://example.com/', 'http://127.0.0.1.example.com/', 'http://localhost.example.com/',
    'http://0.0.0.0/', 'http://192.168.1.2/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/',
    'http://user:secret@127.0.0.1/', 'http://user@localhost/', 'http://@127.0.0.1/',
    'http://127.0.0.1:99999/', 'http://127.0.0.1/\nopen', 'http://127.0.0.1/\u0000',
    '--help', 'http://127.0.0.1@evil.example/'
  ];
  for (const url of invalid) assert.throws(() => getBrowserCommand(url, 'linux'), /HTTP URL/);
});

test('shell metacharacters stay inside one URL argument', () => {
  const url = 'http://127.0.0.1:43123/token/?x=$(touch /tmp/unwanted);&y=`whoami`&z="quoted"';
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { args } = getBrowserCommand(url, platform);
    assert.equal(args.at(-1), new URL(url).href);
    assert.equal(args.length, platform === 'win32' ? 2 : 1);
  }
});

test('openBrowser disables shell execution and waits for the handler result', async t => {
  const url = 'http://127.0.0.1:43123/token/';
  let complete;
  const execFile = t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    assert.deepEqual({ file, args }, getBrowserCommand(url));
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0);
    complete = callback;
  });
  let finished = false;
  const opening = openBrowser(url).then(() => { finished = true; });
  assert.equal(execFile.mock.callCount(), 1);
  assert.equal(finished, false);
  complete(null);
  await opening;
  assert.equal(finished, true);
});

test('handler failure provides an actionable error and preserves the cause', async t => {
  const failure = Object.assign(new Error('xdg-open unavailable'), { code: 'ENOENT' });
  t.mock.method(childProcess, 'execFile', (_file, _args, _options, callback) => callback(failure));
  await assert.rejects(openBrowser('http://127.0.0.1:43123/token/'), error => {
    assert.equal(error.code, 'BROWSER_OPEN_FAILED');
    assert.equal(error.cause, failure);
    assert.match(error.message, /浏览器设置后重试/);
    return true;
  });
});

test('invalid input never invokes the browser handler', async t => {
  const execFile = t.mock.method(childProcess, 'execFile', () => { throw new Error('unexpected launch'); });
  await assert.rejects(openBrowser('https://evil.example/'), /HTTP URL/);
  assert.equal(execFile.mock.callCount(), 0);
});
