#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MARKER, BUILDER, DEFAULT_OUTPUT } = require('./build-marketplace.cjs');

function options(argv) {
  const result = {
    source: DEFAULT_OUTPUT, repo: 'https://github.com/Maker-Wen/markdown-preview.git',
    ref: 'codex/marketplace', publish: false
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') { result.help = true; continue; }
    if (key === '--publish') { result.publish = true; continue; }
    if (!['--source', '--repo', '--ref', '--expected-source-commit', '--source-ref'].includes(key)) throw new Error(`未知参数：${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('-')) throw new Error(`${key} 缺少有效参数。`);
    const field = key === '--expected-source-commit' ? 'expectedSourceCommit' : key === '--source-ref' ? 'sourceRef' : key.slice(2);
    result[field] = value;
  }
  result.source = path.resolve(result.source);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result.ref) || result.ref.includes('..') || result.ref.endsWith('/') || result.ref.endsWith('.lock')) {
    throw new Error('分发分支名无效。');
  }
  validateGuard(result);
  return result;
}

function validateGuard(opts) {
  if ((opts.expectedSourceCommit === undefined) !== (opts.sourceRef === undefined)) {
    throw new Error('--expected-source-commit 与 --source-ref 必须同时提供。');
  }
  if (opts.expectedSourceCommit === undefined) return;
  if (!/^[0-9a-f]{40}$/.test(opts.expectedSourceCommit)) throw new Error('预期来源提交必须是完整的 Git SHA。');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(opts.sourceRef) || opts.sourceRef.includes('..') ||
      opts.sourceRef.endsWith('/') || opts.sourceRef.endsWith('.lock') || opts.sourceRef === opts.ref) {
    throw new Error('来源分支名无效或与分发分支相同。');
  }
}

function git(cwd, args, env) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Git 操作失败：${args[0]}\n${result.stderr}`);
  return result.stdout;
}

async function validateSource(source) {
  const stat = await fs.lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('市场来源必须是普通目录。');
  const marker = JSON.parse(await fs.readFile(path.join(source, MARKER), 'utf8'));
  const catalog = JSON.parse(await fs.readFile(path.join(source, '.agents/plugins/marketplace.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'plugins/markdown-preview/plugin.json'), 'utf8'));
  if (marker.builder !== BUILDER || marker.format !== 1 || marker.version !== manifest.version ||
      catalog.name !== 'markdown-preview-marketplace') throw new Error('市场来源不是经过构建的 Markdown Preview 分发包。');
  return marker;
}

async function publish(opts, env = process.env) {
  validateGuard(opts);
  const marker = await validateSource(opts.source);
  if (opts.expectedSourceCommit !== undefined && marker.sourceCommit !== opts.expectedSourceCommit) {
    throw new Error('市场运行包的来源提交与预期来源提交不一致。');
  }
  if (!opts.publish) {
    console.log(`市场：${opts.source}\n版本：${marker.version}\n目标：${opts.repo}（${opts.ref}）\n使用 --publish 发布。`);
    return;
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-marketplace-publish-'));
  try {
    git(temporary, ['init', '--quiet'], env);
    git(temporary, ['check-ref-format', '--branch', opts.ref], env);
    git(temporary, ['remote', 'add', 'origin', opts.repo], env);
    const sourceIsCurrent = () => {
      if (opts.expectedSourceCommit === undefined) return true;
      const branch = `refs/heads/${opts.sourceRef}`;
      const source = git(temporary, ['ls-remote', '--heads', 'origin', branch], env).trim().split(/\s+/);
      if (source.length !== 2 || source[1] !== branch || !/^[0-9a-f]{40}$/.test(source[0])) {
        throw new Error(`无法确认远程来源分支：${opts.sourceRef}`);
      }
      if (source[0] === opts.expectedSourceCommit) return true;
      console.log(`跳过已过期的市场运行包：${opts.sourceRef} 已不再指向 ${opts.expectedSourceCommit}。`);
      return false;
    };
    if (!sourceIsCurrent()) return;
    const remote = git(temporary, ['ls-remote', '--heads', 'origin', `refs/heads/${opts.ref}`], env).trim();
    if (remote) {
      git(temporary, ['fetch', '--depth', '1', 'origin', `refs/heads/${opts.ref}`], env);
      git(temporary, ['checkout', '--quiet', '-B', opts.ref, 'FETCH_HEAD'], env);
      const previous = JSON.parse(await fs.readFile(path.join(temporary, MARKER), 'utf8'));
      if (previous.builder !== BUILDER || previous.format !== 1) throw new Error('已有远程分支不是本项目的市场分发分支，拒绝覆盖。');
      git(temporary, ['rm', '-r', '--quiet', '--ignore-unmatch', '.'], env);
    } else {
      git(temporary, ['checkout', '--quiet', '--orphan', opts.ref], env);
    }
    await fs.cp(opts.source, temporary, { recursive: true, errorOnExist: false });
    // A published build marker records the artifact, not the maintainer's local path.
    await fs.writeFile(path.join(temporary, MARKER), `${JSON.stringify({ ...marker, root: '.' }, null, 2)}\n`);
    // Runtime dependencies must be committed even if the maintainer's global
    // Git ignore rules exclude node_modules.
    git(temporary, ['add', '--force', '--all'], env);
    const diff = git(temporary, ['diff', '--cached', '--name-only'], env).trim();
    if (!diff) { console.log('分发分支已经包含相同产物。'); return; }
    git(temporary, ['commit', '--quiet', '-m', `Publish Markdown Preview ${marker.version}`], env);
    // A rerun of an older successful CI must not replace a newer distribution.
    // Check again after committing, immediately before the normal push.
    if (!sourceIsCurrent()) return;
    // Normal fast-forward push protects concurrent publishers and existing history.
    git(temporary, ['push', 'origin', `HEAD:refs/heads/${opts.ref}`], env);
    console.log(`已发布市场分支：${opts.ref}\n版本：${marker.version}`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (opts.help) {
    console.log('Markdown Preview 市场发布器\n\n用法：node scripts/publish-marketplace.cjs [--source 目录] [--repo Git地址] [--ref 分支] [--expected-source-commit SHA --source-ref 来源分支] [--publish]\n默认预览发布计划，加 --publish 推送。默认分支为 codex/marketplace。\n自动发布应同时提供预期来源提交与来源分支；来源分支已前进时跳过发布。');
    return;
  }
  await publish(opts);
}

if (require.main === module) main().catch(error => { console.error(`市场发布失败：${error.message}`); process.exitCode = 1; });
module.exports = { main, options, publish, validateSource };
