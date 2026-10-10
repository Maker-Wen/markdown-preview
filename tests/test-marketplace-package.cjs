'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const tar = require('tar');
const { build, MARKER, BUILDER } = require('../scripts/build-marketplace.cjs');
const { main: packageMarketplace } = require('../scripts/package-marketplace.cjs');

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

  await t.test('the package main entry point creates a portable archive that renders after relocation', async () => {
    await packageMarketplace(['--output', output, '--version', '1.2.3', '--source-commit', sourceCommit]);
    const archive = path.join(root, 'markdown-preview-marketplace.tgz');
    const bytes = await fs.readFile(archive);
    assert.equal(await fs.readFile(path.join(root, 'marketplace.SHA256SUMS'), 'utf8'),
      `${crypto.createHash('sha256').update(bytes).digest('hex')}  markdown-preview-marketplace.tgz\n`);
    const types = [];
    await tar.t({ file: archive, strict: true, onReadEntry: entry => types.push(entry.type) });
    assert.ok(types.length > 0);
    assert.ok(types.every(type => type === 'File' || type === 'Directory'), 'marketplace archive contains a link or special file');
    const relocated = path.join(root, 'relocated');
    await fs.mkdir(relocated);
    await tar.x({ file: archive, cwd: relocated, strict: true });
    const relocatedMarketplace = path.join(relocated, 'marketplace');
    assert.equal((await json(path.join(relocatedMarketplace, MARKER))).root, '.');
    assert.equal((await json(path.join(output, MARKER))).root, output);
    const isolatedPlugin = path.join(relocatedMarketplace, 'plugins/markdown-preview');
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

// Exercise the exported production entry point with real filesystem operations.
// Only building a large dependency tree and the selected failure are replaced.
async function packageMainFixture(t, existing = 'both') {
  const root = await temporary(t);
  const output = path.join(root, 'dist');
  const source = path.join(output, 'marketplace');
  const archiveName = 'markdown-preview-marketplace.tgz';
  const checksumName = 'marketplace.SHA256SUMS';
  const archive = path.join(output, archiveName);
  const checksum = path.join(output, checksumName);
  const payload = path.join(source, 'plugins/markdown-preview/README.md');
  await fs.mkdir(path.dirname(payload), { recursive: true });
  await fs.writeFile(payload, '# OLD_PACKAGE\n');
  await fs.writeFile(path.join(source, MARKER), JSON.stringify({ builder: BUILDER, format: 1, root: '.', version: '1.0.0' }));
  const previous = path.join(root, 'previous.tgz');
  await tar.c({ cwd: output, file: previous, gzip: true, portable: true }, ['marketplace']);
  const oldArchive = await fs.readFile(previous);
  const oldChecksum = Buffer.from(`${crypto.createHash('sha256').update(oldArchive).digest('hex')}  ${archiveName}\n`);
  if (existing === 'both' || existing === 'archive') await fs.writeFile(archive, oldArchive);
  if (existing === 'both' || existing === 'checksum') await fs.writeFile(checksum, oldChecksum);
  await fs.writeFile(payload, '# NEW_PACKAGE\n');
  await fs.writeFile(path.join(source, MARKER), JSON.stringify({ builder: BUILDER, format: 1, root: source, version: '1.0.1' }));
  const sentinel = path.join(output, 'unrelated.txt');
  await fs.writeFile(sentinel, 'preserve unrelated output\n');
  const before = new Map([[archive, existing === 'both' || existing === 'archive' ? oldArchive : null],
    [checksum, existing === 'both' || existing === 'checksum' ? oldChecksum : null]]);
  const logs = [], warnings = [], calls = [], hits = new Map();
  const hit = name => hits.set(name, (hits.get(name) || 0) + 1);
  const injected = name => Object.assign(new Error(`TEST_PACKAGE_${name.toUpperCase().replace(/-/g, '_')}_FAILED`), { code: 'EIO' });
  const production = path.join(ROOT, 'scripts/package-marketplace.cjs');
  const productionRequire = createRequire(production);

  async function load(faults = []) {
    const fsAdapter = Object.create(fs);
    fsAdapter.writeFile = async (file, ...args) => {
      if (faults.includes('checksum') && path.basename(String(file)) === checksumName && !hits.has('checksum')) {
        hit('checksum');
        await fs.writeFile(file, 'PARTIAL_CHECKSUM');
        throw injected('checksum');
      }
      return fs.writeFile(file, ...args);
    };
    fsAdapter.rename = async (from, to) => {
      calls.push({ operation: 'rename', from: String(from), to: String(to) });
      if ((faults.includes('commit') || faults.includes('restore') || faults.includes('restore-remove')) && path.resolve(String(to)) === checksum
        && path.basename(String(from)) === checksumName && !hits.has('commit')) {
        hit('commit');
        throw injected('commit');
      }
      if (faults.includes('backup') && path.basename(String(to)) === 'previous-' + checksumName && !hits.has('backup')) {
        hit('backup');
        throw injected('backup');
      }
      if (faults.includes('restore') && path.resolve(String(to)) === archive
        && path.basename(String(from)) === 'previous-' + archiveName && !hits.has('restore')) {
        hit('restore');
        throw injected('restore');
      }
      return fs.rename(from, to);
    };
    fsAdapter.rm = async (file, ...args) => {
      if (faults.includes('restore-remove') && path.resolve(String(file)) === archive
        && hits.has('commit') && !hits.has('restore-remove')) {
        hit('restore-remove');
        throw injected('restore-remove');
      }
      if (faults.includes('cleanup') && path.basename(String(file)).startsWith('.markdown-preview-marketplace-package-')
        && !hits.has('cleanup')) {
        hit('cleanup');
        throw injected('cleanup');
      }
      return fs.rm(file, ...args);
    };
    const tarAdapter = { ...tar };
    tarAdapter.c = async (options, entries) => {
      if (faults.includes('tar') && !hits.has('tar')) {
        hit('tar');
        await fs.writeFile(options.file, 'PARTIAL_TAR');
        throw injected('tar');
      }
      return tar.c(options, entries);
    };
    const controlledRequire = specifier => {
      if (specifier === 'node:fs/promises') return fsAdapter;
      if (specifier === 'tar') return tarAdapter;
      if (specifier === './build-marketplace.cjs') return {
        ...productionRequire(specifier),
        build: async options => {
          assert.equal(options.output, source);
          assert.equal(options.version, '1.0.1');
          return { root: source, version: '1.0.1' };
        }
      };
      return productionRequire(specifier);
    };
    const loaded = { exports: {} };
    vm.runInNewContext(await fs.readFile(production, 'utf8'), {
      require: controlledRequire, module: loaded, exports: loaded.exports,
      process, Buffer, __filename: production, __dirname: path.dirname(production),
      console: { log: value => logs.push(String(value)), warn: value => warnings.push(String(value)), error: value => warnings.push(String(value)) }
    }, { filename: production });
    assert.equal(typeof loaded.exports.main, 'function');
    return () => loaded.exports.main(['--output', source, '--version', '1.0.1']);
  }

  const workDirectories = async () => (await fs.readdir(output))
    .filter(name => name.startsWith('.markdown-preview-marketplace-package-')).map(name => path.join(output, name));
  async function assertRestored() {
    for (const [file, bytes] of before) {
      if (bytes) assert.deepEqual(await fs.readFile(file), bytes, `previous bytes changed: ${file}`);
      else await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    }
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve unrelated output\n');
    assert.deepEqual(await workDirectories(), []);
    assert.deepEqual(logs, [], 'a failed package must not emit a success summary');
  }
  return { root, output, source, archive, checksum, oldArchive, oldChecksum, before,
    logs, warnings, calls, hits, load, workDirectories, assertRestored };
}

for (const fault of ['tar', 'checksum', 'commit']) {
  test(`marketplace package main restores exact outputs after ${fault} failure`, async t => {
    for (const existing of ['none', 'both', 'archive', 'checksum']) {
      await t.test(existing, async t => {
        const f = await packageMainFixture(t, existing);
        const run = await f.load([fault]);
        await assert.rejects(run(), new RegExp(`TEST_PACKAGE_${fault.toUpperCase()}_FAILED`));
        assert.equal(f.hits.get(fault), 1, 'the intended failure must actually be injected');
        await f.assertRestored();
      });
    }
  });
}

test('marketplace package main restores the first backup if the second backup fails', async t => {
  const f = await packageMainFixture(t);
  const run = await f.load(['backup']);
  await assert.rejects(run(), /TEST_PACKAGE_BACKUP_FAILED/);
  assert.equal(f.hits.get('backup'), 1);
  assert.ok(f.calls.some(call => call.from === f.archive && path.basename(call.to) === 'previous-' + path.basename(f.archive)));
  await f.assertRestored();
});

test('marketplace package main replaces both outputs and reports a portable successful package', async t => {
  const f = await packageMainFixture(t);
  const run = await f.load();
  await run();
  const bytes = await fs.readFile(f.archive);
  assert.notDeepEqual(bytes, f.oldArchive);
  assert.equal(await fs.readFile(f.checksum, 'utf8'), `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${path.basename(f.archive)}\n`);
  const extracted = path.join(f.root, 'extracted');
  await fs.mkdir(extracted);
  await tar.x({ file: f.archive, cwd: extracted, strict: true });
  assert.equal((await json(path.join(extracted, 'marketplace', MARKER))).root, '.');
  assert.equal((await json(path.join(f.source, MARKER))).root, f.source, 'portable marker rewriting must leave the built source unchanged');
  assert.equal(await fs.readFile(path.join(extracted, 'marketplace/plugins/markdown-preview/README.md'), 'utf8'), '# NEW_PACKAGE\n');
  assert.deepEqual(await f.workDirectories(), []);
  assert.deepEqual(f.warnings, []);
  assert.equal(f.logs.length, 1);
  assert.ok(f.logs[0].includes(`市场分发包：${f.archive}\n版本：1.0.1\n`));
  assert.match(f.logs[0], /压缩大小：\d+\.\d{2} MiB$/);
});

test('marketplace package main retains recoverable backups and reports both failures if restoration fails', async t => {
  for (const fault of ['restore', 'restore-remove']) {
    await t.test(fault, async t => {
      const f = await packageMainFixture(t);
      const run = await f.load([fault]);
      let failure;
      await assert.rejects(run(), error => {
        failure = error;
        return error.name === 'AggregateError' && error.message.includes('TEST_PACKAGE_COMMIT_FAILED')
          && error.message.includes(`TEST_PACKAGE_${fault.toUpperCase().replace(/-/g, '_')}_FAILED`);
      });
      assert.equal(f.hits.get('commit'), 1);
      assert.equal(f.hits.get(fault), 1);
      const work = await f.workDirectories();
      assert.equal(work.length, 1);
      assert.ok(failure.message.includes(work[0]), 'the error must identify the recovery directory');
      const recoveryArchive = path.join(work[0], 'previous-' + path.basename(f.archive));
      assert.deepEqual(await fs.readFile(recoveryArchive), f.oldArchive);
      assert.deepEqual(await fs.readFile(f.checksum), f.oldChecksum);
      assert.equal(crypto.createHash('sha256').update(await fs.readFile(recoveryArchive)).digest('hex'), f.oldChecksum.toString('utf8').split(/\s+/)[0]);
      assert.deepEqual(f.logs, []);
    });
  }
});

test('marketplace package main refuses directories and symlinks without moving either target', async t => {
  for (const target of ['archive', 'checksum']) {
    for (const kind of ['directory', 'symlink', 'dangling-symlink']) {
      await t.test(`${target} ${kind}`, async t => {
        const f = await packageMainFixture(t);
        const file = f[target];
        await fs.rm(file);
        const linked = path.join(f.root, 'linked-output');
        if (kind === 'directory') {
          await fs.mkdir(file);
          await fs.writeFile(path.join(file, 'keep.txt'), 'preserve this directory\n');
        } else {
          if (kind === 'symlink') await fs.writeFile(linked, 'preserve linked bytes\n');
          await fs.symlink(linked, file, 'file');
        }
        const run = await f.load();
        await assert.rejects(run(), /普通文件|拒绝覆盖/);
        if (kind === 'directory') assert.equal(await fs.readFile(path.join(file, 'keep.txt'), 'utf8'), 'preserve this directory\n');
        else {
          assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
          assert.equal(await fs.readlink(file), linked);
          if (kind === 'symlink') assert.equal(await fs.readFile(linked, 'utf8'), 'preserve linked bytes\n');
          else await assert.rejects(fs.lstat(linked), { code: 'ENOENT' });
        }
        const untouched = target === 'archive' ? f.checksum : f.archive;
        assert.deepEqual(await fs.readFile(untouched), f.before.get(untouched));
        assert.deepEqual(f.calls, [], 'both output types must be checked before either original is moved');
        assert.deepEqual(await f.workDirectories(), []);
        assert.deepEqual(f.logs, []);
      });
    }
  }
});

test('marketplace package main warns on cleanup failure without rejecting an installed valid pair', async t => {
  const f = await packageMainFixture(t);
  const run = await f.load(['cleanup']);
  await run();
  assert.equal(f.hits.get('cleanup'), 1);
  const bytes = await fs.readFile(f.archive);
  assert.notDeepEqual(bytes, f.oldArchive);
  assert.equal(await fs.readFile(f.checksum, 'utf8'), `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${path.basename(f.archive)}\n`);
  assert.equal(f.logs.length, 1);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /TEST_PACKAGE_CLEANUP_FAILED/);
  const work = await f.workDirectories();
  assert.equal(work.length, 1);
  assert.ok(f.warnings[0].includes(work[0]));
});

test('marketplace package main retains the original failure when rollback cleanup also fails', async t => {
  const f = await packageMainFixture(t);
  const run = await f.load(['checksum', 'cleanup']);
  await assert.rejects(run(), error => error.code === 'EIO' && error.message === 'TEST_PACKAGE_CHECKSUM_FAILED');
  assert.equal(f.hits.get('checksum'), 1);
  assert.equal(f.hits.get('cleanup'), 1);
  assert.deepEqual(await fs.readFile(f.archive), f.oldArchive);
  assert.deepEqual(await fs.readFile(f.checksum), f.oldChecksum);
  assert.deepEqual(f.logs, []);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /TEST_PACKAGE_CLEANUP_FAILED/);
  const work = await f.workDirectories();
  assert.equal(work.length, 1);
  assert.ok(f.warnings[0].includes(work[0]));
});
