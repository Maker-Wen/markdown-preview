#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_VERSION = '1.0.0';
const EXCLUDED = new Set(['.git', '.archify', 'node_modules', 'dist', '.DS_Store', 'playwright-report', 'test-results', 'coverage']);

function usage() {
  return `Markdown Preview 发布包

用法：node scripts/package-release.cjs [选项]
  --version <版本>  发布版本，默认为 ${DEFAULT_VERSION}
  --output <目录>   输出目录，默认为 ./dist
  --dry-run         只显示计划，不创建文件
  --help            显示用法
`;
}

function parseArgs(argv) {
  const options = { version: DEFAULT_VERSION, output: path.join(ROOT, 'dist'), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') return { help: true };
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--version' || arg === '--output') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数。`);
      if (arg === '--version') options.version = value.replace(/^v/, '');
      else options.output = path.resolve(value);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error(`版本号不是有效的 SemVer：${options.version}`);
  }
  return options;
}

function shouldCopy(source) {
  const relative = path.relative(ROOT, source);
  if (!relative) return true;
  return relative.split(path.sep).every(part => !EXCLUDED.has(part));
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

async function build(options) {
  const rootName = `markdown-preview-v${options.version}`;
  const archiveBase = rootName;
  const tarName = `${archiveBase}.tar.gz`;
  const zipName = `${archiveBase}.zip`;
  const outputs = [path.join(options.output, tarName), path.join(options.output, zipName), path.join(options.output, 'SHA256SUMS')];
  console.log(`版本：${options.version}`);
  console.log(`输出目录：${options.output}`);
  console.log(`产物：${tarName}、${zipName}、SHA256SUMS`);
  if (options.dryRun) return outputs;

  await fs.mkdir(options.output, { recursive: true });
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-release-'));
  let artifacts;
  try {
    const packageRoot = path.join(stage, rootName);
    await fs.cp(ROOT, packageRoot, { recursive: true, filter: shouldCopy });
    await fs.rm(path.join(packageRoot, 'dist'), { recursive: true, force: true });
    artifacts = await fs.mkdtemp(path.join(options.output, '.markdown-preview-release-'));
    const prepared = outputs.map(file => path.join(artifacts, path.basename(file)));
    execFileSync('tar', ['-czf', prepared[0], '-C', stage, rootName], {
      stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' }
    });
    execFileSync('zip', ['-qr', prepared[1], rootName], { cwd: stage, stdio: 'inherit' });
    const sums = [];
    for (const file of prepared.slice(0, 2)) sums.push(`${await sha256(file)}  ${path.basename(file)}`);
    await fs.writeFile(prepared[2], `${sums.join('\n')}\n`);
    for (let i = 0; i < outputs.length; i += 1) await fs.rename(prepared[i], outputs[i]);
    return outputs;
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (artifacts) await fs.rm(artifacts, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  return build(options);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`发布包生成失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_VERSION, build, main, parseArgs, shouldCopy };
