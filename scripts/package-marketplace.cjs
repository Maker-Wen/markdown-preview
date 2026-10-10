#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
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
  // Keep prepared files and backups on the output filesystem for rename.
  const temporary = await fs.mkdtemp(path.join(output, '.markdown-preview-marketplace-package-'));
  const artifacts = [archive, path.join(output, 'marketplace.SHA256SUMS')].map(file => ({
    file,
    prepared: path.join(temporary, path.basename(file)),
    backup: path.join(temporary, `previous-${path.basename(file)}`),
    existed: false,
    backedUp: false,
    installed: false
  }));
  let bytes;
  let retainBackup = false;
  try {
    const staged = path.join(temporary, 'marketplace');
    await fs.cp(result.root, staged, { recursive: true });
    const markerFile = path.join(staged, MARKER);
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
    await fs.writeFile(markerFile, `${JSON.stringify({ ...marker, root: '.' }, null, 2)}\n`);
    await tar.c({ cwd: temporary, file: artifacts[0].prepared, gzip: true, portable: true }, ['marketplace']);
    bytes = await fs.readFile(artifacts[0].prepared);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(artifacts[1].prepared, `${hash}  ${path.basename(archive)}\n`);

    // Check both targets before moving either one; never move a user directory
    // or follow an output symlink, including a dangling one.
    for (const artifact of artifacts) {
      let stat;
      try { stat = await fs.lstat(artifact.file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`归档输出必须是普通文件，拒绝覆盖：${artifact.file}`);
      }
      artifact.existed = true;
    }
    for (const artifact of artifacts) {
      if (!artifact.existed) continue;
      await fs.rename(artifact.file, artifact.backup);
      artifact.backedUp = true;
    }
    for (const artifact of artifacts) {
      await fs.rename(artifact.prepared, artifact.file);
      artifact.installed = true;
    }
  } catch (error) {
    const recoveryErrors = [];
    for (const artifact of [...artifacts].reverse()) {
      try {
        // Remove only files installed by this attempt, preserving original
        // missing-file states as well as the contents of existing files.
        if (artifact.installed) await fs.rm(artifact.file, { force: true });
        if (artifact.backedUp) await fs.rename(artifact.backup, artifact.file);
      } catch (recoveryError) {
        recoveryErrors.push(new Error(`恢复 ${artifact.file} 失败：${recoveryError.message}`, { cause: recoveryError }));
      }
    }
    if (recoveryErrors.length) {
      retainBackup = true;
      throw new AggregateError([error, ...recoveryErrors],
        `${error.message}\n${recoveryErrors.map(failure => failure.message).join('\n')}\n打包备份已保留，请从此目录恢复：${temporary}`,
        { cause: error });
    }
    throw error;
  } finally {
    if (!retainBackup) {
      try { await fs.rm(temporary, { recursive: true, force: true }); }
      catch (error) { console.warn(`打包临时目录清理失败，目录已保留：${temporary}\n${error.message}`); }
    }
  }
  console.log(`市场分发包：${archive}\n版本：${result.version}\n压缩大小：${(bytes.length / 1024 / 1024).toFixed(2)} MiB`);
}

if (require.main === module) main().catch(error => {
  console.error(`市场打包失败：${error.message}`);
  process.exitCode = 1;
});

module.exports = { main };
