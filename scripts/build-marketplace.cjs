#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { createRequire, isBuiltin } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PLUGIN = path.join(ROOT, 'plugins/markdown-preview');
const DEFAULT_OUTPUT = path.join(ROOT, 'dist/marketplace');
const MARKER = '.markdown-preview-marketplace-build.json';
const BUILDER = 'markdown-preview-marketplace-builder';
const FORMAT = 1;
const EXCLUDED = new Set([
  '.git', '.github', '.DS_Store', 'node_modules', 'tests', 'test', '__tests__',
  'coverage', 'playwright-report', 'test-results', '.nyc_output'
]);
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function usage() {
  return `Markdown Preview 自包含插件市场\n\n用法：node scripts/build-marketplace.cjs [选项]\n  --output <目录>        输出目录，默认为 ./dist/marketplace\n  --version <版本>       覆盖插件版本，默认包含内容摘要\n  --source-commit <SHA>   已核对的源码提交，用于分发来源记录\n  --help                 显示用法\n`;
}

function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') return { help: true };
    if (!['--output', '--version', '--source-commit'].includes(arg)) throw new Error(`未知参数：${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数。`);
    if (arg === '--output') options.output = path.resolve(value);
    else if (arg === '--version') options.version = validateVersion(value);
    else options.sourceCommit = validateCommit(value);
  }
  return options;
}

function validateCommit(value) {
  if (typeof value !== 'string' || value.trim() !== value || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error('源码提交必须是完整的 Git SHA。');
  }
  return value;
}

function marketplaceReadme(version, sourceCommit) {
  const source = `https://github.com/Maker-Wen/markdown-preview/tree/${sourceCommit || 'main'}`;
  return `# Markdown Preview 插件市场

这是 Markdown Preview 的预构建 Codex 分发分支，提供目录导航、代码高亮、KaTeX 公式、Mermaid 图表、本地图片和源码视图。

## 安装

需要 Node.js 22.12.0 或更新版本（\`node\` 在 PATH 中）、Git，以及支持 \`plugin\` 命令的 Codex CLI。运行依赖已随市场分发，安装时无需 npm。

\`\`\`sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
\`\`\`

打开新的 Codex 聊天，在 Markdown 文件的查看器菜单中选择 **Open in ChatGPT → Markdown Preview**。查看器选择及偏好保存由 Codex 宿主管理。

## 更新

\`\`\`sh
codex plugin marketplace upgrade markdown-preview-marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
\`\`\`

更新后打开新的聊天。市场版本包含插件内容摘要，避免不同内容共用同一个插件缓存。

## 已有安装

如果曾通过远程脚本或源码安装同名市场，先用 \`codex plugin marketplace list --json\` 记录旧市场的绝对路径，再移除该市场配置并按上面的命令添加 Git 市场：

\`\`\`sh
codex plugin marketplace remove markdown-preview-marketplace
\`\`\`

移除配置保留原本的本地市场目录。若迁移失败，可移除 Git 市场配置，再用 \`codex plugin marketplace add <旧市场绝对路径>\` 和 \`plugin add\` 恢复原渠道。\`markdown-preview@personal\` 属于另一市场；如同时安装，可在插件页禁用旧入口。

## 分发信息

版本：\`${version}\`。${sourceCommit ? `源码提交：\`${sourceCommit}\`。` : ''}

[源码与开发文档](${source})。本分支携带预览所需的生产依赖及上游包附带的许可证材料；维护源码位于源码分支。
`;
}

function validateVersion(value) {
  const version = String(value).replace(/^v/, '');
  const identifier = '(?:0|[1-9]\\d*)';
  const prerelease = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
  const pattern = new RegExp(`^${identifier}\\.${identifier}\\.${identifier}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  if (version.trim() !== version || !pattern.test(version)) throw new Error(`版本号不是有效的 SemVer：${value}`);
  return version;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function packageName(specifier) {
  if (typeof specifier !== 'string' || !specifier || specifier.startsWith('.') || path.isAbsolute(specifier)) {
    throw new Error(`不是可打包的依赖名称：${specifier}`);
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Use Node's ordered package search directories, rather than flattening the graph.
// package.json may be hidden by "exports", or a dependency may expose no root entry.
async function resolvePackage(specifier, from) {
  const name = packageName(specifier);
  const resolver = createRequire(path.join(from, 'package.json'));
  for (const search of resolver.resolve.paths(name) || []) {
    if (!inside(SOURCE_PLUGIN, search)) continue;
    const directory = path.join(search, name);
    const metadataPath = path.join(directory, 'package.json');
    if (!(await exists(metadataPath))) continue;
    const metadata = await readJson(metadataPath);
    if (metadata.name !== name) throw new Error(`依赖名称不匹配：${metadataPath}`);
    const real = await fs.realpath(directory);
    if (real !== directory || !inside(SOURCE_PLUGIN, real)) {
      throw new Error(`依赖目录必须位于插件源码内且不能是符号链接：${directory}`);
    }
    return { directory, metadata };
  }
  throw new Error(`缺少生产依赖 ${name}（从 ${from} 解析）。请先安装源码的两层锁定依赖。`);
}

function staticRequires(source) {
  const found = new Set();
  // Crossnote publishes an esbuild-generated CommonJS entry. Its literal require
  // calls are the preview dependency roots; lazy export-only imports are excluded.
  for (const match of source.matchAll(/\brequire\s*\(\s*(['"])([^'"\\]+)\1\s*\)/g)) {
    const specifier = match[2];
    if (!isBuiltin(specifier) && !specifier.startsWith('.') && !path.isAbsolute(specifier)) found.add(specifier);
  }
  if (!found.size) throw new Error('Crossnote 入口没有发现静态依赖；需重新检查上游打包格式。');
  return [...found].sort();
}

function rejectPlatformPackage(pkg) {
  for (const key of ['os', 'cpu', 'libc']) {
    if (pkg.metadata[key] !== undefined) {
      throw new Error(`生产依赖 ${pkg.metadata.name} 包含平台约束 ${key}，不能进入跨平台市场包。`);
    }
  }
}

async function collectPackages() {
  const packages = new Map();
  const pending = [];
  async function add(specifier, from, full = true) {
    const pkg = await resolvePackage(specifier, from);
    rejectPlatformPackage(pkg);
    if (!packages.has(pkg.directory)) {
      packages.set(pkg.directory, pkg);
      if (full) pending.push(pkg);
    }
    return pkg;
  }

  const pluginMetadata = await readJson(path.join(SOURCE_PLUGIN, 'package.json'));
  for (const name of Object.keys(pluginMetadata.dependencies || {}).sort()) await add(name, SOURCE_PLUGIN);

  const renderer = path.join(SOURCE_PLUGIN, 'runtime/renderer');
  const crossnote = await add('crossnote', renderer, false);
  const entry = createRequire(path.join(renderer, 'package.json')).resolve('crossnote');
  if (!inside(crossnote.directory, entry)) throw new Error('Crossnote 入口不在其包目录中。');
  const previewRoots = staticRequires(await fs.readFile(entry, 'utf8'));
  const resolver = createRequire(entry);
  for (const specifier of previewRoots) {
    // Validate subpath exports too; copying a package with a missing entry is insufficient.
    try { resolver.resolve(specifier); }
    catch (error) { throw new Error(`Crossnote 静态依赖无法解析：${specifier}（${error.message}）`); }
    await add(specifier, crossnote.directory);
  }

  for (let index = 0; index < pending.length; index += 1) {
    const pkg = pending[index];
    const required = { ...pkg.metadata.dependencies, ...pkg.metadata.optionalDependencies };
    for (const name of Object.keys(pkg.metadata.peerDependencies || {})) {
      if (!pkg.metadata.peerDependenciesMeta?.[name]?.optional) required[name] = pkg.metadata.peerDependencies[name];
    }
    for (const name of Object.keys(required).sort()) await add(name, pkg.directory);
  }
  const locks = [
    { root: SOURCE_PLUGIN, file: path.join(SOURCE_PLUGIN, 'package-lock.json') },
    { root: renderer, file: path.join(renderer, 'package-lock.json') }
  ];
  for (const lock of locks) lock.metadata = await readJson(lock.file);
  for (const pkg of packages.values()) {
    const lock = inside(renderer, pkg.directory) ? locks[1] : locks[0];
    const relative = path.relative(lock.root, pkg.directory).split(path.sep).join('/');
    const locked = lock.metadata.packages?.[relative];
    if (!locked || locked.version !== pkg.metadata.version) {
      throw new Error(`生产依赖 ${pkg.metadata.name}@${pkg.metadata.version} 与锁文件不一致：${lock.file}`);
    }
  }
  return { packages: [...packages.values()].sort((a, b) => a.directory.localeCompare(b.directory)), previewRoots, locks };
}

function shouldCopy(name, dependency) {
  if (EXCLUDED.has(name)) return false;
  if (!dependency && (/^test-.*\.cjs$/.test(name) || name === 'package-lock.json')) return false;
  return true;
}

async function copyTree(source, destination, stats, dependency = false) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of (await fs.readdir(source, { withFileTypes: true })).sort(byName)) {
    if (!shouldCopy(entry.name, dependency)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`分发包不能包含符号链接：${from}`);
    if (entry.isDirectory()) await copyTree(from, to, stats, dependency);
    else if (entry.isFile()) {
      if (/\.node$/i.test(entry.name)) throw new Error(`分发包不能包含原生模块：${from}`);
      const stat = await fs.stat(from);
      await fs.copyFile(from, to);
      await fs.chmod(to, stat.mode & 0o777);
      stats.files += 1;
      stats.bytes += stat.size;
    } else throw new Error(`分发包包含不支持的文件类型：${from}`);
  }
}

async function assertManaged(output) {
  if (!(await exists(output))) return false;
  const stat = await fs.lstat(output);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`输出路径不是普通目录：${output}`);
  let marker;
  try {
    const markerPath = path.join(output, MARKER);
    const markerStat = await fs.lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('invalid marker');
    marker = await readJson(markerPath);
  } catch { throw new Error(`输出目录不由本构建器管理，拒绝覆盖：${output}`); }
  if (marker.builder !== BUILDER || marker.format !== FORMAT || marker.root !== output) {
    throw new Error(`输出目录的构建标记不匹配，拒绝覆盖：${output}`);
  }
  return true;
}

async function validateOutput(output) {
  if (inside(SOURCE_PLUGIN, output) || inside(output, SOURCE_PLUGIN) || inside(output, ROOT)) {
    throw new Error(`输出目录不能覆盖仓库或插件源码：${output}`);
  }
  // Resolve existing ancestors so an indirect symlink cannot bypass the source guard.
  let ancestor = output;
  while (!(await exists(ancestor))) ancestor = path.dirname(ancestor);
  const realAncestor = await fs.realpath(ancestor);
  const effective = path.resolve(realAncestor, path.relative(ancestor, output));
  const temporary = path.resolve(os.tmpdir());
  const realTemporary = await fs.realpath(temporary);
  // macOS exposes the system temp directory through /var -> /private/var.
  // Permit that OS-owned alias, while rejecting additional links beneath it.
  const systemTempAlias = inside(temporary, output)
    && effective === path.resolve(realTemporary, path.relative(temporary, output));
  if (effective !== output && !systemTempAlias) throw new Error(`输出路径不能经过符号链接：${output}`);
  if (inside(SOURCE_PLUGIN, effective) || inside(effective, SOURCE_PLUGIN) || inside(effective, ROOT)) {
    throw new Error(`输出目录不能覆盖仓库或插件源码：${output}`);
  }
  return assertManaged(output);
}

async function hashTree(root, hash, prefix = '') {
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort(byName)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await hashTree(file, hash, relative);
    else {
      const bytes = await fs.readFile(file);
      hash.update(`${relative}\0${bytes.length}\0`).update(bytes).update('\0');
    }
  }
}

async function measureTree(root) {
  const total = { files: 0, bytes: 0 };
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await measureTree(file);
      total.files += nested.files;
      total.bytes += nested.bytes;
    } else {
      total.files += 1;
      total.bytes += (await fs.stat(file)).size;
    }
  }
  return total;
}

async function build({ output = DEFAULT_OUTPUT, version, sourceCommit } = {}) {
  if (sourceCommit !== undefined) sourceCommit = validateCommit(sourceCommit);
  output = path.resolve(output);
  await validateOutput(output);
  const manifest = await readJson(path.join(SOURCE_PLUGIN, 'plugin.json'));
  const overlay = await readJson(path.join(SOURCE_PLUGIN, '.codex-plugin/plugin.json'));
  const sourceVersion = validateVersion(manifest.version);
  const baseVersion = sourceVersion.split('+')[0];
  const requestedVersion = version === undefined ? undefined : validateVersion(version);
  const catalog = await readJson(path.join(ROOT, '.agents/plugins/marketplace.json'));
  const { packages, previewRoots, locks } = await collectPackages();
  const parent = path.dirname(output);
  await fs.mkdir(parent, { recursive: true });
  const work = await fs.mkdtemp(path.join(parent, '.markdown-preview-marketplace-build-'));
  const staging = path.join(work, 'marketplace');
  const plugin = path.join(staging, 'plugins/markdown-preview');
  const stats = { packages: packages.length, files: 0, bytes: 0, previewRoots };
  let backup;
  let activated = false;
  try {
    await copyTree(SOURCE_PLUGIN, plugin, stats);
    for (const pkg of packages) {
      await copyTree(pkg.directory, path.join(plugin, path.relative(SOURCE_PLUGIN, pkg.directory)), stats, true);
    }
    // Normalize versions before hashing, so the generated suffix cannot feed back
    // into the digest. Paths, timestamps, and output directories never enter it.
    await writeJson(path.join(plugin, 'plugin.json'), { ...manifest, version: baseVersion });
    await writeJson(path.join(plugin, '.codex-plugin/plugin.json'), { ...overlay, version: baseVersion });
    for (const file of ['package.json', 'runtime/renderer/package.json']) {
      const metadata = await readJson(path.join(plugin, file));
      delete metadata.devDependencies;
      delete metadata.scripts;
      await writeJson(path.join(plugin, file), { ...metadata, version: baseVersion });
    }
    // The installed plugin is a distribution, so source-only relative documentation
    // and installer paths would be broken here. Give both roots the market guide.
    await fs.writeFile(path.join(plugin, 'README.md'), marketplaceReadme(baseVersion, sourceCommit));
    await writeJson(path.join(staging, '.agents/plugins/marketplace.json'), catalog);
    const hash = crypto.createHash('sha256');
    await hashTree(plugin, hash);
    for (const lock of locks) {
      const relative = path.relative(SOURCE_PLUGIN, lock.file).split(path.sep).join('/');
      const bytes = await fs.readFile(lock.file);
      hash.update(`source-lock/${relative}\0${bytes.length}\0`).update(bytes).update('\0');
    }
    const contentHash = hash.digest('hex');
    version = requestedVersion || `${baseVersion}+marketplace.${contentHash.slice(0, 16)}`;
    for (const file of ['plugin.json', '.codex-plugin/plugin.json', 'package.json', 'runtime/renderer/package.json']) {
      await writeJson(path.join(plugin, file), { ...await readJson(path.join(plugin, file)), version });
    }
    await fs.writeFile(path.join(plugin, 'README.md'), marketplaceReadme(version, sourceCommit));
    await fs.writeFile(path.join(staging, 'README.md'), marketplaceReadme(version, sourceCommit));
    await writeJson(path.join(staging, MARKER), { builder: BUILDER, format: FORMAT, root: output, sourceVersion, baseVersion, contentHash, version, ...(sourceCommit ? { sourceCommit } : {}) });
    Object.assign(stats, await measureTree(staging));
    // Recheck immediately before replacing: never delete a directory whose marker changed.
    if (await assertManaged(output)) {
      backup = path.join(work, 'previous-marketplace');
      await fs.rename(output, backup);
    }
    try { await fs.rename(staging, output); activated = true; }
    catch (error) {
      if (backup) { await fs.rename(backup, output); backup = undefined; }
      throw error;
    }
    return { root: output, plugin: path.join(output, 'plugins/markdown-preview'), version, contentHash, stats };
  } finally {
    // A failed restore must retain the backup as the only recoverable old build.
    if (!backup || activated) await fs.rm(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(usage()); return; }
    const result = await build(options);
    console.log(`自包含市场已生成：${result.root}\n版本：${result.version}\n生产包：${result.stats.packages}\n文件：${result.stats.files}\n产物大小：${(result.stats.bytes / 1024 / 1024).toFixed(2)} MiB`);
  };
  main().catch(error => { console.error(`市场构建失败：${error.message}`); process.exitCode = 1; });
}

module.exports = { build, parseArgs, staticRequires, MARKER, BUILDER, DEFAULT_OUTPUT };
