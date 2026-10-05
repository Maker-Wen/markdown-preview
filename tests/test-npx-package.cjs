'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');

async function packageArchive() {
  const override = process.env.MARKDOWN_PREVIEW_NPX_PACKAGE;
  if (override) return path.resolve(override);
  const directory = path.join(ROOT, 'dist');
  const matches = (await fs.readdir(directory)).filter(name => /markdown-preview-installer-[^/\\]+\.tgz$/.test(name));
  assert.equal(matches.length, 1, 'dist must contain exactly one packed Markdown Preview installer; use MARKDOWN_PREVIEW_NPX_PACKAGE to select an artifact');
  return path.join(directory, matches[0]);
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, ...options });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('the shared npm artifact installs and its actual executable shows help without downloading a Release', async t => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli && path.isAbsolute(npmCli), 'run this test with npm run test:npx-package so npm_execpath selects the npm CLI');
  assert.ok((await fs.stat(npmCli)).isFile());
  const archive = await packageArchive();
  assert.ok((await fs.lstat(archive)).isFile(), 'the installer artifact must be a regular file');
  const expected = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-npm-package-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const prefix = path.join(temporary, 'installation with spaces 中文');
  const cache = path.join(temporary, 'npm-cache');
  const userConfig = path.join(temporary, 'user.npmrc');
  const globalConfig = path.join(temporary, 'global.npmrc');
  await fs.writeFile(userConfig, '');
  await fs.writeFile(globalConfig, '');
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
  // npm run supplies its project settings to children. Replace those settings
  // explicitly so installation uses neither the source tree nor user configs.
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
  Object.assign(env, {
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: cache,
    npm_config_engine_strict: 'true'
  });
  run(process.execPath, [npmCli, 'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false', archive], {
    cwd: temporary, env
  });

  const installedRoot = path.join(prefix, 'node_modules', ...expected.name.split('/'));
  const installed = JSON.parse(await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installed.name, expected.name);
  assert.equal(installed.version, expected.version);
  const binaries = typeof installed.bin === 'string' ? [installed.bin] : Object.values(installed.bin || {});
  assert.equal(binaries.length, 1, 'the installed package must expose exactly one CLI entry');
  const executable = path.resolve(installedRoot, binaries[0]);
  const relative = path.relative(installedRoot, executable);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'the CLI entry must stay inside the installed package');
  assert.ok((await fs.lstat(executable)).isFile());
  assert.match(await fs.readFile(executable, 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);

  const networkGuard = path.join(temporary, 'forbid-network.cjs');
  await fs.writeFile(networkGuard, `'use strict';
const forbidden = () => { throw new Error('fixture: help must not download a Release or access the network'); };
globalThis.fetch = forbidden;
for (const name of ['node:http', 'node:https']) {
  const protocol = require(name);
  protocol.request = protocol.get = forbidden;
}
`);
  const help = run(process.execPath, ['--no-global-search-paths', '--require', networkGuard, executable, '--help'], {
    cwd: temporary, env: { ...env, npm_config_offline: 'true' }
  });
  assert.match(help, /Markdown Preview 安装器/);
  assert.match(help, /用法：npx/);
  assert.match(help, /--version/);
  assert.match(help, /latest/);
  t.diagnostic(`Installed ${installed.name}@${installed.version} from ${path.basename(archive)}; its packaged CLI help passed with network access forbidden.`);
});
