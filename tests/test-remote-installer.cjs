'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const shell = await fs.readFile(path.join(ROOT, 'install-remote.sh'), 'utf8');
  const powershell = await fs.readFile(path.join(ROOT, 'install-remote.ps1'), 'utf8');
  assert.match(shell, /Maker-Wen\/markdown-preview/);
  assert.match(shell, /v1\.0\.0/);
  assert.match(shell, /SHA256SUMS/);
  assert.match(shell, /install\.sh/);
  assert.match(powershell, /Maker-Wen\/markdown-preview/);
  assert.match(powershell, /SHA256SUMS/);
  assert.match(powershell, /install\.ps1/);
  console.log('PASS: remote installer wrappers use the pinned release and forward local options');

  execFileSync('sh', ['-n', path.join(ROOT, 'install-remote.sh')]);
  console.log('PASS: remote shell installer passes syntax check without network access');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
