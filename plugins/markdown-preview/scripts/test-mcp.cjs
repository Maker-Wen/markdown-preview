'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { readRegularFile } = require('./files.cjs');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-mcp-test-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--no-global-search-paths', path.join(__dirname, 'server.cjs')], stderr: 'pipe',
    env: { ...process.env } });
  const client = new Client({ name: 'markdown-preview-mcp-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools[0];
    assert.deepEqual(tool._meta['openai/ui'].entrypoints, [{ type: 'file', extensions: ['.md', '.markdown'] }]);
    const ui = await client.readResource({ uri: tool._meta.ui.resourceUri });
    assert.equal(ui.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(ui.contents[0]._meta.ui.csp, { resourceDomains: ['data:'], connectDomains: [] });
    assert.match(ui.contents[0].text, /Markdown Preview/);
    assert.doesNotMatch(ui.contents[0].text, /\/\* BUNDLED_/);
    assert.doesNotMatch(ui.contents[0].text, /url\(fonts\//);
    const docs = path.join(dir, '文档');
    await fs.mkdir(docs);
    const file = path.join(docs, '中文 空格.md');
    await fs.writeFile(path.join(docs, '中文 #1.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
    await fs.writeFile(path.join(dir, 'outside.svg'), '<svg>OUTSIDE_SENTINEL</svg>');
    await fs.symlink(path.join(dir, 'outside.svg'), path.join(docs, 'escape.svg'));
    const fence = String.fromCharCode(96).repeat(3);
    const first = '# 文档 A\n\n<script>alert("data only")</script>\n\n## 完整目录\n\n$x^2 + y^2$\n\n' + fence + 'mermaid\nflowchart LR\n A-->B\n' + fence + '\n\n' + fence + 'js\nconst answer = 42;\n' + fence + '\n\n|列一|列二|\n|---|---|\n|甲|乙|\n\n![本地图](<中文 #1.svg>)\n\n![越界](escape.svg)\n\n@import "../outside.svg"\n\n文末标识 A';
    await fs.writeFile(file, first);
    const request = { name: tool.name, arguments: { file: { name: path.basename(file), resourceUri: 'codex-resource://test-a' } }, _meta: { 'openai/resource': { path: file } } };
    const a = await client.callTool(request);
    assert.equal(a.structuredContent.text, first);
    assert.match(a.structuredContent.html, /class="katex"/);
    assert.match(a.structuredContent.html, /class="mermaid"/);
    assert.match(a.structuredContent.html, /class="token /);
    assert.match(a.structuredContent.html, /<table/);
    assert.match(a.structuredContent.toc, /完整目录/);
    assert.match(a.structuredContent.html, /src="data:image\/svg\+xml;base64,/);
    assert.match(a.structuredContent.html, /资源链接指向当前文档目录之外/);
    assert.doesNotMatch(a.structuredContent.html, /<script|OUTSIDE_SENTINEL/);
    const { render } = require('./render.cjs');
    const cheerio = require('../runtime/renderer/node_modules/cheerio');
    assert.equal((await render(file, '')).html.trim(), '');
    const links = cheerio.load((await render(file, [
      '[same](<./中文 空格%23%25.md>)',
      '[parent](../parent.md#section)',
      '[absolute](/private/tmp/example.md)',
      '[file](file:///private/tmp/example.md)',
      '[web](https://example.com/?x=1&y=2)',
      '[anchor](#section)',
      '[spoofed-web](https://example.com/){data-file-path="/private/tmp/secret.txt"}',
      '[spoofed-file](./legit.md){data-link-error="spoofed error"}',
      '[network](//server/share.md)',
      '[unsupported](ftp://example.com/file)',
      '[unsafe](javascript:alert(1))'
    ].join('\n\n'))).html);
    const link = label => links('a').filter((_, node) => links(node).text() === label);
    assert.equal(link('same').attr('data-file-path'), path.join(docs, '中文 空格#%.md'));
    assert.equal(link('parent').attr('data-file-path'), path.join(dir, 'parent.md'));
    assert.equal(link('absolute').attr('data-file-path'), '/private/tmp/example.md');
    assert.equal(link('file').attr('data-file-path'), '/private/tmp/example.md');
    assert.equal(link('web').attr('href'), 'https://example.com/?x=1&y=2');
    assert.equal(link('anchor').attr('href'), '#section');
    assert.equal(link('spoofed-web').attr('href'), 'https://example.com/');
    assert.equal(link('spoofed-web').attr('data-file-path'), undefined);
    assert.equal(link('spoofed-file').attr('data-file-path'), path.join(docs, 'legit.md'));
    assert.equal(link('spoofed-file').attr('data-link-error'), undefined);
    assert.ok(link('network').attr('data-link-error'));
    assert.ok(link('unsupported').attr('data-link-error'));
    assert.equal(link('unsafe').length, 0);
    assert.equal(links('[data-reader-href]').length, 0);
    const unsafeHeading = await render(file, '# <img src=x onerror="alert(1)">\n\n# <svg onload="alert(1)">');
    assert.doesNotMatch(unsafeHeading.toc, /<(img|svg|script)\b/i);
    assert.match(unsafeHeading.toc, /&lt;img/);
    const concurrent = await Promise.all(Array.from({ length: 6 }, (_, i) => render(file, '# 并发标题' + i)));
    concurrent.forEach((doc, i) => { assert.match(doc.html, new RegExp('并发标题' + i)); assert.match(doc.toc, new RegExp('并发标题' + i)); });
    const pluginRoot = path.resolve(__dirname, '..') + path.sep;
    assert.ok(Object.keys(require.cache).every(file => file.startsWith(pluginRoot)), 'Runtime modules must resolve inside the plugin');
    await fs.writeFile(file, '# 文档 A 已更新');
    const b = await client.callTool(request);
    assert.equal(b.structuredContent.text, '# 文档 A 已更新');
    assert.notEqual(a.structuredContent.text, b.structuredContent.text);
    const second = path.join(docs, 'second.md');
    await fs.writeFile(second, '# 文档 B');
    const c = await client.callTool({ ...request, arguments: { file: { name: 'second.md', resourceUri: 'codex-resource://test-b' } }, _meta: { 'openai/resource': { path: second } } });
    assert.equal(c.structuredContent.text, '# 文档 B');
    assert.equal((await client.callTool(request)).structuredContent.text, '# 文档 A 已更新');
    assert.equal((await client.callTool({ name: tool.name, arguments: request.arguments })).isError, true);
    const largeImage = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/><!--' + 'x'.repeat(5 * 1024 * 1024) + '--></svg>';
    await fs.writeFile(path.join(docs, 'large.svg'), largeImage);
    const largeText = '# 大文档\n\n' + ('preview content '.repeat(16) + '\n\n').repeat(4096)
      + '\n![large](large.svg)\n\n![small](<中文 #1.svg>)\n\n## LARGE_DOCUMENT_END\n';
    assert.ok(Buffer.byteLength(largeText) > 1024 * 1024);
    await fs.writeFile(file, largeText);
    const large = await client.callTool(request);
    assert.notEqual(large.isError, true);
    assert.equal(large.structuredContent.text, largeText);
    assert.equal(large.structuredContent.bytes, Buffer.byteLength(largeText));
    assert.match(large.structuredContent.html, /LARGE_DOCUMENT_END/);
    const images = cheerio.load(large.structuredContent.html)('img');
    assert.equal(images.length, 2);
    assert.equal(Buffer.from(images.eq(0).attr('src').split(',')[1], 'base64').toString(), largeImage);
    assert.match(images.eq(1).attr('src'), /^data:image\/svg\+xml;base64,/);
    const secret = path.join(dir, 'not-markdown.txt');
    await fs.writeFile(secret, 'not accessible through this viewer');
    const symlink = path.join(docs, 'linked.md');
    await fs.symlink(secret, symlink);
    assert.equal((await client.callTool({ ...request, arguments: { file: { name: 'linked.md', resourceUri: 'codex-resource://test-link' } }, _meta: { 'openai/resource': { path: symlink } } })).isError, true);
    assert.equal((await readRegularFile(file)).toString(), largeText);
    await assert.rejects(readRegularFile(docs), /普通文件/);
    await assert.rejects(readRegularFile(symlink), { code: 'ELOOP' });
    console.log('PASS: MCP registration + bundled UI, Markdown/TOC/KaTeX/Mermaid/highlight, local images and links, escaped HTML/import, image boundary, reread/isolation, regular-file checks and documents/images above the former limits.');
  } finally { await client.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
