#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const tar = require('tar');
const { validateSource } = require('./publish-marketplace.cjs');

const ARCHIVE = 'markdown-preview-marketplace.tgz';
const CHECKSUM = 'marketplace.SHA256SUMS';

async function requireMissing(output) {
  try { await fs.lstat(output); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`市场解包输出已经存在，拒绝覆盖：${output}`);
}

async function unpack(directory = path.resolve('dist'), expectedSourceCommit) {
  if (typeof expectedSourceCommit !== 'string' || !/^[a-fA-F0-9]{40}$/.test(expectedSourceCommit)) {
    throw new Error('预期来源提交必须是完整的 40 位 Git SHA。');
  }
  directory = path.resolve(directory);
  const output = path.join(directory, 'marketplace');
  await requireMissing(output);
  const bytes = await fs.readFile(path.join(directory, ARCHIVE));
  const checksum = await fs.readFile(path.join(directory, CHECKSUM), 'utf8');
  const match = /^([a-fA-F0-9]{64}) {2}markdown-preview-marketplace\.tgz\r?\n?$/.exec(checksum);
  if (!match) throw new Error('市场校验和文件格式或归档文件名不匹配。');
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== match[1].toLowerCase()) throw new Error('市场归档 SHA-256 校验失败。');

  const temporary = await fs.mkdtemp(path.join(directory, '.markdown-preview-marketplace-unpack-'));
  try {
    // Extract the exact bytes whose checksum was checked, even if the input
    // archive is replaced while this operation runs.
    // Synchronous extraction ensures all entry writes have stopped before
    // the failure cleanup removes the staging directory.
    tar.x({ cwd: temporary, strict: true, sync: true }).end(bytes);
    const staged = path.join(temporary, 'marketplace');
    const marker = await validateSource(staged);
    if (marker.sourceCommit !== expectedSourceCommit) {
      throw new Error('市场分发包来源提交与预期 Git SHA 不匹配。');
    }
    await requireMissing(output);
    await fs.rename(staged, output);
    return { ...marker, root: output };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (args.length !== 1) throw new Error('用法：node scripts/unpack-marketplace.cjs <来源 Git SHA>');
    return unpack(undefined, args[0]);
  }).then(result => {
    console.log(`已校验并解包市场分发包：${result.root}\n版本：${result.version}\n来源：${result.sourceCommit}`);
  }).catch(error => {
    console.error(`市场解包失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { unpack };
