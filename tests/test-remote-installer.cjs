'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('remote installer wrappers use the pinned release and forward local options', async () => {
  const shell = await fs.readFile(path.join(ROOT, 'install-remote.sh'), 'utf8');
  const powershell = await fs.readFile(path.join(ROOT, 'install-remote.ps1'), 'utf8');
  assert.match(shell, /Maker-Wen\/markdown-preview/);
  assert.match(shell, /v1\.0\.0/);
  assert.match(shell, /SHA256SUMS/);
  assert.match(shell, /install\.sh/);
  assert.match(powershell, /Maker-Wen\/markdown-preview/);
  assert.match(powershell, /SHA256SUMS/);
  assert.match(powershell, /install\.ps1/);
});

test('remote shell installer passes syntax check without network access', () => {
  execFileSync('sh', ['-n', path.join(ROOT, 'install-remote.sh')]);
});
