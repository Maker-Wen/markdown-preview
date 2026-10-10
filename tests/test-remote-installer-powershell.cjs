'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const repository = 'Maker-Wen/markdown-preview';
const release = 'v1.2.3';
const pwsh = process.env.MARKDOWN_PREVIEW_TEST_PWSH || 'pwsh';
const required = process.env.MARKDOWN_PREVIEW_REQUIRE_PWSH === '1';
const probe = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8', timeout: 30000
});

function powerShellAvailable(t) {
  if (probe.error?.code === 'ENOENT' && !required) {
    t.skip('pwsh is unavailable; PowerShell remote-installer execution was not verified');
    return false;
  }
  assert.equal(probe.error, undefined, 'pwsh is required when MARKDOWN_PREVIEW_REQUIRE_PWSH=1');
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  return true;
}

async function records(file) {
  try { return (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-powershell-remote-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets');
  const packaged = path.join(root, 'package', 'markdown-preview-' + release);
  const temporary = path.join(root, 'temporary');
  const requestLog = path.join(root, 'requests.jsonl');
  const installLog = path.join(root, 'install.jsonl');
  await Promise.all([assets, packaged, temporary].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(packaged, 'fixture.txt'), 'REAL_EXPAND_ARCHIVE_中文_PAYLOAD\n');
  await fs.writeFile(path.join(packaged, 'install.ps1'), String.raw`
$record = @{ script = $PSCommandPath; args = @($args); payload = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'fixture.txt') -Raw }
Add-Content -LiteralPath $env:MARKDOWN_PREVIEW_TEST_INSTALL_LOG -Value ($record | ConvertTo-Json -Compress) -Encoding utf8
exit ([int]$env:MARKDOWN_PREVIEW_TEST_INSTALL_EXIT)
`);

  const wrapper = path.join(root, 'invoke-remote.ps1');
  await fs.writeFile(wrapper, String.raw`
$ErrorActionPreference = 'Stop'
$forwarded = @($args)
$archiveName = 'markdown-preview-v1.2.3.zip'
$archive = Join-Path $env:MARKDOWN_PREVIEW_TEST_ASSETS $archiveName
Compress-Archive -LiteralPath $env:MARKDOWN_PREVIEW_TEST_PACKAGE -DestinationPath $archive
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($env:MARKDOWN_PREVIEW_TEST_BAD_CHECKSUM) { $hash = '0' * 64 }
Set-Content -LiteralPath (Join-Path $env:MARKDOWN_PREVIEW_TEST_ASSETS 'SHA256SUMS') -Value "$hash  $archiveName" -Encoding utf8

# The production script runs in a child scope and resolves these functions.
# Extraction, hash verification, argument forwarding and cleanup stay real.
function Invoke-RestMethod {
    param([string]$Uri, [hashtable]$Headers)
    $expected = 'https://api.github.com/repos/' + $env:MARKDOWN_PREVIEW_TEST_REPOSITORY + '/releases/latest'
    if ($Uri -ne $expected) { throw "Unexpected latest-release URL: $Uri" }
    Add-Content -LiteralPath $env:MARKDOWN_PREVIEW_TEST_REQUEST_LOG -Value (@{ method = 'rest'; uri = $Uri } | ConvertTo-Json -Compress) -Encoding utf8
    return [pscustomobject]@{ tag_name = 'v1.2.3'; draft = $false; prerelease = $false }
}

function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [Parameter(Position = 0)][string]$Uri, [string]$OutFile)
    $base = 'https://github.com/' + $env:MARKDOWN_PREVIEW_TEST_REPOSITORY + '/releases/download/v1.2.3/'
    if ($Uri -eq ($base + 'markdown-preview-v1.2.3.zip')) { $name = 'markdown-preview-v1.2.3.zip' }
    elseif ($Uri -eq ($base + 'SHA256SUMS')) { $name = 'SHA256SUMS' }
    else { throw "Unexpected download URL: $Uri" }
    Add-Content -LiteralPath $env:MARKDOWN_PREVIEW_TEST_REQUEST_LOG -Value (@{ method = 'web'; uri = $Uri; output = $OutFile } | ConvertTo-Json -Compress) -Encoding utf8
    Copy-Item -LiteralPath (Join-Path $env:MARKDOWN_PREVIEW_TEST_ASSETS $name) -Destination $OutFile
}

& $env:MARKDOWN_PREVIEW_TEST_REMOTE @forwarded
exit $LASTEXITCODE
`);

  function run(args = [], settings = {}) {
    const env = {
      ...process.env,
      TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      MARKDOWN_PREVIEW_TEST_REMOTE: path.join(ROOT, 'install-remote.ps1'),
      MARKDOWN_PREVIEW_TEST_PACKAGE: packaged,
      MARKDOWN_PREVIEW_TEST_ASSETS: assets,
      MARKDOWN_PREVIEW_TEST_REPOSITORY: repository,
      MARKDOWN_PREVIEW_TEST_REQUEST_LOG: requestLog,
      MARKDOWN_PREVIEW_TEST_INSTALL_LOG: installLog,
      MARKDOWN_PREVIEW_TEST_INSTALL_EXIT: '0'
    };
    delete env.MARKDOWN_PREVIEW_REPOSITORY;
    delete env.MARKDOWN_PREVIEW_VERSION;
    delete env.MARKDOWN_PREVIEW_TEST_BAD_CHECKSUM;
    Object.assign(env, settings);
    return spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper, ...args], {
      cwd: root, encoding: 'utf8', timeout: 30000, env
    });
  }

  async function clean() {
    assert.deepEqual(await fs.readdir(temporary), [], 'the real remote installer must remove its temporary directory');
  }
  return { root, temporary, requestLog, installLog, run, clean };
}

function succeeded(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

const expectedUrls = [
  `https://api.github.com/repos/${repository}/releases/latest`,
  `https://github.com/${repository}/releases/download/${release}/markdown-preview-${release}.zip`,
  `https://github.com/${repository}/releases/download/${release}/SHA256SUMS`
];

test('PowerShell latest resolves once, verifies and expands the archive, and preserves forwarded argument boundaries', async t => {
  if (!powerShellAvailable(t)) return;
  const f = await fixture(t);
  const args = ['--dry-run', '--install-dir', path.join(f.root, '目录 with spaces'), '--codex', 'C:\\工具目录\\Codex CLI\\codex.js'];
  succeeded(f.run(args));
  const requests = await records(f.requestLog);
  assert.deepEqual(requests.map(request => request.uri), expectedUrls);
  assert.equal(requests.filter(request => request.method === 'rest').length, 1);
  const installed = await records(f.installLog);
  assert.equal(installed.length, 1);
  assert.deepEqual(installed[0].args, args);
  assert.equal(installed[0].payload, 'REAL_EXPAND_ARCHIVE_中文_PAYLOAD\n');
  assert.ok(installed[0].script.startsWith(f.temporary + path.sep), 'the invoked installer must come from the actual extracted download');
  await f.clean();
});

test('PowerShell rejects an incorrect archive checksum before invoking the installer and cleans downloads', async t => {
  if (!powerShellAvailable(t)) return;
  const f = await fixture(t);
  const result = f.run([], { MARKDOWN_PREVIEW_TEST_BAD_CHECKSUM: '1' });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /SHA-256/);
  assert.deepEqual((await records(f.requestLog)).map(request => request.uri), expectedUrls);
  assert.deepEqual(await records(f.installLog), []);
  await f.clean();
});

test('PowerShell propagates the packaged installer exit code and cleans extracted files', async t => {
  if (!powerShellAvailable(t)) return;
  const f = await fixture(t);
  const result = f.run([], { MARKDOWN_PREVIEW_TEST_INSTALL_EXIT: '73' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 73, result.stdout + result.stderr);
  assert.equal((await records(f.installLog)).length, 1);
  await f.clean();
});

test('PowerShell help does not query or download a release', async t => {
  if (!powerShellAvailable(t)) return;
  const f = await fixture(t);
  const result = f.run(['--help']);
  succeeded(result);
  assert.match(result.stdout, /latest/);
  assert.deepEqual(await records(f.requestLog), []);
  assert.deepEqual(await records(f.installLog), []);
  await f.clean();
});
