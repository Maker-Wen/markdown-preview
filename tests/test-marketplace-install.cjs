'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const marketplace = path.resolve(process.env.MARKDOWN_PREVIEW_MARKETPLACE_ROOT || path.join(ROOT, 'dist/marketplace'));
const marketplaceGit = process.env.MARKDOWN_PREVIEW_MARKETPLACE_GIT;
const marketplaceRef = process.env.MARKDOWN_PREVIEW_MARKETPLACE_REF || 'codex/marketplace';
const codex = process.env.MARKDOWN_PREVIEW_TEST_CODEX || 'codex';
const command = /\.[cm]?js$/i.test(codex) ? process.execPath : codex;
const prefix = command === process.execPath ? [codex] : [];
const probe = spawnSync(command, [...prefix, 'plugin', '--help'], { encoding: 'utf8', timeout: 10000 });
const skip = probe.error || probe.status !== 0 || !fsSync.existsSync(path.join(marketplace, '.agents/plugins/marketplace.json'));
const required = process.env.MARKDOWN_PREVIEW_REQUIRE_CODEX === '1' || !!marketplaceGit;

function normalizedGitSource(source) {
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source)) source = `https://github.com/${source}`;
  try {
    const url = new URL(source);
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.search && !url.hash && !url.username && !url.password) {
      return `https://github.com${url.pathname.replace(/\/$/, '').replace(/\.git$/i, '').toLowerCase()}`;
    }
  } catch { /* Non-GitHub sources retain their exact identity. */ }
  return source;
}

test('Codex installs the self-contained marketplace and its final cache serves Markdown', { skip: !!skip && !required }, async t => {
  assert.equal(!!skip, false, 'a compatible Codex CLI and built marketplace are required');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-codex-market-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const testHome = path.join(temporary, 'codex');
  await fs.mkdir(testHome);
  // CODEX_HOME is used for its documented purpose: selecting this isolated
  // Codex configuration, so installation never touches the user's plugins.
  const env = { ...process.env, CODEX_HOME: testHome, NODE_PATH: '' };
  function run(args) {
    const result = spawnSync(command, [...prefix, ...args], { cwd: temporary, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  }
  run(['plugin', 'marketplace', 'add', marketplaceGit || marketplace, ...(marketplaceGit ? ['--ref', marketplaceRef] : []), '--json']);
  run(['plugin', 'add', 'markdown-preview@markdown-preview-marketplace', '--json']);
  const expected = JSON.parse(await fs.readFile(path.join(marketplace, 'plugins/markdown-preview/plugin.json'), 'utf8'));
  function installedCache() {
    const installed = run(['plugin', 'list', '--marketplace', 'markdown-preview-marketplace', '--json']);
    const entry = installed.installed?.find(item => item.name === 'markdown-preview' && item.marketplaceName === 'markdown-preview-marketplace');
    assert.ok(entry?.installed && entry.enabled);
    assert.equal(entry.version, expected.version);
    if (marketplaceGit) {
      assert.equal(entry.marketplaceSource?.sourceType, 'git');
      assert.equal(normalizedGitSource(entry.marketplaceSource.source), normalizedGitSource(marketplaceGit));
    }
    const cache = path.join(testHome, 'plugins/cache/markdown-preview-marketplace/markdown-preview', entry.version);
    assert.ok(fsSync.existsSync(path.join(cache, 'scripts/server.cjs')), 'the installed cache must contain the server');
    return cache;
  }

  // The test client may use development dependencies; the target server is a
  // separate process that resolves everything from its installed cache.
  const { Client } = require('../plugins/markdown-preview/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
  const { StdioClientTransport } = require('../plugins/markdown-preview/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js');
  const file = path.join(temporary, '中文 空格.md');
  const text = '# Installed preview\n\n| Name | Value |\n| --- | --- |\n| Math | $x^2$ |\n\n```mermaid\ngraph TD; A-->B;\n```\n';
  await fs.writeFile(file, text);
  async function verifyCache(cache, phase) {
    const pluginRoot = await fs.realpath(cache);
    const mcp = JSON.parse(await fs.readFile(path.join(pluginRoot, 'mcp.json'), 'utf8'));
    const server = mcp.mcpServers?.markdown_preview;
    assert.equal(server?.command, 'node', 'the portable marketplace must use its declared Node command');
    assert.ok(Array.isArray(server.args), 'the installed MCP configuration must declare its arguments');
    const resolveRoot = value => {
      assert.equal(typeof value, 'string');
      return value.replaceAll('${PLUGIN_ROOT}', pluginRoot);
    };
    const serverEnv = Object.fromEntries(Object.entries(server.env || {}).map(([key, value]) => [key, resolveRoot(value)]));
    const client = new Client({ name: 'markdown-preview-distribution-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: server.command,
      args: ['--no-global-search-paths', ...server.args.map(resolveRoot)],
      cwd: temporary, env: { ...env, ...serverEnv }, stderr: 'pipe'
    });
    let logs = '';
    transport.stderr?.on('data', data => { logs += data; });
    try {
      await client.connect(transport);
      const tool = (await client.listTools()).tools.find(item => item.name === 'markdown_preview_open');
      assert.ok(tool);
      assert.deepEqual(tool._meta['openai/ui'].entrypoints, [{ type: 'file', extensions: ['.md', '.markdown'] }]);
      const ui = await client.readResource({ uri: tool._meta.ui.resourceUri });
      assert.equal(ui.contents[0].mimeType, 'text/html;profile=mcp-app');
      assert.match(ui.contents[0].text, /Markdown Preview/);
      assert.match(ui.contents[0].text, /data:font\/woff2;base64,/);
      const result = await client.callTool({
        name: tool.name,
        arguments: { file: { name: path.basename(file), resourceUri: 'codex-resource://distribution-test' } },
        _meta: { 'openai/resource': { path: file } }
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(result.structuredContent.text, text);
      assert.match(result.structuredContent.html, /<table\b/);
      assert.match(result.structuredContent.html, /katex/);
      assert.match(result.structuredContent.html, /mermaid/);
      assert.match(result.structuredContent.toc, /Installed preview/);
      t.diagnostic(`${phase}: version ${expected.version}; initialization, UI resource and Markdown rendering passed from its cache.`);
    } finally {
      await client.close();
      if (logs.includes('Cannot find module')) assert.fail(logs);
    }
  }
  await verifyCache(installedCache(), 'Installed');
  if (marketplaceGit) {
    run(['plugin', 'marketplace', 'upgrade', 'markdown-preview-marketplace', '--json']);
    run(['plugin', 'add', 'markdown-preview@markdown-preview-marketplace', '--json']);
    await verifyCache(installedCache(), 'Upgraded and reinstalled');
  }
});
