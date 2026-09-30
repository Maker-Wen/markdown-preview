'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readRegularFile } = require('./files.cjs');

const UI = 'ui://markdown-preview/reader-v1.html';
const server = new McpServer({ name: 'markdown-preview-mcp-server', version: '1.0.0' });
const log = (event, detail = {}) => {
  const row = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...detail });
  process.stderr.write(row + '\n');
};

server.registerResource('markdown_preview_ui', UI, { mimeType: 'text/html;profile=mcp-app' }, async () => {
  log('ui_resource_read');
  return { contents: [{ uri: UI, mimeType: 'text/html;profile=mcp-app',
    text: await require('./render.cjs').viewerHtml(),
    _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ['data:'], connectDomains: [] } }, 'openai/widgetPrefersBorder': false }
  }] };
});

server.registerTool('markdown_preview_open', {
  title: 'Markdown Preview',
  description: 'Display the Markdown file explicitly opened by the Codex file viewer. Requires host-provided file context; no arbitrary path argument.',
  inputSchema: { file: z.object({ name: z.string().min(1), resourceUri: z.string().startsWith('codex-resource://') }) },
  outputSchema: {
    name: z.string(), resourceUri: z.string(), text: z.string(),
    bytes: z.number(), html: z.string(), toc: z.string()
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: {
    ui: { resourceUri: UI, visibility: ['app'] },
    'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.md', '.markdown'] }] }
  }
}, async ({ file }, extra) => {
  const suppliedPath = extra._meta?.['openai/resource']?.path;
  try {
    if (typeof suppliedPath !== 'string' || !path.isAbsolute(suppliedPath) ||
        path.basename(suppliedPath) !== file.name || !/\.(md|markdown)$/i.test(suppliedPath)) {
      throw new Error('缺少有效的宿主 Markdown 文件上下文，请从普通文件链接打开。');
    }
    const realPath = await fs.realpath(suppliedPath);
    if (!/\.(md|markdown)$/i.test(realPath)) throw new Error('只能通过此查看器打开 Markdown 文件。');
    const bytes = await readRegularFile(realPath);
    const text = bytes.toString('utf8');
    const rendered = await require('./render.cjs').render(realPath, text);
    const output = { name: file.name, resourceUri: file.resourceUri, text, ...rendered, bytes: bytes.length };
    log('file_open', { name: output.name, bytes: output.bytes });
    return { content: [{ type: 'text', text: `Markdown Preview 已读取 ${output.name}（${output.bytes} 字节）。` }], structuredContent: output };
  } catch (error) {
    log('file_open_error', { name: file.name, code: error.code ?? error.name });
    const message = error.code ? `读取失败（${error.code}）。` : error.message;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
});

server.connect(new StdioServerTransport()).then(() => log('server_started')).catch(error => {
  process.stderr.write(String(error) + '\n'); process.exitCode = 1;
});
