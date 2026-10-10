'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
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
    const refreshTool = (await client.listTools()).tools.find(tool => tool.name === 'markdown_preview_refresh');
    assert.deepEqual(refreshTool._meta.ui.visibility, ['app']);
    const refreshRequest = { name: refreshTool.name,
      arguments: { watchId: a.structuredContent.watchId, revision: a.structuredContent.revision },
      _meta: request._meta };
    const unchanged = await client.callTool(refreshRequest);
    assert.deepEqual(unchanged.structuredContent, {
      watchId: a.structuredContent.watchId, revision: a.structuredContent.revision
    });
    assert.equal((await client.callTool({ name: refreshRequest.name, arguments: refreshRequest.arguments })).isError, true);
    assert.equal((await client.callTool({ ...refreshRequest,
      _meta: { 'openai/resource': { path: path.join(dir, 'outside.svg') } } })).isError, true);
    const expired = await client.callTool({ ...refreshRequest,
      arguments: { watchId: 'unknown-watch', revision: 1 } });
    assert.equal(expired.isError, true);
    assert.equal(expired.structuredContent.errorCode, 'WATCH_EXPIRED');
    const browserTool = (await client.listTools()).tools.find(tool => tool.name === 'markdown_preview_open_browser');
    assert.deepEqual(browserTool._meta.ui.visibility, ['app']);
    const browserRequest = { name: browserTool.name, arguments: { file: request.arguments.file, preferences: { tocVisible: true } } };
    assert.equal((await client.callTool(browserRequest)).isError, true);
    assert.equal((await client.callTool({ ...browserRequest,
      _meta: { 'openai/resource': { path: path.join(dir, 'outside.svg') } } })).isError, true);
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
    const realFile = await fs.realpath(file);
    assert.equal((await render(file, '')).html.trim(), '');
    const importedFile = path.join(docs, 'comment-import.md');
    await fs.writeFile(importedFile, '# COMMENT_IMPORT_SENTINEL');
    const realImportedFile = await fs.realpath(importedFile);
    let localReads = 0;
    let remoteRequests = 0;
    const importServer = http.createServer((request, response) => {
      remoteRequests++;
      response.writeHead(200, { 'Content-Type': 'text/markdown' });
      response.end('# REMOTE_IMPORT_SENTINEL');
    });
    await new Promise((resolve, reject) => {
      importServer.once('error', reject);
      importServer.listen(0, '127.0.0.1', resolve);
    });
    const readFile = fs.readFile;
    fs.readFile = async (target, ...args) => {
      if (target === realImportedFile) localReads++;
      return readFile(target, ...args);
    };
    const commentResults = [];
    try {
      const remoteUrl = 'http://127.0.0.1:' + importServer.address().port + '/comment-import.md';
      for (const target of ['comment-import.md', remoteUrl]) {
        for (const source of [
          '<!-- @import "' + target + '" -->',
          '<!--\n@import "' + target + '"\n-->',
          '> <!-- @import "' + target + '" -->'
        ]) commentResults.push(await render(realFile, source));
      }
    } finally {
      fs.readFile = readFile;
      await new Promise(resolve => importServer.close(resolve));
    }
    assert.deepEqual({ localReads, remoteRequests }, { localReads: 0, remoteRequests: 0 },
      'Comment imports must not read files or make HTTP requests');
    for (const result of commentResults) {
      assert.doesNotMatch(result.html, /COMMENT_IMPORT_SENTINEL|REMOTE_IMPORT_SENTINEL|\u2063/);
    }
    const literalCode = [
      '&#64;import',
      ' <!-- preview-image -->',
      '\\!\\[\\[',
      '@import "../outside.svg"',
      '<!-- @import "comment-import.md" -->',
      '<!-- @import "http://127.0.0.1:1/comment-import.md" -->',
      '![image](../outside.svg)',
      '![[../outside.md]]',
      '<script>alert("code only")</script>'
    ];
    const inlineLiterals = cheerio.load((await render(file,
      literalCode.map(code => '`' + code + '`').join('\n\n'))).html);
    assert.deepEqual(inlineLiterals('code').toArray().map(node => inlineLiterals(node).text()), literalCode);
    const codeBody = literalCode.join('\n') + '\n';
    for (const [opening, closing] of [[fence + 'js {cmd=node}', fence], ['~~~js', '~~~']]) {
      const code = cheerio.load((await render(file, opening + '\n' + codeBody + closing)).html);
      assert.equal(code('pre code').text(), codeBody);
      assert.match(code.html(), /class="token /);
      assert.equal(code('script,img').length, 0);
    }
    const indented = cheerio.load((await render(file,
      codeBody.trimEnd().split('\n').map(line => '    ' + line).join('\n'))).html);
    assert.equal(indented('pre').text(), codeBody);
    const mermaidBody = 'flowchart LR\n A["&#64;import"] --> B[" <!-- preview-image -->"]\n';
    for (const [opening, closing] of [[fence + 'mermaid', fence], [':::mermaid', ':::']]) {
      const diagram = cheerio.load((await render(file, opening + '\n' + mermaidBody + closing)).html);
      assert.equal(diagram('.mermaid').text(), mermaidBody);
    }
    await fs.writeFile(path.join(dir, 'outside.md'), '# OUTSIDE_MARKDOWN_SENTINEL');
    const imports = await render(file, [
      '@import "../outside.md"',
      '> @import "../outside.md"',
      '![[../outside.md]]',
      '> ![[../outside.md]]'
    ].join('\n\n'));
    assert.doesNotMatch(imports.html, /OUTSIDE_MARKDOWN_SENTINEL|\u2063/);
    assert.match(cheerio.load(imports.html).text(), /@import/);
    const headingSource = '# @import\n\n## ![[literal]]\n\n[jump](#import)\n\n[wiki](#literal)';
    const headingFirst = await render(file, headingSource);
    const headingSecond = await render(file, headingSource);
    assert.equal(headingFirst.html, headingSecond.html);
    const headings = cheerio.load(headingFirst.html);
    const headingToc = cheerio.load(headingFirst.toc);
    assert.deepEqual(headings('h1,h2').toArray().map(node => headings(node).attr('id')), ['import', 'literal']);
    assert.deepEqual(headingToc('a').toArray().map(node => headingToc(node).attr('href')), ['#import', '#literal']);
    const frontMatter = await render(file, '---\nexample: |\n  @import "../outside.md"\n  ![[../outside.md]]\n---\n\n# front matter');
    assert.doesNotMatch(frontMatter.html, /OUTSIDE_MARKDOWN_SENTINEL|\u2063/);
    for (const [kind, character] of [
      ['raw', '\u2063'], ['decimal entity', '&#8291;'], ['hex entity', '&#x2063;']
    ]) {
      for (const length of [16, 32]) {
        const preserved = cheerio.load((await render(file, 'before' + character.repeat(length) + 'after')).html);
        assert.equal(preserved('p').text(), 'before' + '\u2063'.repeat(length) + 'after',
          `${kind} format characters must survive marker restoration`);
      }
    }
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
    const concurrent = await Promise.all(Array.from({ length: 6 }, (_, i) => render(realFile,
      '# 并发标题' + i + '\n\n' + fence + 'text\n' + codeBody + 'render-' + i + '\u2063'.repeat(16 * (2 ** i)) + '\n' + fence
      + '\n\n@import "../outside.md"\n\n![image](<中文 #1.svg>)')));
    concurrent.forEach((doc, i) => {
      assert.match(doc.html, new RegExp('并发标题' + i));
      assert.match(doc.toc, new RegExp('并发标题' + i));
      assert.equal(cheerio.load(doc.html)('pre code').text(), codeBody + 'render-' + i + '\u2063'.repeat(16 * (2 ** i)) + '\n');
      assert.match(doc.html, /src="data:image\/svg\+xml;base64,/);
      assert.doesNotMatch(doc.html, /OUTSIDE_MARKDOWN_SENTINEL/);
    });
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
    const markdownTarget = path.join(docs, 'accepted-target.markdown');
    const markdownLink = path.join(docs, 'accepted-link.md');
    const linkedText = '# Linked Markdown\n\nLINKED_CONTENT\n';
    await fs.writeFile(markdownTarget, linkedText);
    await fs.symlink(markdownTarget, markdownLink);
    const linkedMeta = { 'openai/resource': { path: markdownLink } };
    const linked = await client.callTool({ name: tool.name,
      arguments: { file: { name: 'accepted-link.md', resourceUri: 'codex-resource://accepted-link' } },
      _meta: linkedMeta });
    assert.notEqual(linked.isError, true);
    assert.equal(linked.structuredContent.name, 'accepted-link.md');
    assert.equal(linked.structuredContent.text, linkedText);
    const linkedRefresh = { name: refreshTool.name,
      arguments: { watchId: linked.structuredContent.watchId, revision: 1 }, _meta: linkedMeta };
    assert.deepEqual((await client.callTool(linkedRefresh)).structuredContent,
      { watchId: linked.structuredContent.watchId, revision: 1 });
    const replacement = path.join(docs, 'accepted-next.markdown');
    const linkedSaved = '# Linked saved\n\nLINKED_ATOMIC_SAVE\n';
    await fs.writeFile(replacement, linkedSaved);
    await fs.rename(replacement, markdownTarget);
    const linkedUpdate = await client.callTool(linkedRefresh);
    assert.notEqual(linkedUpdate.isError, true);
    assert.equal(linkedUpdate.structuredContent.revision, 2);
    assert.equal(linkedUpdate.structuredContent.document.text, linkedSaved);
    assert.equal((await readRegularFile(file)).toString(), largeText);
    await assert.rejects(readRegularFile(docs), /普通文件/);
    await assert.rejects(readRegularFile(symlink), { code: 'ELOOP' });
    if (process.platform !== 'win32') {
      const pipe = path.join(docs, 'pipe.md');
      const pipeImage = path.join(docs, 'pipe.svg');
      execFileSync('mkfifo', [pipe, pipeImage]);
      const fifoRead = spawnSync(process.execPath, ['--no-global-search-paths', '-e',
        `require('node:assert/strict').rejects(require(${JSON.stringify(path.join(__dirname, 'files.cjs'))}).readRegularFile(${JSON.stringify(pipe)}), /普通文件/).catch(error => { console.error(error); process.exitCode = 1; });`
      ], { encoding: 'utf8', timeout: 5000 });
      assert.ifError(fifoRead.error);
      assert.equal(fifoRead.status, 0, fifoRead.stderr);
      const fifo = await client.callTool({ ...request,
        arguments: { file: { name: 'pipe.md', resourceUri: 'codex-resource://test-fifo' } },
        _meta: { 'openai/resource': { path: pipe } } });
      assert.equal(fifo.isError, true);
      assert.match(fifo.content[0].text, /普通文件/);
      const fifoImage = cheerio.load((await render(realFile, '![pipe](pipe.svg)')).html);
      assert.equal(fifoImage('img').length, 0);
      assert.match(fifoImage('.image-unavailable').text(), /普通文件/);
    }
    console.log('PASS: MCP registration + bundled UI, Markdown/TOC/KaTeX/Mermaid/highlight, literal code and concurrent render isolation, local images and links, escaped HTML/import including comment file/HTTP imports, image boundary, reread/isolation, refresh/browser host-context checks, regular-file/FIFO checks and documents/images above the former limits.');
  } finally { await client.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
