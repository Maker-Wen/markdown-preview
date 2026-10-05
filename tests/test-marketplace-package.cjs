'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const tar = require('tar');
const { build, MARKER, BUILDER } = require('../scripts/build-marketplace.cjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PLUGIN = path.join(ROOT, 'plugins/markdown-preview');

async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-marketplace-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

async function walk(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (entry.isDirectory()) await visit(file);
      else entries.push({ path: relative, file, symbolicLink: entry.isSymbolicLink(), regularFile: entry.isFile() });
    }
  }
  await visit(root);
  return entries;
}

test('marketplace builder refuses unknown output directories and preserves their contents', async t => {
  const root = await temporary(t);
  const output = path.join(root, 'existing-work');
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'important.txt'), 'preserve this user file');
  await assert.rejects(build({ output }), /拒绝覆盖|不由.*管理/);
  assert.deepEqual(await fs.readdir(output), ['important.txt']);
  assert.equal(await fs.readFile(path.join(output, 'important.txt'), 'utf8'), 'preserve this user file');
});

test('marketplace builder refuses repository/source roots and their protected descendants', async () => {
  const sourceManifest = await fs.readFile(path.join(SOURCE_PLUGIN, 'plugin.json'));
  for (const output of [ROOT, path.dirname(ROOT), SOURCE_PLUGIN, path.join(SOURCE_PLUGIN, 'generated-marketplace-test')]) {
    await assert.rejects(build({ output }), /仓库|源码/);
  }
  assert.deepEqual(await fs.readFile(path.join(SOURCE_PLUGIN, 'plugin.json')), sourceManifest);
});

test('a symlink ancestor cannot redirect marketplace output into the source plugin', async t => {
  const root = await temporary(t);
  const alias = path.join(root, 'source-alias');
  await fs.symlink(SOURCE_PLUGIN, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(build({ output: path.join(alias, 'generated-marketplace-test') }), /符号链接|源码/);
  assert.equal(await fs.access(path.join(SOURCE_PLUGIN, 'generated-marketplace-test')).then(() => true, () => false), false);
});

test('mismatched or linked management markers do not grant permission to replace a directory', async t => {
  const root = await temporary(t);
  const output = path.join(root, 'mismatched');
  await fs.mkdir(output);
  const marker = { builder: BUILDER, format: 1, root: path.join(root, 'another-output'), version: '1.0.0' };
  await fs.writeFile(path.join(output, MARKER), JSON.stringify(marker));
  await fs.writeFile(path.join(output, 'keep.txt'), 'keep');
  await assert.rejects(build({ output }), /不匹配|拒绝覆盖/);
  assert.equal(await fs.readFile(path.join(output, 'keep.txt'), 'utf8'), 'keep');

  const linked = path.join(root, 'linked');
  await fs.mkdir(linked);
  const markerFile = path.join(root, 'marker.json');
  await fs.writeFile(markerFile, JSON.stringify({ ...marker, root: linked }));
  await fs.symlink(markerFile, path.join(linked, MARKER));
  await assert.rejects(build({ output: linked }), /拒绝覆盖|不由.*管理/);
  assert.equal((await fs.lstat(path.join(linked, MARKER))).isSymbolicLink(), true);
});

test('invalid version overrides fail before creating a marketplace output', async t => {
  const root = await temporary(t);
  const output = path.join(root, 'marketplace');
  for (const version of ['not-a-version', '1.2.3\n', '1.2.3 ', '01.2.3']) {
    await assert.rejects(build({ output, version }), /SemVer|版本/);
    assert.equal(await fs.access(output).then(() => true, () => false), false);
  }
});

test('source provenance rejects ambiguous or malformed commit identifiers before building', async t => {
  const root = await temporary(t);
  const output = path.join(root, 'marketplace');
  for (const sourceCommit of ['HEAD', '00bc747', 'a'.repeat(40) + '\n', '../main']) {
    await assert.rejects(build({ output, sourceCommit }), /Git SHA/);
    assert.equal(await fs.access(output).then(() => true, () => false), false);
  }
});

test('self-contained marketplace preserves its production runtime and runs after archive relocation', async t => {
  const root = await temporary(t);
  const output = path.join(root, 'marketplace');
  const sourceCommit = 'a'.repeat(40);
  const result = await build({ output, version: 'v1.2.3', sourceCommit });
  assert.equal(result.root, output);
  assert.equal(result.plugin, path.join(output, 'plugins/markdown-preview'));
  assert.ok(result.stats.packages > 0);
  assert.ok(result.stats.files > 0);
  assert.ok(result.stats.bytes > 0);
  assert.ok(result.stats.previewRoots.length > 0);

  await t.test('catalog paths and both plugin manifests agree on the built version', async () => {
    const catalog = await json(path.join(output, '.agents/plugins/marketplace.json'));
    const sourceCatalog = await json(path.join(ROOT, '.agents/plugins/marketplace.json'));
    assert.deepEqual(catalog, sourceCatalog);
    const entry = catalog.plugins.find(plugin => plugin.name === 'markdown-preview');
    assert.equal(entry.source.source, 'local');
    assert.equal(path.resolve(output, entry.source.path), result.plugin);
    const manifest = await json(path.join(result.plugin, 'plugin.json'));
    const overlay = await json(path.join(result.plugin, '.codex-plugin/plugin.json'));
    assert.equal(manifest.name, overlay.name);
    assert.equal(manifest.version, '1.2.3');
    assert.equal(overlay.version, manifest.version);
    for (const file of ['package.json', 'runtime/renderer/package.json']) {
      const metadata = await json(path.join(result.plugin, file));
      assert.equal(metadata.version, manifest.version);
      assert.equal(metadata.devDependencies, undefined);
      assert.equal(metadata.scripts, undefined);
    }
    const marker = await json(path.join(output, MARKER));
    assert.equal(marker.builder, BUILDER);
    assert.equal(marker.format, 1);
    assert.equal(marker.root, output);
    assert.equal(marker.version, '1.2.3');
    assert.equal(marker.contentHash, result.contentHash);
    assert.equal(marker.sourceCommit, sourceCommit);
    assert.match(result.contentHash, /^[a-f0-9]{64}$/);
    for (const file of ['README.md', 'plugins/markdown-preview/README.md']) {
      const readme = await fs.readFile(path.join(output, file), 'utf8');
      assert.match(readme, /--ref codex\/marketplace/);
      assert.match(readme, /marketplace upgrade markdown-preview-marketplace/);
      assert.ok(readme.includes(sourceCommit));
      assert.ok(readme.includes('1.2.3'));
      assert.doesNotMatch(readme, /\.\.\/\.\.\/docs\//);
    }
  });

  await t.test('development tools, test directories, native modules and symlinks are excluded', async () => {
    const entries = await walk(result.plugin);
    assert.ok(entries.length > 0);
    assert.deepEqual(entries.filter(entry => entry.symbolicLink || !entry.regularFile).map(entry => entry.path), []);
    assert.deepEqual(entries.filter(entry => /(?:^|\/)(?:playwright(?:-core)?|tests?|__tests__|\.git|\.github|coverage|playwright-report|test-results)(?:\/|$)/.test(entry.path)).map(entry => entry.path), []);
    assert.deepEqual(entries.filter(entry => /\.node$/i.test(entry.path)).map(entry => entry.path), []);
    for (const file of ['package-lock.json', 'runtime/renderer/package-lock.json', 'scripts/test-mcp.cjs', 'scripts/test-browser.cjs']) {
      assert.ok(!entries.some(entry => entry.path === file), `development file was copied: ${file}`);
    }
  });

  await t.test('third-party licenses and Mermaid/KaTeX scripts, styles and fonts survive packaging', async () => {
    const retained = [
      'node_modules/@modelcontextprotocol/sdk/LICENSE',
      'runtime/renderer/node_modules/crossnote/LICENSE.md',
      'runtime/renderer/node_modules/crossnote/out/dependencies/mermaid/mermaid.min.js',
      'runtime/renderer/node_modules/crossnote/out/dependencies/katex/katex.min.css',
      'runtime/renderer/node_modules/crossnote/out/dependencies/katex/fonts/KaTeX_Main-Regular.woff2'
    ];
    for (const file of retained) {
      const original = await fs.readFile(path.join(SOURCE_PLUGIN, file));
      assert.ok(original.length > 0, `empty source resource: ${file}`);
      assert.deepEqual(await fs.readFile(path.join(result.plugin, file)), original, `changed or missing distributed resource: ${file}`);
    }
  });

  await t.test('relocated archive uses only its own dependencies for full Markdown render and bundled viewer HTML', async () => {
    const archive = path.join(root, 'marketplace.tar.gz');
    await tar.c({ file: archive, gzip: true, cwd: output }, ['.']);
    const types = [];
    await tar.t({ file: archive, strict: true, onReadEntry: entry => types.push(entry.type) });
    assert.ok(types.length > 0);
    assert.ok(types.every(type => type === 'File' || type === 'Directory'), 'marketplace archive contains a link or special file');
    const relocated = path.join(root, 'relocated');
    await fs.mkdir(relocated);
    await tar.x({ file: archive, cwd: relocated, strict: true });
    const isolatedPlugin = path.join(relocated, 'plugins/markdown-preview');
    const working = path.join(root, 'independent-workspace');
    await fs.mkdir(working);
    const docs = path.join(working, '文档目录');
    await fs.mkdir(docs);
    const markdown = path.join(docs, '完整示例.md');
    const sample = await fs.readFile(path.join(SOURCE_PLUGIN, 'tests/fixtures/markdown-sample.md'), 'utf8');
    await fs.writeFile(path.join(docs, '本地图.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>');
    await fs.writeFile(markdown, sample + '\n\n![本地图](本地图.svg)\n\n<script>UNSAFE_SCRIPT_SENTINEL</script>\n\n@import "../secret.md"\n');
    const child = path.join(working, 'verify.cjs');
    await fs.writeFile(child, String.raw`'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const [plugin, file] = process.argv.slice(2);
globalThis.fetch = async () => { throw new Error('fixture: network is forbidden'); };
for (const name of ['node:http', 'node:https']) {
  const http = require(name);
  http.request = http.get = () => { throw new Error('fixture: network is forbidden'); };
}
(async () => {
  const requirePlugin = createRequire(path.join(plugin, 'package.json'));
  const { McpServer } = requirePlugin('@modelcontextprotocol/sdk/server/mcp.js');
  assert.equal(typeof McpServer, 'function');
  const { render, viewerHtml } = require(path.join(plugin, 'scripts/render.cjs'));
  const rendered = await render(file, await fs.readFile(file, 'utf8'));
  assert.match(rendered.html, /class="katex"/);
  assert.match(rendered.html, /class="mermaid"/);
  assert.match(rendered.html, /class="token /);
  assert.match(rendered.html, /<table\b/);
  assert.match(rendered.html, /src="data:image\/svg\+xml;base64,/);
  assert.match(rendered.toc, /Markdown 功能示例/);
  assert.doesNotMatch(rendered.html, /<script\b/);
  const ui = await viewerHtml();
  assert.match(ui, /data:font\/woff2;base64,/);
  assert.match(ui, /mermaid/);
  assert.doesNotMatch(ui, /\/\* BUNDLED_/);
  assert.doesNotMatch(ui, /url\(fonts\//);
  const modules = Object.keys(require.cache).filter(file => file !== __filename);
  assert.ok(modules.length > 0);
  assert.deepEqual(modules.filter(file => !file.startsWith(plugin + path.sep)), []);
  process.stdout.write(JSON.stringify({ modules: modules.length, renderedBytes: Buffer.byteLength(rendered.html), viewerBytes: Buffer.byteLength(ui) }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    const processResult = spawnSync(process.execPath, ['--no-global-search-paths', child, isolatedPlugin, markdown], {
      cwd: working, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_offline: 'true' },
      maxBuffer: 1024 * 1024
    });
    assert.equal(processResult.error, undefined);
    assert.equal(processResult.status, 0, processResult.stdout + processResult.stderr);
    const verification = JSON.parse(processResult.stdout);
    assert.ok(verification.modules > 0);
    assert.ok(verification.renderedBytes > 0);
    assert.ok(verification.viewerBytes > 0);
  });

  await t.test('managed rebuild replaces old generated files and updates both versions', async () => {
    await fs.writeFile(path.join(output, 'obsolete-generated-file.txt'), 'old build artifact');
    const rebuilt = await build({ output, version: '1.2.4', sourceCommit });
    assert.equal(rebuilt.root, output);
    assert.equal(await fs.access(path.join(output, 'obsolete-generated-file.txt')).then(() => true, () => false), false);
    assert.equal((await json(path.join(rebuilt.plugin, 'plugin.json'))).version, '1.2.4');
    assert.equal((await json(path.join(rebuilt.plugin, '.codex-plugin/plugin.json'))).version, '1.2.4');
    assert.equal(rebuilt.contentHash, result.contentHash, 'explicit manifest version changes must not alter the content identity');
    assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.markdown-preview-marketplace-build-')), []);
  });

  await t.test('default versions include the stable content hash independently of the output location', async () => {
    const defaultBuild = await build({ output: path.join(root, 'another-marketplace'), sourceCommit });
    const sourceVersion = (await json(path.join(SOURCE_PLUGIN, 'plugin.json'))).version;
    assert.equal(defaultBuild.contentHash, result.contentHash);
    assert.equal(defaultBuild.version, `${sourceVersion.split('+')[0]}+marketplace.${defaultBuild.contentHash.slice(0, 16)}`);
    const manifest = await json(path.join(defaultBuild.plugin, 'plugin.json'));
    const overlay = await json(path.join(defaultBuild.plugin, '.codex-plugin/plugin.json'));
    assert.equal(manifest.version, defaultBuild.version);
    assert.equal(overlay.version, defaultBuild.version);
    const marker = await json(path.join(defaultBuild.root, MARKER));
    assert.equal(marker.sourceVersion, sourceVersion);
    assert.equal(marker.contentHash, result.contentHash);
  });
});
