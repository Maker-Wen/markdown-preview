'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const tar = require('tar');
const { unpack } = require('../scripts/unpack-marketplace.cjs');
const { MARKER, BUILDER } = require('../scripts/build-marketplace.cjs');

const SHA = 'a'.repeat(40);
const ARCHIVE = 'markdown-preview-marketplace.tgz';
const CHECKSUM = 'marketplace.SHA256SUMS';
const RUNTIME = 'plugins/markdown-preview/node_modules/fixture-runtime/index.js';

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(t, sourceCommit = SHA) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-unpack-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source', 'marketplace');
  const directory = path.join(root, 'dist');
  await fs.mkdir(directory);
  await writeJson(path.join(source, MARKER), {
    builder: BUILDER, format: 1, root: '.', version: '1.2.3', sourceCommit
  });
  await writeJson(path.join(source, '.agents/plugins/marketplace.json'), {
    name: 'markdown-preview-marketplace',
    plugins: [{ name: 'markdown-preview', source: { source: 'local', path: './plugins/markdown-preview' } }]
  });
  await writeJson(path.join(source, 'plugins/markdown-preview/plugin.json'), {
    name: 'markdown-preview', version: '1.2.3'
  });
  await fs.mkdir(path.dirname(path.join(source, RUNTIME)), { recursive: true });
  const runtime = Buffer.from('module.exports = "same validated runtime";\n');
  await fs.writeFile(path.join(source, RUNTIME), runtime);
  const archive = path.join(directory, ARCHIVE);
  const checksum = path.join(directory, CHECKSUM);
  await tar.c({ cwd: path.dirname(source), file: archive, gzip: true, portable: true }, ['marketplace']);
  const archiveBytes = await fs.readFile(archive);
  const checksumBytes = Buffer.from(`${crypto.createHash('sha256').update(archiveBytes).digest('hex')}  ${ARCHIVE}\n`);
  await fs.writeFile(checksum, checksumBytes);
  const output = path.join(directory, 'marketplace');
  const assertInputsUnchanged = async (expectedArchive = archiveBytes, expectedChecksum = checksumBytes) => {
    assert.deepEqual(await fs.readFile(archive), expectedArchive);
    assert.deepEqual(await fs.readFile(checksum), expectedChecksum);
  };
  const assertNoOutput = async () => {
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(directory)).sort(), [ARCHIVE, CHECKSUM].sort());
  };
  return { root, source, directory, archive, checksum, archiveBytes, checksumBytes,
    output, runtime, assertInputsUnchanged, assertNoOutput };
}

test('unpacking preserves archive bytes and installs the exact validated runtime and source identity', async t => {
  const f = await fixture(t);
  const result = await unpack(f.directory, SHA);
  assert.equal(result.root, f.output);
  assert.equal(result.sourceCommit, SHA);
  assert.equal(result.version, '1.2.3');
  assert.deepEqual(await fs.readFile(path.join(f.output, RUNTIME)), f.runtime);
  assert.deepEqual(await fs.readFile(path.join(f.output, MARKER)), await fs.readFile(path.join(f.source, MARKER)));
  await f.assertInputsUnchanged();
  assert.deepEqual((await fs.readdir(f.directory)).sort(), [ARCHIVE, CHECKSUM, 'marketplace'].sort());
});

test('a tampered archive fails its checksum without leaving an unpacked output', async t => {
  const f = await fixture(t);
  const tampered = Buffer.concat([f.archiveBytes, Buffer.from('changed archive')]);
  await fs.writeFile(f.archive, tampered);
  await assert.rejects(unpack(f.directory, SHA), /SHA-256/);
  await f.assertNoOutput();
  await f.assertInputsUnchanged(tampered);
});

test('a checksum naming another archive is rejected even when its hash matches', async t => {
  const f = await fixture(t);
  const changed = Buffer.from(f.checksumBytes.toString('utf8').replace(ARCHIVE, 'another-marketplace.tgz'));
  await fs.writeFile(f.checksum, changed);
  await assert.rejects(unpack(f.directory, SHA), /文件名不匹配/);
  await f.assertNoOutput();
  await f.assertInputsUnchanged(f.archiveBytes, changed);
});

test('an invalid archive with a matching checksum removes its temporary extraction', async t => {
  const f = await fixture(t);
  const invalid = Buffer.from('this is not a tar archive');
  const checksum = Buffer.from(`${crypto.createHash('sha256').update(invalid).digest('hex')}  ${ARCHIVE}\n`);
  await fs.writeFile(f.archive, invalid);
  await fs.writeFile(f.checksum, checksum);
  await assert.rejects(unpack(f.directory, SHA), /TAR_BAD_ARCHIVE|Unrecognized archive format/);
  await f.assertNoOutput();
  await f.assertInputsUnchanged(invalid, checksum);
});

test('an artifact built from another source commit is rejected and its temporary extraction is removed', async t => {
  const f = await fixture(t, 'b'.repeat(40));
  await assert.rejects(unpack(f.directory, SHA), /来源提交.*不匹配/);
  await f.assertNoOutput();
  await f.assertInputsUnchanged();
});

test('an invalid expected commit is rejected without modifying distribution inputs', async t => {
  const f = await fixture(t);
  for (const value of [undefined, 'HEAD', 'a'.repeat(39), SHA + '\n']) {
    await assert.rejects(unpack(f.directory, value), /40 位 Git SHA/);
  }
  await f.assertNoOutput();
  await f.assertInputsUnchanged();
});

test('an existing marketplace output is preserved instead of replaced', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.output);
  const sentinel = path.join(f.output, 'keep.txt');
  const bytes = Buffer.from('preserve existing marketplace output\n');
  await fs.writeFile(sentinel, bytes);
  await assert.rejects(unpack(f.directory, SHA), /已经存在.*拒绝覆盖/);
  assert.deepEqual(await fs.readFile(sentinel), bytes);
  assert.deepEqual(await fs.readdir(f.output), ['keep.txt']);
  await f.assertInputsUnchanged();
  assert.deepEqual((await fs.readdir(f.directory)).sort(), [ARCHIVE, CHECKSUM, 'marketplace'].sort());
});
