'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const installer = path.resolve(__dirname, '../scripts/install.cjs');
const marketplace = 'markdown-preview-marketplace';
const marker = '.markdown-preview-install.json';
const supported = process.platform !== 'win32';

async function json(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

async function snapshot(root, prefix = '') {
  const result = {};
  const entries = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) result[name] = { link: await fs.readlink(file) };
    else if (entry.isDirectory()) {
      result[name + '/'] = true;
      Object.assign(result, await snapshot(file, name + '/'));
    } else result[name] = (await fs.readFile(file)).toString('base64');
  }
  return result;
}

async function records(file) {
  try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function fixture(t, settings = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-installer-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const plugin = path.join(source, 'plugins/markdown-preview');
  const destination = path.join(root, 'prepared/marketplace');
  const bin = path.join(root, 'bin');
  const stateFile = path.join(root, 'fake-cli-state.json');
  const codexLog = path.join(root, 'codex.jsonl');
  const npmLog = path.join(root, 'npm.jsonl');
  const state = { marketplaces: [], installed: [], npmFailureAt: 1, ...settings };
  await fs.mkdir(bin, { recursive: true });
  await json(stateFile, state);
  await json(path.join(source, '.agents/plugins/marketplace.json'), {
    name: marketplace,
    plugins: [{ name: 'markdown-preview', source: { source: 'local', path: './plugins/markdown-preview' } }]
  });
  const manifest = { name: 'markdown-preview', version: '0.1.0+codex.20260926171143' };
  await json(path.join(plugin, 'plugin.json'), manifest);
  await json(path.join(plugin, '.codex-plugin/plugin.json'), manifest);
  await json(path.join(plugin, 'mcp.json'), { mcpServers: { markdown_preview: { command: 'node', args: ['${PLUGIN_ROOT}/scripts/server.cjs'] } } });
  await json(path.join(plugin, 'package.json'), { name: 'markdown-preview', version: '0.1.0', private: true });
  await json(path.join(plugin, 'runtime/renderer/package.json'), { name: 'markdown-preview-renderer', version: '0.1.0', private: true });
  await fs.writeFile(path.join(plugin, 'README.md'), '# Fixture\n');

  // These subprocess fixtures never invoke Codex, npm, network access, or a server.
  // The npm fixture fails before smoke; real MCP validation is intentionally not mocked.
  const fakeCodex = path.join(bin, 'codex-fixture');
  await fs.writeFile(fakeCodex, `#!${process.execPath}\n'use strict';
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.MARKDOWN_PREVIEW_TEST_STATE, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MARKDOWN_PREVIEW_CODEX_LOG, JSON.stringify({args}) + '\\n');
if (args.join(' ') === 'plugin marketplace list --json') {
  console.log(JSON.stringify({marketplaces:state.marketplaces}));
} else if (args.join(' ') === 'plugin list --json') {
  console.log(JSON.stringify({installed:state.installed,available:[]}));
} else {
  console.error('Unexpected Codex operation: ' + args.join(' '));
  process.exitCode = 91;
}
`);
  await fs.chmod(fakeCodex, 0o755);
  const npmCli = path.join(root, 'fake-npm/npm-cli.js');
  await fs.mkdir(path.dirname(npmCli), { recursive: true });
  await fs.writeFile(npmCli, `#!${process.execPath}\n'use strict';
const fs = require('node:fs');
const path = require('node:path');
const state = JSON.parse(fs.readFileSync(process.env.MARKDOWN_PREVIEW_TEST_STATE, 'utf8'));
const log = process.env.MARKDOWN_PREVIEW_NPM_LOG;
const previous = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean) : [];
const plugin = fs.existsSync(path.join(process.cwd(), 'plugin.json')) ? process.cwd() : path.resolve(process.cwd(), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'plugin.json'), 'utf8'));
const overlay = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
const mcp = JSON.parse(fs.readFileSync(path.join(plugin, 'mcp.json'), 'utf8'));
fs.appendFileSync(log, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),version:manifest.version,overlayVersion:overlay.version,node:mcp.mcpServers.markdown_preview.command}) + '\\n');
if (previous.length + 1 >= state.npmFailureAt) {
  console.error('Intentional npm dependency failure');
  process.exitCode = 73;
} else {
  fs.mkdirSync(path.join(process.cwd(), 'node_modules'), {recursive:true});
  fs.writeFileSync(path.join(process.cwd(), 'node_modules/fixture'), 'partial dependency download');
}
`);
  await fs.chmod(npmCli, 0o755);
  await fs.symlink(npmCli, path.join(bin, 'npm'));

  function run(args = []) {
    return spawnSync(process.execPath, [installer, '--source', source, '--install-dir', destination, '--codex', fakeCodex, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        MARKDOWN_PREVIEW_TEST_STATE: stateFile,
        MARKDOWN_PREVIEW_CODEX_LOG: codexLog,
        MARKDOWN_PREVIEW_NPM_LOG: npmLog
      }
    });
  }

  async function managed() {
    await json(path.join(destination, marker), { installer: 'markdown-preview', format: 1, version: '0.0.1+local.previous' });
    await fs.writeFile(path.join(destination, 'previous.txt'), 'Existing installation must survive.\n');
  }
  return { root, source, plugin, destination, state, stateFile, codexLog, npmLog, run, managed };
}

function failed(result, message) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, message);
}

test('dry-run performs no writes and invokes neither Codex nor npm', { skip: !supported }, async t => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const result = f.run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /未下载或修改任何文件/);
  assert.deepEqual(await snapshot(f.root), before);
});

test('an unmanaged destination is preserved and rejected before CLI operations', { skip: !supported }, async t => {
  const f = await fixture(t);
  await fs.mkdir(f.destination, { recursive: true });
  await fs.writeFile(path.join(f.destination, 'user-document.md'), '# Keep this file\n');
  const before = await snapshot(f.root);
  failed(f.run(), /目标目录不是本安装器管理的目录/);
  assert.deepEqual(await snapshot(f.root), before);
});

test('a marketplace with the same name and another root is rejected before preparation', { skip: !supported }, async t => {
  const f = await fixture(t);
  await f.managed();
  const before = await snapshot(f.destination);
  f.state.marketplaces = [{ name: marketplace, root: path.join(f.root, 'other-marketplace') }];
  await json(f.stateFile, f.state);
  failed(f.run(), /同名市场已指向/);
  assert.deepEqual(await snapshot(f.destination), before);
  assert.deepEqual((await records(f.codexLog)).map(item => item.args), [['plugin', 'marketplace', 'list', '--json']]);
  assert.deepEqual(await records(f.npmLog), []);
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['marketplace']);
});

for (const failureAt of [1, 2]) {
  test(`dependency failure ${failureAt} preserves the prior installation and removes partial staging`, { skip: !supported }, async t => {
    const f = await fixture(t, { npmFailureAt: failureAt });
    await f.managed();
    const before = await snapshot(f.destination);
    failed(f.run(), /执行失败（73）/);
    assert.deepEqual(await snapshot(f.destination), before);
    assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['marketplace']);
    const calls = await records(f.npmLog);
    assert.equal(calls.length, failureAt);
    for (const call of calls) {
      assert.deepEqual(call.args, ['ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund']);
      assert.equal(call.version, call.overlayVersion);
      assert.equal(call.node, process.execPath);
      assert.notEqual(call.cwd, f.plugin);
      assert.notEqual(call.cwd, path.join(f.destination, 'plugins/markdown-preview'));
    }
    assert.deepEqual((await records(f.codexLog)).map(item => item.args), [
      ['plugin', 'marketplace', 'list', '--json'], ['plugin', 'list', '--json']
    ]);
  });
}

test('fresh installation dependency failure leaves no registered marketplace or prepared directory', { skip: !supported }, async t => {
  const f = await fixture(t);
  failed(f.run(), /执行失败（73）/);
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), []);
  assert.equal((await records(f.npmLog)).length, 1);
  assert.ok((await records(f.codexLog)).every(item => !item.args.includes('add')));
});

test('prepared version is stable for identical sources and changes when plugin content changes', { skip: !supported }, async t => {
  const f = await fixture(t);
  failed(f.run(), /执行失败（73）/);
  failed(f.run(), /执行失败（73）/);
  await fs.writeFile(path.join(f.plugin, 'README.md'), '# Updated fixture\n');
  failed(f.run(), /执行失败（73）/);
  const versions = (await records(f.npmLog)).map(item => item.version);
  assert.equal(versions.length, 3);
  assert.equal(versions[0], versions[1]);
  assert.notEqual(versions[1], versions[2]);
  assert.ok(versions.every(version => /^0\.1\.0\+/.test(version)));
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), []);
});

test('the real installed-list shape reports an enabled copy from another marketplace', { skip: !supported }, async t => {
  const f = await fixture(t, { installed: [{
    pluginId: 'markdown-preview@personal', name: 'markdown-preview', marketplaceName: 'personal',
    version: '0.1.0', installed: true, enabled: true
  }] });
  const result = f.run();
  failed(result, /执行失败（73）/);
  assert.match(result.stderr, /markdown-preview@personal.*仍已启用/);
});
