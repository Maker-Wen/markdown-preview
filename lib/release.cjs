'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_REPOSITORY = 'Maker-Wen/markdown-preview';
const VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ALLOWED_HOSTS = new Set([
  'api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function usage() {
  return `Markdown Preview 安装器

用法：npx --yes github:Maker-Wen/markdown-preview [选项]
发布 npm 包后：npx --yes @maker-wen/markdown-preview-installer@latest [选项]
  --version <版本>     Release 标签，默认 latest（最新正式版）
  --repository <仓库>  GitHub owner/repository，默认 ${DEFAULT_REPOSITORY}
  --install-dir <路径> 安装市场的绝对路径
  --codex <路径>       指定 Codex CLI
  --dry-run            下载、校验并显示安装计划，不安装插件
  --help               显示帮助，不联网

也可设置 MARKDOWN_PREVIEW_VERSION 和 MARKDOWN_PREVIEW_REPOSITORY。
需要 Node.js >=22.12.0、npm 和 Codex CLI。重跑同一命令可更新。
安装器下载同一版本的 Release 和 SHA256SUMS，校验后运行包内安装器。`;
}

function validateRepository(repository) {
  if (typeof repository !== 'string' || repository.trim() !== repository ||
      !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository) ||
      repository.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('GitHub 仓库必须是 owner/repository。');
  }
  return repository;
}

function normalizeVersion(version) {
  if (version === 'latest') return version;
  if (typeof version !== 'string' || version.trim() !== version) throw new Error('版本必须是 latest、vX.Y.Z 或 X.Y.Z。');
  const result = version.startsWith('v') ? version : `v${version}`;
  if (!VERSION_PATTERN.test(result)) throw new Error('版本必须是 latest、vX.Y.Z 或 X.Y.Z。');
  return result;
}

function parseOptions(argv, env = process.env) {
  const options = {
    version: env.MARKDOWN_PREVIEW_VERSION || 'latest',
    repository: env.MARKDOWN_PREVIEW_REPOSITORY || DEFAULT_REPOSITORY,
    forwarded: [], help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') { options.help = true; continue; }
    if (arg === '--dry-run') { options.forwarded.push(arg); continue; }
    if (!['--version', '--repository', '--install-dir', '--codex'].includes(arg)) {
      throw new Error(`未知参数：${arg}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数。`);
    if (arg === '--version') options.version = value;
    else if (arg === '--repository') options.repository = value;
    else {
      if (arg === '--install-dir' && !path.isAbsolute(value)) throw new Error('--install-dir 必须是绝对路径。');
      options.forwarded.push(arg, value);
    }
  }
  if (!options.help) {
    options.repository = validateRepository(options.repository);
    options.version = normalizeVersion(options.version);
  }
  return options;
}

function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('需要 Node.js 22.12.0 或更新版本。');
}

function allowedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error('下载地址必须是受支持的 GitHub HTTPS 地址。');
  }
  return url;
}

async function request(url, fetcher) {
  let current = allowedUrl(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(current.href, {
      redirect: 'manual', signal: AbortSignal.timeout(120000),
      headers: { 'User-Agent': 'markdown-preview-installer', Accept: 'application/vnd.github+json' }
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('GitHub 重定向缺少目标地址。');
      current = allowedUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub 下载失败（HTTP ${response.status}）。请检查网络或 Release 是否存在。`);
    }
    return response;
  }
  throw new Error('GitHub 下载重定向次数过多。');
}

async function resolveRelease(repository, version, fetcher) {
  if (version !== 'latest') return normalizeVersion(version);
  const response = await request(`https://api.github.com/repos/${repository}/releases/latest`, fetcher);
  let release;
  try { release = await response.json(); }
  catch { throw new Error('最新正式版返回了无法识别的 Release 信息。'); }
  if (!release || typeof release !== 'object' || release.draft !== false || release.prerelease !== false ||
      typeof release.tag_name !== 'string' || release.tag_name.trim() !== release.tag_name ||
      !VERSION_PATTERN.test(release.tag_name)) {
    throw new Error('最新正式版没有返回受支持的正式 Release 标签。');
  }
  return release.tag_name;
}

async function downloadToFile(url, file, fetcher) {
  const response = await request(url, fetcher);
  if (!response.body) throw new Error('Release 资产没有下载内容。');
  const output = await fs.open(file, 'wx');
  const hash = crypto.createHash('sha256');
  try {
    for await (const chunk of response.body) {
      const data = Buffer.from(chunk);
      hash.update(data);
      // FileHandle.write can make partial progress; writeFile handles each whole chunk.
      await output.writeFile(data);
    }
  } finally {
    await output.close();
  }
  return hash.digest('hex');
}

function checksumFor(text, archiveName) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = /^(\S+)\s+\*?(.+)$/.exec(line);
    if (entry?.[2] === archiveName) entries.push(entry[1]);
  }
  if (entries.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(entries[0])) {
    throw new Error(`SHA256SUMS 必须包含唯一且有效的 ${archiveName} 校验值。`);
  }
  return entries[0].toLowerCase();
}

function validateEntryPath(entryPath, rootName) {
  if (typeof entryPath !== 'string' || entryPath.includes('\\') || entryPath.startsWith('/') ||
      /[\u0000-\u001f<>:"|?*]/.test(entryPath)) {
    throw new Error(`Release 资产包含不安全的归档路径：${entryPath}`);
  }
  const name = entryPath.endsWith('/') ? entryPath.slice(0, -1) : entryPath;
  const parts = name.split('/');
  if (parts[0] !== rootName || parts.some(part => !part || part === '.' || part === '..' ||
      /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i.test(part))) {
    throw new Error(`Release 资产包含不安全的归档路径：${entryPath}`);
  }
  return name;
}

async function extractArchive(archiveFile, destination, rootName) {
  const tar = require('tar');
  try {
    if ((await fs.readdir(destination)).length) throw new Error('解压目标目录必须为空。');
    const stat = await fs.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('解压目标必须是普通目录。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(destination);
  }
  const paths = new Map();
  let unsafe;
  await tar.t({
    file: archiveFile, strict: true, preservePaths: true,
    onReadEntry(entry) {
      try {
        // Older macOS-created releases contain AppleDouble metadata beside the
        // archive root. Validate its exact name and type, then never write it.
        const rootMetadata = entry.path === `._${rootName}`;
        const name = rootMetadata ? entry.path : validateEntryPath(entry.path, rootName);
        if (!['File', 'Directory'].includes(entry.type) || (name === rootName && entry.type !== 'Directory')) {
          throw new Error(`Release 资产包含不支持的归档类型：${entry.type}`);
        }
        if (rootMetadata && entry.type !== 'File') throw new Error('Release 根目录的 AppleDouble 元数据必须是普通文件。');
        const key = name.normalize('NFC').toLowerCase();
        if (paths.has(key)) throw new Error(`Release 资产包含重复或冲突的归档路径：${name}`);
        const skip = rootMetadata || (entry.type === 'File' && path.posix.basename(name).startsWith('._'));
        paths.set(key, { name, type: entry.type, skip });
      } catch (error) { unsafe ||= error; }
    }
  });
  if (unsafe) throw unsafe;
  if (!paths.size) throw new Error('Release 资产是空归档。');
  await tar.x({
    file: archiveFile, cwd: destination, strict: true, preservePaths: false,
    noChmod: true, noMtime: true, preserveOwner: false,
    filter(entryPath, entry) {
      try {
        const name = entryPath === `._${rootName}` ? entryPath : validateEntryPath(entryPath, rootName);
        const checked = paths.get(name.normalize('NFC').toLowerCase());
        if (!checked || checked.name !== name || checked.type !== entry.type) throw new Error('Release 资产在解压时出现未验证的成员。');
        return !checked.skip;
      } catch (error) { unsafe ||= error; return false; }
    }
  });
  if (unsafe) throw unsafe;
}

async function runPackagedInstaller(root, forwarded, execute) {
  const installer = path.join(root, 'scripts/install.cjs');
  let stat;
  try { stat = await fs.lstat(installer); }
  catch { throw new Error('Release 资产缺少 scripts/install.cjs。'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Release 资产中的安装器不是普通文件。');
  const result = await execute(process.execPath, [installer, '--source', root, ...forwarded], { stdio: 'inherit' });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const error = new Error(`包内安装器执行失败（${result?.status ?? result?.signal ?? '未知状态'}）。`);
    error.exitCode = Number.isInteger(result?.status) && result.status > 0 ? result.status : (result?.signal === 'SIGINT' ? 130 : 1);
    throw error;
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env || process.env;
  const opts = parseOptions(argv, env);
  const log = dependencies.log || console.log;
  if (opts.help) { log(usage()); return; }
  assertNodeVersion();
  if (/^(true|1)$/i.test(env.npm_config_offline || env.NPM_CONFIG_OFFLINE || '')) {
    throw new Error('离线模式无法下载 GitHub Release。请联网后重试，或使用已下载的本地安装包。');
  }
  const fetcher = dependencies.fetch || globalThis.fetch;
  const execute = dependencies.execute || spawnSync;
  const tag = await resolveRelease(opts.repository, opts.version, fetcher);
  log(`安装版本：${tag}`);
  const temporary = await fs.mkdtemp(path.join(dependencies.temporaryDirectory || os.tmpdir(), 'markdown-preview-npx-'));
  try {
    const rootName = `markdown-preview-${tag}`;
    const archiveName = `${rootName}.tar.gz`;
    const base = `https://github.com/${opts.repository}/releases/download/${tag}`;
    const archiveFile = path.join(temporary, archiveName);
    const actual = await downloadToFile(`${base}/${archiveName}`, archiveFile, fetcher);
    const checksumFile = path.join(temporary, 'SHA256SUMS');
    await downloadToFile(`${base}/SHA256SUMS`, checksumFile, fetcher);
    const expected = checksumFor(await fs.readFile(checksumFile, 'utf8'), archiveName);
    if (actual !== expected) throw new Error('Release 资产 SHA-256 校验失败。');
    const extracted = path.join(temporary, 'extract');
    await extractArchive(archiveFile, extracted, rootName);
    await runPackagedInstaller(path.join(extracted, rootName), opts.forwarded, execute);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = {
  main, usage, parseOptions, assertNodeVersion, validateRepository, normalizeVersion,
  request, resolveRelease, downloadToFile, checksumFor, validateEntryPath, extractArchive,
  runPackagedInstaller
};
