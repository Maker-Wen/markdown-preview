'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { gzipSync } = require('node:zlib');
const { main, parseOptions, normalizeVersion, validateRepository, checksumFor } = require('../lib/release.cjs');

const ROOT = path.resolve(__dirname, '..');
const repository = 'Maker-Wen/markdown-preview';
const version = 'v1.2.3';
const archiveName = `markdown-preview-${version}.tar.gz`;
const rootName = `markdown-preview-${version}`;
const latestUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const assetBase = `https://github.com/${repository}/releases/download/${version}/`;

// Construct valid USTAR archives directly so the malicious-entry fixtures do not
// depend on the local tar command sanitizing filenames or following symlinks.
function archive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents || '');
    const header = Buffer.alloc(512);
    function write(value, offset, length) { header.write(value, offset, length, 'utf8'); }
    function octal(value, offset, length) { write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length); }
    write(entry.name, 0, 100);
    octal(entry.type === '5' ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(contents.length, 124, 12);
    octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    write(entry.type || '0', 156, 1);
    write(entry.linkname || '', 157, 100);
    write('ustar\0', 257, 6);
    write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, contents, Buffer.alloc((512 - contents.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const normalEntries = () => [
  { name: `${rootName}/`, type: '5' },
  { name: `${rootName}/scripts/`, type: '5' },
  { name: `${rootName}/scripts/install.cjs`, contents: '// This fixture must never be executed.\n' }
];

async function fixture(t, settings = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-npx-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const temporaryDirectory = path.join(root, 'temporary');
  await fs.mkdir(temporaryDirectory);
  const bytes = settings.archive || archive(normalEntries());
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const checksum = settings.checksum === undefined ? `${hash}  ${archiveName}\n` : settings.checksum;
  const requests = [];
  const executions = [];
  const logs = [];
  const metadata = settings.metadata === undefined ? { tag_name: version, draft: false, prerelease: false } : settings.metadata;
  const responses = new Map([
    [latestUrl, () => new Response(JSON.stringify(metadata), { status: settings.metadataStatus || 200 })],
    [`${assetBase}${archiveName}`, () => new Response(bytes, { status: settings.archiveStatus || 200 })],
    [`${assetBase}SHA256SUMS`, () => new Response(checksum, { status: settings.checksumStatus || 200 })]
  ]);
  const dependencies = {
    env: {},
    temporaryDirectory,
    log: (...values) => logs.push(values.join(' ')),
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      const response = responses.get(String(url));
      assert.ok(response, `unexpected network request: ${url}`);
      return response();
    },
    execute: async (command, args, options) => {
      executions.push({ command, args, options });
      assert.equal(command, process.execPath);
      assert.equal(args[1], '--source');
      assert.equal(args[0], path.join(args[2], 'scripts', 'install.cjs'));
      assert.equal(await fs.readFile(args[0], 'utf8'), normalEntries()[2].contents);
      return settings.execution || { status: 0 };
    }
  };
  async function clean() {
    assert.deepEqual(await fs.readdir(temporaryDirectory), [], 'downloaded release must be removed after installation or failure');
  }
  return { root, requests, executions, logs, dependencies, clean };
}

for (const requestedVersion of [undefined, 'latest']) {
  test(`npx installer ${requestedVersion || 'default'} resolves one official release and freezes all asset URLs`, async t => {
    const f = await fixture(t);
    assert.equal(await main(requestedVersion ? ['--version', requestedVersion] : [], f.dependencies), undefined);
    assert.deepEqual(f.requests.map(request => request.url), [
      latestUrl, `${assetBase}${archiveName}`, `${assetBase}SHA256SUMS`
    ]);
    assert.equal(f.executions.length, 1);
    assert.deepEqual(f.executions[0].args.slice(3), []);
    assert.deepEqual(f.executions[0].options, { stdio: 'inherit' });
    await f.clean();
  });
}

for (const requestedVersion of [version, version.slice(1)]) {
  test(`npx installer explicit version ${requestedVersion} bypasses latest metadata`, async t => {
    const f = await fixture(t);
    await main(['--version', requestedVersion], f.dependencies);
    assert.deepEqual(f.requests.map(request => request.url), [`${assetBase}${archiveName}`, `${assetBase}SHA256SUMS`]);
    assert.equal(f.executions.length, 1);
    await f.clean();
  });
}

test('npx dry-run verifies the release and preserves argument boundaries for the packaged installer', async t => {
  const f = await fixture(t);
  const forwarded = ['--dry-run', '--install-dir', path.join(f.root, 'directory with spaces'), '--codex', '/test/Codex CLI'];
  await main(['--version', version, ...forwarded], f.dependencies);
  assert.deepEqual(f.requests.map(request => request.url), [`${assetBase}${archiveName}`, `${assetBase}SHA256SUMS`]);
  assert.deepEqual(f.executions[0].args.slice(3), forwarded);
  await f.clean();
});

test('npx repository override is used consistently for metadata and release assets', async t => {
  const f = await fixture(t);
  const custom = 'Other-Owner/preview.repo';
  const originalFetch = f.dependencies.fetch;
  const customRequests = [];
  f.dependencies.fetch = (url, options) => {
    customRequests.push(String(url));
    return originalFetch(String(url).replace(custom, repository), options);
  };
  await main(['--repository', custom], f.dependencies);
  assert.deepEqual(customRequests, [latestUrl, `${assetBase}${archiveName}`, `${assetBase}SHA256SUMS`].map(url => url.replace(repository, custom)));
  assert.equal(f.executions.length, 1);
  await f.clean();
});

test('help returns without accessing the network, creating downloads or running an installer', async t => {
  const f = await fixture(t);
  await main(['--help'], f.dependencies);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.executions, []);
  assert.match(f.logs.join('\n'), /latest/);
  await f.clean();
});

test('offline npm mode refuses remote installation before requesting release metadata', async t => {
  const f = await fixture(t);
  f.dependencies.env = { npm_config_offline: 'true' };
  await assert.rejects(main([], f.dependencies), /offline|离线/i);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.executions, []);
  await f.clean();
});

for (const invalidVersion of ['v1.2.3/extra', 'v1.2.3?download=1', 'v1.2.x', 'latest/extra', '../v1.2.3', 'v1.2.3\n', 'v1.2.3 ']) {
  test(`invalid version is rejected before downloads: ${invalidVersion}`, async t => {
    const f = await fixture(t);
    await assert.rejects(main(['--version', invalidVersion], f.dependencies));
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.executions, []);
    await f.clean();
  });
}

for (const invalidRepository of ['owner/repo/extra', '../repo', './repo', 'owner/..', 'owner/.', 'https://github.com/owner/repo', 'owner/repo?x=1', 'owner/repo\nother/repo', 'owner/repo\n', 'owner/repo ']) {
  test(`invalid repository is rejected before downloads: ${JSON.stringify(invalidRepository)}`, async t => {
    const f = await fixture(t);
    await assert.rejects(main(['--repository', invalidRepository], f.dependencies));
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.executions, []);
    await f.clean();
  });
}

for (const metadata of [
  { tag_name: version, draft: true, prerelease: false },
  { tag_name: version, draft: false, prerelease: true },
  { tag_name: 'not-a-version', draft: false, prerelease: false },
  { tag_name: 'v1.2.3/extra', draft: false, prerelease: false },
  { tag_name: 'v1.2.3\n', draft: false, prerelease: false },
  { tag_name: 'v1.2.3 ', draft: false, prerelease: false },
  { draft: false, prerelease: false },
  null
]) {
  test(`unexpected latest release metadata blocks asset downloads: ${JSON.stringify(metadata)}`, async t => {
    const f = await fixture(t, { metadata });
    await assert.rejects(main([], f.dependencies), error => !(error instanceof TypeError) && /Release|正式版/.test(error.message));
    assert.deepEqual(f.requests.map(request => request.url), [latestUrl]);
    assert.deepEqual(f.executions, []);
    await f.clean();
  });
}

test('latest HTTP failure stops before release assets are downloaded', async t => {
  const f = await fixture(t, { metadataStatus: 404 });
  await assert.rejects(main([], f.dependencies), /404/);
  assert.deepEqual(f.requests.map(request => request.url), [latestUrl]);
  assert.deepEqual(f.executions, []);
  await f.clean();
});

test('GitHub asset redirects are followed only to an approved HTTPS host', async t => {
  const f = await fixture(t);
  const redirected = 'https://release-assets.githubusercontent.com/test/release-asset';
  const originalFetch = f.dependencies.fetch;
  const requests = [];
  f.dependencies.fetch = (url, options) => {
    requests.push(String(url));
    assert.equal(options.redirect, 'manual');
    if (url === `${assetBase}${archiveName}`) return new Response(null, { status: 302, headers: { location: redirected } });
    return originalFetch(url === redirected ? `${assetBase}${archiveName}` : url, options);
  };
  await main(['--version', version], f.dependencies);
  assert.deepEqual(requests, [`${assetBase}${archiveName}`, redirected, `${assetBase}SHA256SUMS`]);
  assert.equal(f.executions.length, 1);
  await f.clean();
});

for (const redirect of ['http://github.com/unsafe', 'https://example.com/unsafe', 'https://github.com:8443/unsafe', 'https://user:pass@github.com/unsafe']) {
  test(`unsafe download redirect is rejected before contacting its target: ${redirect}`, async t => {
    const f = await fixture(t);
    const requests = [];
    f.dependencies.fetch = (url) => {
      requests.push(String(url));
      return new Response(null, { status: 302, headers: { location: redirect } });
    };
    await assert.rejects(main(['--version', version], f.dependencies), /HTTPS/);
    assert.deepEqual(requests, [`${assetBase}${archiveName}`]);
    assert.deepEqual(f.executions, []);
    await f.clean();
  });
}

for (const settings of [{ archiveStatus: 503 }, { checksumStatus: 404 }]) {
  test(`failed asset response blocks installation and cleans partial downloads: ${JSON.stringify(settings)}`, async t => {
    const f = await fixture(t, settings);
    await assert.rejects(main(['--version', version], f.dependencies), /503|404/);
    assert.deepEqual(f.executions, []);
    await f.clean();
  });
}

for (const [reason, checksum] of [
  ['incorrect', `${'0'.repeat(64)}  ${archiveName}\n`],
  ['missing', `${'0'.repeat(64)}  another-package.tar.gz\n`],
  ['duplicate', `${'0'.repeat(64)}  ${archiveName}\n${'1'.repeat(64)}  ${archiveName}\n`],
  ['malformed', `invalid  ${archiveName}\n`]
]) {
  test(`${reason} checksum entry blocks packaged installer execution`, async t => {
    const f = await fixture(t, { checksum });
    await assert.rejects(main(['--version', version], f.dependencies), /SHA|checksum|校验|重复|格式|找不到/i);
    assert.deepEqual(f.executions, []);
    await f.clean();
  });
}

for (const entry of [
  { name: `${rootName}/../outside.txt`, contents: 'escaped' },
  { name: '/absolute/outside.txt', contents: 'escaped' },
  { name: `${rootName}/scripts/install.cjs`, type: '2', linkname: '/tmp/outside-installer.cjs' },
  { name: `${rootName}/hard-link`, type: '1', linkname: `${rootName}/scripts/install.cjs` },
  { name: `${rootName}/device`, type: '3' },
  { name: 'other-release/scripts/install.cjs', contents: 'escaped' }
]) {
  test(`unsafe tar entry blocks packaged installer before extraction: ${entry.type || 'file'} ${entry.name}`, async t => {
    const f = await fixture(t, { archive: archive([...normalEntries(), entry]) });
    await assert.rejects(main(['--version', version], f.dependencies));
    assert.deepEqual(f.executions, []);
    assert.equal(await fs.access(path.join(f.root, 'outside.txt')).then(() => true, () => false), false);
    await f.clean();
  });
}

test('release archive without the packaged installer cannot run', async t => {
  const f = await fixture(t, { archive: archive(normalEntries().slice(0, 2)) });
  await assert.rejects(main(['--version', version], f.dependencies), /install\.cjs/);
  assert.deepEqual(f.executions, []);
  await f.clean();
});

test('duplicate archive paths are rejected before overwriting an installer', async t => {
  const f = await fixture(t, { archive: archive([...normalEntries(), normalEntries()[2]]) });
  await assert.rejects(main(['--version', version], f.dependencies), /重复|冲突/);
  assert.deepEqual(f.executions, []);
  await f.clean();
});

test('macOS AppleDouble metadata is skipped without extracting or executing its contents', async t => {
  const f = await fixture(t, { archive: archive([
    { name: `._${rootName}`, contents: 'top-level macOS metadata' },
    ...normalEntries(),
    { name: `${rootName}/scripts/._install.cjs`, contents: 'nested macOS metadata' }
  ]) });
  const originalExecute = f.dependencies.execute;
  f.dependencies.execute = async (command, args, options) => {
    assert.equal(await fs.access(path.join(path.dirname(args[2]), `._${rootName}`)).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(args[2], 'scripts/._install.cjs')).then(() => true, () => false), false);
    return originalExecute(command, args, options);
  };
  await main(['--version', version], f.dependencies);
  assert.equal(f.executions.length, 1);
  await f.clean();
});

for (const entry of [
  { name: `._${rootName}`, type: '2', linkname: '/tmp/outside-installer.cjs' },
  { name: `${rootName}/scripts/._install.cjs`, type: '2', linkname: '/tmp/outside-installer.cjs' },
  { name: '._other-release', contents: 'unrelated metadata root' },
  { name: `${rootName}/../._outside`, contents: 'unsafe metadata path' },
  { name: `._${rootName}/../outside`, contents: 'unsafe metadata root path' }
]) {
  test(`AppleDouble filtering cannot bypass type or path validation: ${entry.type || 'file'} ${entry.name}`, async t => {
    const f = await fixture(t, { archive: archive([...normalEntries(), entry]) });
    await assert.rejects(main(['--version', version], f.dependencies));
    assert.deepEqual(f.executions, []);
    await f.clean();
  });
}

test('packaged installer failure preserves its exit code and removes temporary files', async t => {
  const f = await fixture(t, { execution: { status: 73 } });
  await assert.rejects(main(['--version', version], f.dependencies), error => error.exitCode === 73);
  assert.equal(f.executions.length, 1);
  await f.clean();
});

test('installer startup failure cleans the downloaded release', async t => {
  const f = await fixture(t, { execution: { status: null, error: new Error('fixture spawn failed') } });
  await assert.rejects(main(['--version', version], f.dependencies), /fixture spawn failed/);
  await f.clean();
});

test('npm package exposes an executable entry and excludes plugin runtime and local files', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const executable = typeof packageJson.bin === 'string' ? packageJson.bin : Object.values(packageJson.bin)[0];
  const cli = await fs.readFile(path.resolve(ROOT, executable), 'utf8');
  assert.match(cli, /^#!\/usr\/bin\/env node\n/);
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000
  });
  assert.equal(packed.error, undefined);
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map(file => file.path);
  assert.ok(files.includes(executable.replace(/^\.\//, '')));
  assert.ok(files.includes('lib/release.cjs'));
  assert.ok(!files.some(file => /^(plugins|tests|node_modules|\.archify)\//.test(file)), files.join('\n'));
  const help = spawnSync(process.execPath, [path.resolve(ROOT, executable), '--help'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, npm_config_offline: 'true' }
  });
  assert.equal(help.error, undefined);
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /latest/);
});

test('argument parser honors environment defaults while explicit options take priority', () => {
  const options = parseOptions(['--version', '2.3.4', '--repository', repository, '--dry-run'], {
    MARKDOWN_PREVIEW_VERSION: 'v9.9.9', MARKDOWN_PREVIEW_REPOSITORY: 'other/repository'
  });
  assert.equal(options.version, 'v2.3.4');
  assert.equal(options.repository, repository);
  assert.deepEqual(options.forwarded, ['--dry-run']);
  assert.equal(parseOptions([], { MARKDOWN_PREVIEW_VERSION: '1.2.3' }).version, version);
  assert.equal(normalizeVersion('1.2.3'), version);
  assert.equal(validateRepository(repository), repository);
  assert.equal(checksumFor(`${'A'.repeat(64)} *${archiveName}\n`, archiveName), 'a'.repeat(64));
});
