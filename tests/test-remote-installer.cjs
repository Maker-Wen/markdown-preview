'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { gzipSync } = require('node:zlib');
const ROOT = path.resolve(__dirname, '..');
const supported = process.platform !== 'win32';
const repository = 'Maker-Wen/markdown-preview';
const release = 'v1.2.3';
const archiveRoot = 'markdown-preview-' + release;

// Raw USTAR entries retain malicious paths exactly; a tar writer may sanitize
// them before the installer can exercise its preflight rejection.
function tarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents || '');
    const header = Buffer.alloc(512);
    const write = (value, offset, length) => header.write(value, offset, length, 'utf8');
    const octal = (value, offset, length) => write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    write(entry.name, 0, 100);
    octal(entry.type === '5' ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(contents.length, 124, 12);
    octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    write(entry.type || '0', 156, 1);
    write('ustar\0', 257, 6);
    write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, contents, Buffer.alloc((512 - contents.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function records(file) {
  try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function fixture(t, extraEntries = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-remote-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const assets = path.join(root, 'assets');
  const temporary = path.join(root, 'temporary');
  const curlLog = path.join(root, 'curl.jsonl');
  const installLog = path.join(root, 'install.jsonl');
  await Promise.all([bin, assets, temporary].map(dir => fs.mkdir(dir)));

  // The downloaded package has a tiny installer stub. Neither the actual plugin
  // installer nor any network program is invoked by these integration tests.
  const installer = `#!/bin/sh
exec "$MARKDOWN_PREVIEW_TEST_NODE" "$MARKDOWN_PREVIEW_TEST_INSTALL_STUB" "$0" "$@"
`;
  const archive = path.join(assets, archiveRoot + '.tar.gz');
  await fs.writeFile(archive, tarArchive([
    { name: archiveRoot + '/', type: '5' },
    { name: archiveRoot + '/install.sh', contents: installer },
    ...extraEntries
  ]));
  const hash = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await fs.writeFile(path.join(assets, 'SHA256SUMS'), hash + '  ' + path.basename(archive) + '\n');
  await fs.writeFile(path.join(root, 'install-stub.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const metadata = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.name.startsWith('._')) metadata.push(file);
    if (entry.isDirectory()) visit(file);
  }
}
visit(path.dirname(path.dirname(process.argv[2])));
fs.appendFileSync(process.env.MARKDOWN_PREVIEW_TEST_INSTALL_LOG,
  JSON.stringify({ script: process.argv[2], args: process.argv.slice(3), metadata }) + '\\n');
process.exitCode = Number(process.env.MARKDOWN_PREVIEW_TEST_INSTALL_EXIT || 0);
`);

  const fakeCurl = path.join(bin, 'curl');
  await fs.writeFile(fakeCurl, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith('https://'));
fs.appendFileSync(process.env.MARKDOWN_PREVIEW_TEST_CURL_LOG, JSON.stringify({ url, args }) + '\\n');
if (url === 'https://github.com/' + process.env.MARKDOWN_PREVIEW_TEST_REPOSITORY + '/releases/latest') {
  if (process.env.MARKDOWN_PREVIEW_TEST_LATEST_EXIT) {
    console.error('fixture: latest release is unavailable');
    process.exit(Number(process.env.MARKDOWN_PREVIEW_TEST_LATEST_EXIT));
  }
  // A second latest lookup would resolve another release. Download URLs must
  // remain tied to the first resolved tag throughout this installation.
  const calls = fs.readFileSync(process.env.MARKDOWN_PREVIEW_TEST_CURL_LOG, 'utf8').trim().split('\\n').map(JSON.parse);
  const latestCalls = calls.filter(call => call.url === url).length;
  process.stdout.write(latestCalls > 1 ? url.replace('/latest', '/tag/v9.9.9') : process.env.MARKDOWN_PREVIEW_TEST_LATEST_URL);
} else {
  const base = 'https://github.com/' + process.env.MARKDOWN_PREVIEW_TEST_REPOSITORY + '/releases/download/${release}/';
  if (!url || !url.startsWith(base)) {
    console.error('fixture: unexpected download URL ' + url);
    process.exit(91);
  }
  const outputIndex = args.findIndex(arg => arg === '-o' || arg === '--output');
  if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(92);
  const name = url.slice(base.length);
  if (name === 'SHA256SUMS' && process.env.MARKDOWN_PREVIEW_TEST_BAD_CHECKSUM) {
    fs.writeFileSync(args[outputIndex + 1], '0'.repeat(64) + '  markdown-preview-${release}.tar.gz\\n');
  } else if (name === 'SHA256SUMS' && process.env.MARKDOWN_PREVIEW_TEST_MISSING_CHECKSUM) {
    fs.writeFileSync(args[outputIndex + 1], '0'.repeat(64) + '  another-package.tar.gz\\n');
  } else {
    fs.copyFileSync(path.join(process.env.MARKDOWN_PREVIEW_TEST_ASSETS, name), args[outputIndex + 1]);
  }
}
`);
  await fs.chmod(fakeCurl, 0o755);

  function run(args = [], settings = {}) {
    const env = {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      TMPDIR: temporary,
      MARKDOWN_PREVIEW_TEST_NODE: process.execPath,
      MARKDOWN_PREVIEW_TEST_INSTALL_STUB: path.join(root, 'install-stub.cjs'),
      MARKDOWN_PREVIEW_TEST_INSTALL_LOG: installLog,
      MARKDOWN_PREVIEW_TEST_CURL_LOG: curlLog,
      MARKDOWN_PREVIEW_TEST_ASSETS: assets,
      MARKDOWN_PREVIEW_TEST_REPOSITORY: repository,
      MARKDOWN_PREVIEW_TEST_LATEST_URL: `https://github.com/${repository}/releases/tag/${release}`
    };
    // Host overrides must not change the meaning of the default-version test.
    delete env.MARKDOWN_PREVIEW_VERSION;
    delete env.MARKDOWN_PREVIEW_REPOSITORY;
    Object.assign(env, settings);
    return spawnSync('sh', [path.join(ROOT, 'install-remote.sh'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 30000, env
    });
  }

  async function clean() {
    assert.deepEqual(await fs.readdir(temporary), [], 'remote installer must remove its temporary directory');
  }
  return { root, run, clean, curlLog, installLog };
}

function succeeded(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function failed(result) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'installer unexpectedly succeeded\n' + result.stdout + result.stderr);
}

test('shell wrapper has valid syntax', { skip: !supported }, () => {
  execFileSync('sh', ['-n', path.join(ROOT, 'install-remote.sh')]);
});

test('PowerShell wrapper retains download verification and installer forwarding', async t => {
  const powershell = await fs.readFile(path.join(ROOT, 'install-remote.ps1'), 'utf8');
  assert.match(powershell, /SHA256SUMS/);
  assert.match(powershell, /Get-FileHash/);
  assert.match(powershell, /install\.ps1/);
  assert.match(powershell, /@args/);
  assert.doesNotMatch(powershell, /\[CmdletBinding\(\)\]|\bparam\(\)/);
  const probe = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
  if (probe.error && probe.error.code === 'ENOENT') {
    t.diagnostic('pwsh unavailable: only static PowerShell checks were performed; Windows execution was not tested.');
    return;
  }
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
  const parse = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', `
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($env:MARKDOWN_PREVIEW_TEST_PS1, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { $errors | Write-Error; exit 1 }
`], {
    encoding: 'utf8', env: { ...process.env, MARKDOWN_PREVIEW_TEST_PS1: path.join(ROOT, 'install-remote.ps1') }
  });
  assert.equal(parse.error, undefined);
  assert.equal(parse.status, 0, parse.stderr);
  const help = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', path.join(ROOT, 'install-remote.ps1'), '--help'], {
    encoding: 'utf8', timeout: 30000
  });
  assert.equal(help.error, undefined);
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /latest/);
  t.diagnostic('PowerShell syntax and actual --help invocation passed; Windows installation behavior was not tested.');
});

for (const version of [undefined, 'latest']) {
  test(`${version === undefined ? 'default version' : 'explicit latest'} resolves once and freezes asset downloads to that tag`, { skip: !supported }, async t => {
    const f = await fixture(t);
    succeeded(f.run([], version === undefined ? {} : { MARKDOWN_PREVIEW_VERSION: version }));
    const calls = await records(f.curlLog);
    assert.deepEqual(calls.map(call => call.url), [
      `https://github.com/${repository}/releases/latest`,
      `https://github.com/${repository}/releases/download/${release}/markdown-preview-${release}.tar.gz`,
      `https://github.com/${repository}/releases/download/${release}/SHA256SUMS`
    ]);
    assert.equal((await records(f.installLog)).length, 1);
    await f.clean();
  });
}

for (const version of [release, release.slice(1)]) {
  test(`specified version ${version} skips latest resolution`, { skip: !supported }, async t => {
    const f = await fixture(t);
    succeeded(f.run([], { MARKDOWN_PREVIEW_VERSION: version }));
    assert.deepEqual((await records(f.curlLog)).map(call => call.url), [
      `https://github.com/${repository}/releases/download/${release}/markdown-preview-${release}.tar.gz`,
      `https://github.com/${repository}/releases/download/${release}/SHA256SUMS`
    ]);
    assert.equal((await records(f.installLog)).length, 1);
    await f.clean();
  });
}

test('dry-run and other options reach the packaged installer with their argument boundaries intact', { skip: !supported }, async t => {
  const f = await fixture(t);
  const args = ['--dry-run', '--install-dir', path.join(f.root, 'directory with spaces'), '--codex', '/test/Codex CLI'];
  succeeded(f.run(args));
  assert.deepEqual((await records(f.installLog)).map(call => call.args), [args]);
  await f.clean();
});

test('real tar AppleDouble entries are accepted and never extracted beside or inside the release', { skip: !supported }, async t => {
  const metadata = Buffer.alloc(70);
  metadata.writeUInt32BE(0x00051607, 0); // AppleDouble magic.
  metadata.writeUInt32BE(0x00020000, 4);
  metadata.writeUInt16BE(1, 24);
  metadata.writeUInt32BE(9, 26); // Finder information entry.
  metadata.writeUInt32BE(38, 30);
  metadata.writeUInt32BE(32, 34);
  const f = await fixture(t, [
    { name: '._' + archiveRoot, contents: metadata },
    { name: archiveRoot + '/._install.sh', contents: metadata },
    { name: archiveRoot + '/scripts/', type: '5' },
    { name: archiveRoot + '/scripts/nested/', type: '5' },
    { name: archiveRoot + '/scripts/nested/._install.cjs', contents: metadata },
    { name: archiveRoot + '/scripts/nested/install.cjs', contents: '// paired metadata fixture\n' }
  ]);
  succeeded(f.run());
  const installed = await records(f.installLog);
  assert.equal(installed.length, 1);
  assert.deepEqual(installed[0].metadata, []);
  await f.clean();
});

for (const name of [
  '._other-release',
  '._' + archiveRoot + '/../outside',
  archiveRoot + '/../outside',
  archiveRoot + '/scripts/../../._outside',
  '/' + archiveRoot + '/outside',
  archiveRoot.replace(/\./g, 'x') + '/outside'
]) {
  test(`archive preflight rejects unrelated metadata, traversal and nonliteral roots: ${name}`, { skip: !supported }, async t => {
    const f = await fixture(t, [{ name, contents: 'must not be extracted' }]);
    const result = f.run();
    failed(result);
    assert.match(result.stderr, /不安全(?:或无法识别)?的归档路径/);
    assert.deepEqual(await records(f.installLog), []);
    assert.equal(await fs.access(path.join(f.root, 'outside')).then(() => true, () => false), false);
    await f.clean();
  });
}

test('packaged installer failure is propagated and temporary files are removed', { skip: !supported }, async t => {
  const f = await fixture(t);
  const result = f.run([], { MARKDOWN_PREVIEW_TEST_INSTALL_EXIT: '73' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 73, result.stdout + result.stderr);
  assert.equal((await records(f.installLog)).length, 1);
  await f.clean();
});

for (const setting of ['MARKDOWN_PREVIEW_TEST_BAD_CHECKSUM', 'MARKDOWN_PREVIEW_TEST_MISSING_CHECKSUM']) {
  test(`${setting.endsWith('BAD_CHECKSUM') ? 'incorrect' : 'missing'} archive checksum blocks installation and cleans downloads`, { skip: !supported }, async t => {
    const f = await fixture(t);
    failed(f.run([], { [setting]: '1' }));
    assert.equal((await records(f.curlLog)).length, 3);
    assert.deepEqual(await records(f.installLog), []);
    await f.clean();
  });
}

test('latest lookup failure stops before any asset download or installation', { skip: !supported }, async t => {
  const f = await fixture(t);
  failed(f.run([], { MARKDOWN_PREVIEW_TEST_LATEST_EXIT: '22' }));
  assert.equal((await records(f.curlLog)).length, 1);
  assert.deepEqual(await records(f.installLog), []);
  await f.clean();
});

for (const url of [
  `https://github.com/${repository}/releases/latest`,
  `https://github.com/another/project/releases/tag/${release}`,
  `https://example.com/${repository}/releases/tag/${release}`,
  `https://github.com/${repository}/releases/tag/not-a-version`,
  `https://github.com/${repository}/releases/tag/v1.2.3/extra`,
  `https://github.com/${repository}/releases/tag/v1.2.3?download=1`
]) {
  test(`unexpected latest redirect is rejected: ${url}`, { skip: !supported }, async t => {
    const f = await fixture(t);
    failed(f.run([], { MARKDOWN_PREVIEW_TEST_LATEST_URL: url }));
    assert.equal((await records(f.curlLog)).length, 1);
    assert.deepEqual(await records(f.installLog), []);
    await f.clean();
  });
}

for (const version of ['v1.2.3/extra', 'v1.2.3?download=1', 'v1.2.x', 'latest/extra']) {
  test(`invalid explicit version is rejected before network access: ${version}`, { skip: !supported }, async t => {
    const f = await fixture(t);
    failed(f.run([], { MARKDOWN_PREVIEW_VERSION: version }));
    assert.deepEqual(await records(f.curlLog), []);
    assert.deepEqual(await records(f.installLog), []);
    await f.clean();
  });
}

test('help is available without looking up or downloading a release', { skip: !supported }, async t => {
  const f = await fixture(t);
  const result = f.run(['--help']);
  succeeded(result);
  assert.match(result.stdout, /latest/);
  assert.deepEqual(await records(f.curlLog), []);
  assert.deepEqual(await records(f.installLog), []);
  await f.clean();
});
