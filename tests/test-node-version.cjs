'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'scripts/install.cjs');
const shellEntry = path.join(root, 'install.sh');
const powershellEntry = path.join(root, 'install.ps1');
const versions = [
  ['20.3.1', false], ['20.19.5', false], ['21.7.3', false], ['22.11.0', false],
  ['22.12.0', true], ['22.13.0', true], ['24.13.0', true]
];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const pwsh = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
  { encoding: 'utf8', timeout: 10000 });
const hasPwsh = !pwsh.error && pwsh.status === 0;

async function fixture(t, version) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-node-version-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const preload = path.join(directory, 'version.cjs');
  const calls = path.join(directory, 'node.jsonl');
  const cliCalls = path.join(directory, 'cli.jsonl');
  const targetParent = path.join(directory, 'installation');
  const destination = path.join(targetParent, 'marketplace');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(preload, `'use strict';
Object.defineProperty(process.versions, 'node', { value: process.env.MARKDOWN_PREVIEW_TEST_NODE });
require('node:fs').appendFileSync(process.env.MARKDOWN_PREVIEW_TEST_NODE_CALLS,
  JSON.stringify({ args: process.argv.slice(1), eval: process._eval || null }) + '\\n');
`);
  const fakeCli = name => `#!${process.execPath}\n'use strict';
require('node:fs').appendFileSync(process.env.MARKDOWN_PREVIEW_TEST_CLI_CALLS, '${name}\\n');
process.exitCode = 91;
`;
  const npmCli = path.join(bin, 'node_modules/npm/bin/npm-cli.js');
  const codexCli = path.join(bin, 'node_modules/@openai/codex/bin/codex.js');
  await fs.mkdir(path.dirname(npmCli), { recursive: true });
  await fs.mkdir(path.dirname(codexCli), { recursive: true });
  await fs.writeFile(npmCli, fakeCli('npm'));
  await fs.writeFile(codexCli, fakeCli('codex'));
  await fs.chmod(codexCli, 0o755);
  const fakeCodex = process.platform === 'win32' ? path.join(bin, 'codex.cmd') : codexCli;
  const fakeNpm = path.join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  await fs.writeFile(fakeNpm, fakeCli('npm-launcher'));
  await fs.chmod(fakeNpm, 0o755);
  if (process.platform === 'win32') {
    await fs.writeFile(fakeCodex, '@echo off\r\nexit /b 91\r\n');
    await fs.writeFile(path.join(bin, 'node.cmd'),
      `@echo off\r\n"${process.execPath}" --require "${preload}" %*\r\n`);
  } else {
    const nodeWrapper = path.join(bin, 'node');
    await fs.writeFile(nodeWrapper, `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(preload)} "$@"\n`);
    await fs.chmod(nodeWrapper, 0o755);
  }
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    PATH: bin + path.delimiter + process.env.PATH,
    MARKDOWN_PREVIEW_TEST_NODE: version,
    MARKDOWN_PREVIEW_TEST_NODE_CALLS: calls,
    MARKDOWN_PREVIEW_TEST_CLI_CALLS: cliCalls
  };
  const args = ['--source', root, '--install-dir', destination, '--codex', fakeCodex];
  function run(command, entryArgs) {
    return spawnSync(command, entryArgs, { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
  }
  async function noInstallEffects() {
    await assert.rejects(fs.access(targetParent), { code: 'ENOENT' });
    await assert.rejects(fs.access(cliCalls), { code: 'ENOENT' });
  }
  async function nodeCalls() {
    return (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  }
  return { preload, args, run, noInstallEffects, nodeCalls };
}

function assertGate(result, allowed) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, allowed ? 0 : 1, result.stdout + result.stderr);
  if (allowed) assert.match(result.stdout, /未下载或修改任何文件/);
  else assert.match(result.stderr, /Node\.js.*22\.12\.0/);
}

test('JavaScript installer enforces Node version before installation operations', async t => {
  for (const [version, allowed] of versions) {
    await t.test(version, async t => {
      const f = await fixture(t, version);
      // Rejected versions take the installation path, so an early guard is required.
      const result = f.run(process.execPath,
        ['--require', f.preload, installer, ...f.args, ...(allowed ? ['--dry-run'] : [])]);
      assertGate(result, allowed);
      await f.noInstallEffects();
    });
  }
});

test('POSIX entrypoint rejects old Node before launching the JavaScript installer',
  { skip: process.platform === 'win32' }, async t => {
    for (const [version, allowed] of versions) {
      await t.test(version, async t => {
        const f = await fixture(t, version);
        const result = f.run('/bin/sh', [shellEntry, ...f.args, ...(allowed ? ['--dry-run'] : [])]);
        assertGate(result, allowed);
        const calls = await f.nodeCalls();
        assert.equal(calls.some(call => call.args.includes(installer)), allowed);
        await f.noInstallEffects();
      });
    }
  });

test('PowerShell entrypoint version boundaries',
  { skip: !hasPwsh && 'pwsh is unavailable; real PowerShell entrypoint execution is unverified' }, async t => {
    for (const [version, allowed] of versions) {
      await t.test(version, async t => {
        const f = await fixture(t, version);
        const result = f.run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
          powershellEntry, ...f.args, ...(allowed ? ['--dry-run'] : [])]);
        assertGate(result, allowed);
        const calls = await f.nodeCalls();
        assert.equal(calls.some(call => call.args.includes(installer)), allowed);
        await f.noInstallEffects();
      });
    }
  });

test('PowerShell embedded JavaScript guard has the same version boundaries', async t => {
  const source = await fs.readFile(powershellEntry, 'utf8');
  const guard = source.match(/& \$node\.Path -e '([^']+)'/);
  assert.ok(guard, 'Cannot locate the PowerShell Node guard');
  assert.ok(source.indexOf(guard[0]) < source.indexOf("$installer = Join-Path"),
    'PowerShell must check Node before preparing the installer path');
  assert.match(source, /安装需要 Node\.js 22\.12\.0/);
  for (const [version, allowed] of versions) {
    await t.test(version, async t => {
      const f = await fixture(t, version);
      // Execute the production guard itself; this does not prove Windows execution.
      const result = f.run(process.execPath, ['--require', f.preload, '-e', guard[1]]);
      assert.equal(result.error, undefined);
      assert.equal(result.status, allowed ? 0 : 1, result.stdout + result.stderr);
      await f.noInstallEffects();
    });
  }
});
