'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDocumentWatches } = require('./watch.cjs');
const { createBrowserPreviews } = require('./browser-preview.cjs');
const { buildBrowserHtml } = require('./browser-html.cjs');
const { openBrowser } = require('./browser.cjs');

const UI = 'ui://markdown-preview/reader-v1.html';
const server = new McpServer({ name: 'markdown-preview-mcp-server', version: '1.0.0' });
const watches = createDocumentWatches({ render: (file, text) => require('./render.cjs').render(file, text) });
const browsers = createBrowserPreviews({ watches, buildHtml: buildBrowserHtml, openBrowser });
server.server.onclose = () => { browsers.close(); watches.close(); };
const log = (event, detail = {}) => {
  const row = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...detail });
  process.stderr.write(row + '\n');
};

async function authorizeDocument(file, suppliedPath) {
  if (typeof suppliedPath !== 'string' || !path.isAbsolute(suppliedPath) ||
      path.basename(suppliedPath) !== file.name || !/\.(md|markdown)$/i.test(suppliedPath)) {
    throw new Error('缺少有效的宿主 Markdown 文件上下文，请从普通文件链接打开。');
  }
  const realPath = await fs.realpath(suppliedPath);
  if (!/\.(md|markdown)$/i.test(realPath)) throw new Error('只能通过此查看器打开 Markdown 文件。');
  return { path: realPath, name: file.name, resourceUri: file.resourceUri };
}

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
    bytes: z.number(), html: z.string(), toc: z.string(),
    watchId: z.string(), revision: z.number().int().nonnegative()
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: {
    ui: { resourceUri: UI, visibility: ['app'] },
    'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.md', '.markdown'] }] }
  }
}, async ({ file }, extra) => {
  const suppliedPath = extra._meta?.['openai/resource']?.path;
  try {
    const descriptor = await authorizeDocument(file, suppliedPath);
    const output = await watches.open(descriptor);
    log('file_open', { name: output.name, bytes: output.bytes });
    return { content: [{ type: 'text', text: `Markdown Preview 已读取 ${output.name}（${output.bytes} 字节）。` }], structuredContent: output };
  } catch (error) {
    log('file_open_error', { name: file.name, code: error.code ?? error.name });
    const message = error.code ? `读取失败（${error.code}）。` : error.message;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
});

server.registerTool('markdown_preview_refresh', {
  title: 'Refresh Markdown Preview',
  description: 'Check an already-open Markdown preview for saved changes. Requires its watch token and the same host-provided file context.',
  inputSchema: { watchId: z.string().min(1), revision: z.number().int().nonnegative() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: UI, visibility: ['app'] } }
}, async ({ watchId, revision }, extra) => {
  try {
    const suppliedPath = extra._meta?.['openai/resource']?.path;
    if (typeof suppliedPath !== 'string' || !path.isAbsolute(suppliedPath)) {
      throw new Error('缺少有效的宿主 Markdown 文件上下文，请关闭后重新打开预览。');
    }
    const output = await watches.refresh({ watchId, revision, path: suppliedPath });
    return { content: [], structuredContent: output };
  } catch (error) {
    const message = error.code ? `自动刷新失败（${error.code}）。` : error.message;
    return { isError: true, content: [{ type: 'text', text: message }],
      ...(error.code === 'WATCH_EXPIRED' ? { structuredContent: { errorCode: error.code } } : {}) };
  }
});

server.registerTool('markdown_preview_open_browser', {
  title: 'Open Markdown Preview in Browser',
  description: 'Open the current Markdown reading page in the default browser, following saved changes while this MCP server is running. Requires host-provided file context.',
  inputSchema: {
    file: z.object({ name: z.string().min(1), resourceUri: z.string().startsWith('codex-resource://') }),
    preferences: z.object({ tocVisible: z.boolean() }).default({ tocVisible: true })
  },
  outputSchema: { url: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: UI, visibility: ['app'] } }
}, async ({ file, preferences }, extra) => {
  try {
    const descriptor = await authorizeDocument(file, extra._meta?.['openai/resource']?.path);
    const output = await browsers.open(descriptor, preferences);
    log('browser_open', { name: file.name });
    return { content: [], structuredContent: output };
  } catch (error) {
    log('browser_open_error', { name: file.name, code: error.code ?? error.name });
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});

server.connect(new StdioServerTransport()).then(() => log('server_started')).catch(error => {
  process.stderr.write(String(error) + '\n'); process.exitCode = 1;
});
