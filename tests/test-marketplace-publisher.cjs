'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { options, publish, validateSource } = require('../scripts/publish-marketplace.cjs');
const { MARKER, BUILDER } = require('../scripts/build-marketplace.cjs');

const PUBLISHER = path.resolve(__dirname, '../scripts/publish-marketplace.cjs');
const REF = 'codex/marketplace';
const BRANCH = `refs/heads/${REF}`;
const DEPENDENCY = 'plugins/markdown-preview/node_modules/fixture-runtime/index.js';

function git(cwd, args, env, expected = 0) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return result.stdout.trim();
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshot(directory) {
  const files = {};
  async function visit(current, prefix = '') {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        files[relative + '/'] = true;
        await visit(file, relative + '/');
      } else if (entry.isSymbolicLink()) files[relative] = { link: await fs.readlink(file) };
      else files[relative] = (await fs.readFile(file)).toString('base64');
    }
  }
  await visit(directory);
  return files;
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-publisher-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'marketplace');
  const remote = path.join(root, 'remote.git');
  const globalConfig = path.join(root, 'fixture-global.gitconfig');
  await fs.writeFile(globalConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Publisher Fixture', GIT_AUTHOR_EMAIL: 'publisher@example.invalid',
    GIT_COMMITTER_NAME: 'Publisher Fixture', GIT_COMMITTER_EMAIL: 'publisher@example.invalid',
    GIT_AUTHOR_DATE: '2026-10-04T00:00:00+0000', GIT_COMMITTER_DATE: '2026-10-04T00:00:00+0000'
  };
  // Isolate Git from inherited runtime configuration as well as the user's files.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key) ||
        ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)) delete env[key];
  }
  git(root, ['config', '--file', globalConfig, 'init.defaultBranch', 'main'], env);
  git(root, ['init', '--bare', '--quiet', remote], env);

  async function artifact(version = '1.2.3', overrides = {}) {
    await writeJson(path.join(source, MARKER), {
      builder: BUILDER, format: 1, version, root: source, ...overrides.marker
    });
    await writeJson(path.join(source, '.agents/plugins/marketplace.json'), {
      name: 'markdown-preview-marketplace',
      plugins: [{ name: 'markdown-preview', source: { source: 'local', path: './plugins/markdown-preview' } }],
      ...overrides.catalog
    });
    await writeJson(path.join(source, 'plugins/markdown-preview/plugin.json'), {
      name: 'markdown-preview', version, ...overrides.manifest
    });
    await fs.mkdir(path.dirname(path.join(source, DEPENDENCY)), { recursive: true });
    await fs.writeFile(path.join(source, DEPENDENCY), `module.exports = ${JSON.stringify(version)};\n`);
  }
  await artifact();
  const args = ['--source', source, '--repo', remote, '--ref', REF];
  const opts = () => options([...args, '--publish']);
  const refs = () => git(remote, ['for-each-ref', '--format=%(refname)'], env);
  const head = () => git(remote, ['rev-parse', BRANCH], env);
  return { root, source, remote, globalConfig, env, artifact, args, opts, refs, head };
}

test('marketplace publisher defaults to a plan without creating a remote branch', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.source);
  const opts = options(f.args);
  assert.equal(opts.publish, false);
  assert.equal(f.refs(), '');
  await publish(opts, f.env);
  assert.equal(f.refs(), '');
  assert.deepEqual(await snapshot(f.source), before);

  // An unreachable path also succeeds in plan mode: no Git lookup is attempted.
  await publish({ ...opts, repo: path.join(f.root, 'nonexistent-remote.git') }, f.env);
});

test('first marketplace publication creates the generated branch and tracks its runtime', async t => {
  const f = await fixture(t);
  await publish(f.opts(), f.env);
  assert.equal(f.refs(), BRANCH);
  assert.equal(git(f.remote, ['rev-list', '--count', BRANCH], f.env), '1');
  assert.equal(git(f.remote, ['show', `${BRANCH}:${DEPENDENCY}`], f.env), 'module.exports = "1.2.3";');
  const marker = JSON.parse(git(f.remote, ['show', `${BRANCH}:${MARKER}`], f.env));
  assert.equal(marker.builder, BUILDER);
  assert.equal(marker.format, 1);
  assert.equal(marker.version, '1.2.3');
  assert.equal(marker.root, '.', 'published marker must not contain the maintainer local path');
});

test('repeating an identical marketplace artifact does not create another commit', async t => {
  const f = await fixture(t);
  await publish(f.opts(), f.env);
  const first = f.head();
  await publish(f.opts(), f.env);
  assert.equal(f.head(), first);
  assert.equal(git(f.remote, ['rev-list', '--count', BRANCH], f.env), '1');
});

test('a newer marketplace artifact fast forwards the branch and preserves its history', async t => {
  const f = await fixture(t);
  await publish(f.opts(), f.env);
  const first = f.head();
  await f.artifact('1.2.4');
  await publish(f.opts(), f.env);
  const next = f.head();
  assert.notEqual(next, first);
  assert.equal(git(f.remote, ['rev-list', '--count', BRANCH], f.env), '2');
  git(f.remote, ['merge-base', '--is-ancestor', first, next], f.env);
  assert.equal(git(f.remote, ['rev-parse', `${next}^`], f.env), first);
  assert.equal(git(f.remote, ['show', `${BRANCH}:${DEPENDENCY}`], f.env), 'module.exports = "1.2.4";');
});

test('a remote branch with another builder marker is rejected without replacing its contents', async t => {
  const f = await fixture(t);
  const foreign = path.join(f.root, 'foreign');
  await fs.mkdir(foreign);
  git(foreign, ['init', '--quiet'], f.env);
  git(foreign, ['checkout', '--quiet', '-b', REF], f.env);
  await writeJson(path.join(foreign, MARKER), { builder: 'another-builder', format: 1, version: '9.9.9' });
  await fs.writeFile(path.join(foreign, 'keep.txt'), 'foreign owner content\n');
  git(foreign, ['add', '--all'], f.env);
  git(foreign, ['commit', '--quiet', '-m', 'Foreign distribution branch'], f.env);
  git(foreign, ['push', f.remote, `HEAD:${BRANCH}`], f.env);
  const previous = f.head();
  await assert.rejects(publish(f.opts(), f.env), /拒绝覆盖|不是.*市场分发分支/);
  assert.equal(f.head(), previous);
  assert.equal(git(f.remote, ['show', `${BRANCH}:keep.txt`], f.env), 'foreign owner content');
  assert.equal(git(f.remote, ['rev-list', '--count', BRANCH], f.env), '1');
});

test('global Git ignores cannot omit the bundled node_modules runtime from publication', async t => {
  const f = await fixture(t);
  const ignore = path.join(f.root, 'global-ignore');
  await fs.writeFile(ignore, 'node_modules/\n');
  git(f.root, ['config', '--file', f.globalConfig, 'core.excludesFile', ignore], f.env);
  await publish(f.opts(), f.env);
  const tree = git(f.remote, ['ls-tree', '-r', '--name-only', BRANCH], f.env).split('\n');
  assert.ok(tree.includes(DEPENDENCY));
  assert.equal(git(f.remote, ['show', `${BRANCH}:${DEPENDENCY}`], f.env), 'module.exports = "1.2.3";');
});

test('invalid generated sources are rejected before any remote branch is created', async t => {
  const f = await fixture(t);
  for (const overrides of [
    { marker: { builder: 'foreign-builder' } },
    { marker: { format: 2 } },
    { manifest: { version: '8.0.0' } },
    { catalog: { name: 'foreign-marketplace' } }
  ]) {
    await f.artifact('1.2.3', overrides);
    await assert.rejects(validateSource(f.source), /不是经过构建/);
    await assert.rejects(publish(f.opts(), f.env), /不是经过构建/);
    assert.equal(f.refs(), '');
  }
});

test('publishing from a dirty development checkout preserves its files, index, refs and configuration', async t => {
  const f = await fixture(t);
  const development = path.join(f.root, 'development');
  await fs.mkdir(development);
  git(development, ['init', '--quiet'], f.env);
  git(development, ['config', 'fixture.preserve', 'unchanged'], f.env);
  await fs.writeFile(path.join(development, 'tracked.txt'), 'original content\n');
  git(development, ['add', 'tracked.txt'], f.env);
  git(development, ['commit', '--quiet', '-m', 'Development fixture'], f.env);
  await fs.writeFile(path.join(development, 'tracked.txt'), 'uncommitted user edit\n');
  await fs.writeFile(path.join(development, 'untracked.txt'), 'untracked user content\n');
  const files = await snapshot(development);
  const status = git(development, ['status', '--porcelain=v1'], f.env);
  const head = git(development, ['rev-parse', 'HEAD'], f.env);
  const refs = git(development, ['for-each-ref', '--format=%(refname):%(objectname)'], f.env);
  const globalConfiguration = await fs.readFile(f.globalConfig);
  const source = await snapshot(f.source);
  const result = spawnSync(process.execPath, [PUBLISHER, ...f.args, '--publish'], {
    cwd: development, env: f.env, encoding: 'utf8', timeout: 30000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(development, ['status', '--porcelain=v1'], f.env), status);
  assert.equal(git(development, ['rev-parse', 'HEAD'], f.env), head);
  assert.equal(git(development, ['for-each-ref', '--format=%(refname):%(objectname)'], f.env), refs);
  assert.equal(git(development, ['config', 'fixture.preserve'], f.env), 'unchanged');
  assert.deepEqual(await snapshot(development), files);
  assert.deepEqual(await fs.readFile(f.globalConfig), globalConfiguration);
  assert.deepEqual(await snapshot(f.source), source);
  assert.equal(f.refs(), BRANCH);
});
