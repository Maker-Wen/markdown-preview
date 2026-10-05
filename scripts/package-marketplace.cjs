#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tar = require('tar');
const { build, parseArgs, MARKER } = require('./build-marketplace.cjs');

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Markdown Preview 市场打包器\n用法：node scripts/package-marketplace.cjs [--output 目录] [--version 版本] [--source-commit SHA]\n生成自包含市场、markdown-preview-marketplace.tgz 与 marketplace.SHA256SUMS。');
    return;
  }
  const result = await build(options);
  const output = path.dirname(result.root);
  const archive = path.join(output, 'markdown-preview-marketplace.tgz');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-marketplace-package-'));
  try {
    const staged = path.join(temporary, 'marketplace');
    await fs.cp(result.root, staged, { recursive: true });
    const markerFile = path.join(staged, MARKER);
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
    await fs.writeFile(markerFile, `${JSON.stringify({ ...marker, root: '.' }, null, 2)}\n`);
    await tar.c({ cwd: temporary, file: archive, gzip: true, portable: true }, ['marketplace']);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  const bytes = await fs.readFile(archive);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(output, 'marketplace.SHA256SUMS'), `${hash}  ${path.basename(archive)}\n`);
  console.log(`市场分发包：${archive}\n版本：${result.version}\n压缩大小：${(bytes.length / 1024 / 1024).toFixed(2)} MiB`);
}

if (require.main === module) main().catch(error => {
  console.error(`市场打包失败：${error.message}`);
  process.exitCode = 1;
});

module.exports = { main };
