#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PLUGIN = 'markdown-preview';
const MARKET = 'markdown-preview-marketplace';
const SELECTOR = `${PLUGIN}@${MARKET}`;
const MARKER = '.markdown-preview-install.json';
const ROOT = path.resolve(__dirname, '..');

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '--dry-run') result[key.slice(2)] = true;
    else if (['--source', '--repo', '--ref', '--install-dir', '--codex'].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${key} 缺少参数。`);
      result[key.slice(2)] = argv[++i];
    } else throw new Error(`未知参数：${key}`);
  }
  if (result.source && result.repo) throw new Error('--source 与 --repo 不能同时使用。');
  if (result.ref && !result.repo) throw new Error('--ref 需要同时提供 --repo。');
  if (result.ref?.startsWith('-') || result.repo?.startsWith('-')) throw new Error('Git 来源或引用不能以 - 开头。');
  if (result['install-dir'] && !path.isAbsolute(result['install-dir'])) throw new Error('--install-dir 必须是绝对路径。');
  return result;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function executable(name) {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const dirs = name.includes('/') || name.includes('\\') ? [''] : (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(dir, name + suffix);
      try {
        const stat = await fs.stat(candidate);
        await fs.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if (stat.isFile()) return candidate;
      } catch { /* Try the next executable. */ }
    }
  }
  return null;
}

async function nodeCli(command, packagePath) {
  if (!command) return null;
  const real = await fs.realpath(command);
  const candidates = [
    /\.(c?js|mjs)$/.test(real) ? real : null,
    path.join(path.dirname(command), 'node_modules', packagePath),
    path.resolve(path.dirname(real), '../lib/node_modules', packagePath),
    path.join(path.dirname(process.execPath), 'node_modules', packagePath)
  ];
  for (const candidate of candidates) if (candidate && await exists(candidate)) return candidate;
  return null;
}

async function commands(opts) {
  let codex = await executable(opts.codex || 'codex');
  if (!codex && !opts.codex && process.platform === 'darwin') {
    for (const app of ['ChatGPT', 'Codex']) {
      for (const relative of ['codex-cli/CodexCLI.app/Contents/MacOS/codex', 'codex']) {
        codex = await executable(`/Applications/${app}.app/Contents/Resources/${relative}`);
        if (codex) break;
      }
      if (codex) break;
    }
  }
  if (!codex) throw new Error('找不到 Codex CLI。请安装或更新 Codex，或用 --codex 指定可执行文件。');
  let codexCommand = [codex];
  if (/\.(cmd|bat)$/i.test(codex)) {
    const cli = await nodeCli(codex, '@openai/codex/bin/codex.js');
    if (!cli) throw new Error('无法解析 Codex 的 Windows 启动脚本，请用 --codex 指定 codex.exe。');
    codexCommand = [process.execPath, cli];
  }
  const npm = await nodeCli(await executable('npm'), 'npm/bin/npm-cli.js');
  if (!npm) throw new Error('找不到 npm CLI。请安装包含 npm 的 Node.js，然后重试。');
  const git = opts.repo ? await executable('git') : null;
  if (opts.repo && !git) throw new Error('从远程仓库安装需要 Git。');
  return { codex: codexCommand, npm: [process.execPath, npm], git: git && [git] };
}

function run(command, args, config = {}) {
  const { json = false, ...rest } = config;
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    stdio: json ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', ...rest
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (json && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${path.basename(command[0])} ${args.slice(0, 3).join(' ')} 执行失败（${result.status ?? result.signal}）。`);
  }
  if (json) {
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('Codex 返回了无法识别的 JSON，请更新 Codex 后重试。'); }
  }
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
async function resolvedDirectory(directory) {
  try { return await fs.realpath(directory); } catch { return path.resolve(directory); }
}

async function validateSource(source) {
  const catalog = await readJson(path.join(source, '.agents/plugins/marketplace.json'));
  const entry = catalog.plugins?.find(item => item.name === PLUGIN);
  if (catalog.name !== MARKET || entry?.source?.path !== `./plugins/${PLUGIN}` || entry.source.source !== 'local') {
    throw new Error('来源目录不是受支持的 Markdown Preview 市场仓库。');
  }
  const plugin = path.join(source, 'plugins', PLUGIN);
  const manifest = await readJson(path.join(plugin, 'plugin.json'));
  const overlay = await readJson(path.join(plugin, '.codex-plugin/plugin.json'));
  if (manifest.name !== PLUGIN || overlay.name !== PLUGIN || manifest.version !== overlay.version ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(manifest.version)) {
    throw new Error('插件标识或两份清单的版本不一致。');
  }
  return { catalog, plugin, manifest, overlay };
}

async function copyPlugin(source, target, hash, relative = '') {
  await fs.mkdir(target, { recursive: true });
  const entries = (await fs.readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (['node_modules', '.git', 'tests', '.DS_Store'].includes(entry.name) || /^test-.*\.cjs$/.test(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    const name = relative + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`发布源码不能包含符号链接：${name}`);
    if (entry.isDirectory()) await copyPlugin(from, to, hash, name + '/');
    else if (entry.isFile()) {
      const data = await fs.readFile(from);
      hash.update(name + '\0').update(data).update('\0');
      await fs.writeFile(to, data);
    } else throw new Error(`发布源码包含不支持的文件：${name}`);
  }
}

async function smoke(plugin) {
  // Run against production dependencies without loading the developer checkout.
  const program = `
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Client } = require('./node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StdioClientTransport } = require('./node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');
(async () => {
 const client = new Client({name:'markdown-preview-installer',version:'1.0.0'});
 const transport = new StdioClientTransport({command:process.execPath,args:['--no-global-search-paths',path.resolve('scripts/server.cjs')],stderr:'pipe'});
 transport.stderr?.on('data', () => {});
 try {
  await client.connect(transport);
  const tool = (await client.listTools()).tools.find(t => t.name === 'markdown_preview_open');
  assert.deepEqual(tool._meta['openai/ui'].entrypoints,[{type:'file',extensions:['.md','.markdown']}]);
  const ui = await client.readResource({uri:tool._meta.ui.resourceUri});
  assert.equal(ui.contents[0].mimeType,'text/html;profile=mcp-app');
  assert.match(ui.contents[0].text,/Markdown Preview/);
  const file = path.resolve('README.md');
  const result = await client.callTool({name:tool.name,arguments:{file:{name:'README.md',resourceUri:'codex-resource://installation-check'}},_meta:{'openai/resource':{path:file}}});
  assert.notEqual(result.isError,true);
  assert.equal(result.structuredContent.text,await fs.readFile(file,'utf8'));
  assert.ok(result.structuredContent.html.length > 0);
 } finally { await client.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });`;
  run([process.execPath], ['--no-global-search-paths', '-e', program], { cwd: plugin, timeout: 120000 });
}

async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (opts.help) {
    console.log(`Markdown Preview 安装器\n\n用法：node scripts/install.cjs [选项]\n  --source <目录>       本地仓库，默认为安装器所在仓库\n  --repo <Git URL>      从远程仓库下载源码\n  --ref <分支或标签>    指定远程版本，默认使用仓库默认分支\n  --install-dir <路径>  安装市场的绝对路径\n  --codex <路径>        指定 Codex CLI\n  --dry-run            只显示计划，不下载或安装\n  --help               显示帮助\n\n需要 Node.js >=20.3、npm、Codex CLI；远程来源另需 Git。\n重跑同一命令可更新。安装完成后从文件打开菜单选择 Markdown Preview。`);
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 3)) throw new Error('需要 Node.js 20.3 或更新版本。');
  const destination = path.resolve(opts['install-dir'] || path.join(os.homedir(), '.local/share/markdown-preview/marketplace'));
  const source = path.resolve(opts.source || ROOT);
  const cmd = await commands(opts);
  if (!opts.repo) await validateSource(source);
  if (await exists(destination)) {
    let marker;
    try { marker = await readJson(path.join(destination, MARKER)); } catch { /* Unmanaged directory. */ }
    if (marker?.installer !== PLUGIN || marker.format !== 1) throw new Error(`目标目录不是本安装器管理的目录，不会覆盖：${destination}`);
  }
  console.log(`安装位置：${destination}\n插件市场：${MARKET}\nNode.js：${process.execPath}`);
  if (opts['dry-run']) {
    console.log('计划：检查 Codex → 准备独立源码 → 安装生产依赖 → 验证 MCP → 注册市场 → 安装插件。\n未下载或修改任何文件。');
    return;
  }
  const markets = run(cmd.codex, ['plugin', 'marketplace', 'list', '--json'], { json: true });
  const previousMarket = markets.marketplaces?.find(item => item.name === MARKET);
  if (previousMarket && await resolvedDirectory(previousMarket.root) !== await resolvedDirectory(destination)) {
    throw new Error(`同名市场已指向 ${previousMarket.root}。请使用该安装位置，或先自行处理市场名称冲突。`);
  }
  const installed = run(cmd.codex, ['plugin', 'list', '--json'], { json: true });
  const other = (installed.installed || []).filter(item => item.name === PLUGIN && item.marketplaceName !== MARKET && item.installed && item.enabled);
  for (const item of other) console.warn(`提示：${item.pluginId || item.name} 仍已启用。安装后可在插件页禁用旧入口，避免重复显示。`);
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  const lock = path.join(parent, '.markdown-preview-install.lock');
  try { await fs.mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有安装任务或遗留锁：${lock}。确认没有安装任务后可删除该锁目录重试。`);
    throw error;
  }
  let work, backup, activated = false, registered = false, backupPendingRestore = false, complete = false;
  try {
    work = await fs.mkdtemp(path.join(parent, '.markdown-preview-staging-'));
    let input = source;
    if (opts.repo) {
      console.log('正在下载插件源码…');
      input = path.join(work, 'checkout');
      run(cmd.git, ['clone', '--depth', '1', ...(opts.ref ? ['--branch', opts.ref] : []), '--', opts.repo, input]);
    }
    const data = await validateSource(input);
    const prepared = path.join(work, 'marketplace');
    const plugin = path.join(prepared, 'plugins', PLUGIN);
    const hash = crypto.createHash('sha256').update(process.execPath + '\0' + process.platform + '\0' + process.arch + '\0');
    hash.update(await fs.readFile(__filename));
    await copyPlugin(data.plugin, plugin, hash);
    const version = `${data.manifest.version.split('+')[0]}+codex.${hash.digest('hex').slice(0, 16)}`;
    await writeJson(path.join(plugin, 'plugin.json'), { ...data.manifest, version });
    await writeJson(path.join(plugin, '.codex-plugin/plugin.json'), { ...data.overlay, version });
    const mcp = await readJson(path.join(plugin, 'mcp.json'));
    mcp.mcpServers.markdown_preview.command = process.execPath;
    await writeJson(path.join(plugin, 'mcp.json'), mcp);
    await fs.mkdir(path.join(prepared, '.agents/plugins'), { recursive: true });
    await writeJson(path.join(prepared, '.agents/plugins/marketplace.json'), data.catalog);
    await writeJson(path.join(prepared, MARKER), { installer: PLUGIN, format: 1, version, node: process.execPath });
    console.log('正在安装运行依赖，首次安装需要下载…');
    for (const cwd of [plugin, path.join(plugin, 'runtime/renderer')]) {
      run(cmd.npm, ['ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd });
    }
    console.log('正在验证插件注册、界面资源与 Markdown 渲染…');
    await smoke(plugin);
    if (await exists(destination)) {
      backup = path.join(work, 'previous-marketplace');
      await fs.rename(destination, backup);
      backupPendingRestore = true;
    }
    await fs.rename(prepared, destination);
    activated = true;
    console.log('正在注册市场并安装插件…');
    if (!previousMarket) run(cmd.codex, ['plugin', 'marketplace', 'add', destination, '--json'], { json: true });
    registered = true;
    run(cmd.codex, ['plugin', 'add', SELECTOR, '--json'], { json: true });
    const checked = run(cmd.codex, ['plugin', 'list', '--marketplace', MARKET, '--json'], { json: true });
    const entry = checked.installed?.find(item => item.name === PLUGIN && item.marketplaceName === MARKET && item.installed && item.enabled);
    if (!entry || entry.version !== version) throw new Error('安装后的插件版本或启用状态不符合预期，请查看 Codex 插件页。');
    complete = true;
    console.log(`安装完成：${SELECTOR}\n版本：${version}\n安装前的独立 MCP 注册、资源加载和渲染自检已通过。\n请打开新的 Codex 对话加载插件；必要时重启 Codex，然后在文件打开菜单中选择 Markdown Preview。\n普通 Markdown 点击仍由 Codex 的默认查看器规则决定。`);
  } catch (error) {
    if (backupPendingRestore) {
      if (activated) await fs.rm(destination, { recursive: true, force: true });
      await fs.rename(backup, destination);
      backupPendingRestore = false;
      console.error('已恢复之前的本地市场目录。Codex 配置与缓存可能已更新，请重跑安装器核对状态。');
    } else if (activated && !registered) {
      // Retain the prepared directory: marketplace/add may have written configuration before failing.
      console.error(`已保留准备好的文件：${destination}。可重跑安装器继续。`);
    } else if (registered) console.error(`市场已注册，插件安装尚未验证成功。已保留 ${destination}，可重试。`);
    throw error;
  } finally {
    if (backupPendingRestore && !complete) console.error(`自动恢复未完成，旧版本备份已保留：${backup}`);
    else if (work) await fs.rm(work, { recursive: true, force: true }).catch(error => {
      console.warn(`临时目录清理失败，已保留 ${work}：${error.message}`);
    });
    await fs.rm(lock, { recursive: true, force: true }).catch(error => {
      console.warn(`安装锁清理失败，请确认任务结束后删除 ${lock}：${error.message}`);
    });
  }
}

if (require.main === module) main().catch(error => { console.error(`安装失败：${error.message}`); process.exitCode = 1; });
module.exports = { main };
