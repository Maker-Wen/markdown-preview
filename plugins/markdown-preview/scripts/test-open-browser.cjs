'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { render, viewerHtml } = require('./render.cjs');
const { createDocumentWatches } = require('./watch.cjs');
const { createBrowserPreviews } = require('./browser-preview.cjs');
const { buildBrowserHtml } = require('./browser-html.cjs');

const openTool = 'markdown_preview_open_browser';
const timeout = 15000;
const markdown = (title, marker) => '# ' + title + '\n\n' + marker + '\n\n'
  + '$E=mc^2$\n\n```mermaid\nflowchart LR\n  A[Source] --> B[Browser]\n```\n\n'
  + '```javascript\nconst browserPreview = true;\n```\n\n'
  + '[External page](https://example.com/browser-preview-external)\n\n'
  + '[Local document](./other.md)\n\n'
  + Array.from({ length: 65 }, (_, i) => 'Paragraph ' + i + ' keeps this document scrollable.\n\n').join('')
  + '## Destination section\n\nDESTINATION_SECTION\n';

(async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-browser-test-')));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-global-search-paths', path.join(__dirname, 'server.cjs')],
    stderr: 'pipe', env: { ...process.env },
  });
  const client = new Client({ name: 'markdown-preview-browser-test', version: '1.0.0' });
  const watches = createDocumentWatches({ render });
  const launches = [];
  const previews = createBrowserPreviews({ watches, buildHtml: buildBrowserHtml,
    openBrowser: async url => { launches.push(url); } });
  const results = [], pageErrors = [], serverLog = [];
  transport.stderr?.on('data', chunk => serverLog.push(chunk.toString()));
  let browser, template;

  const check = async (name, run) => {
    try {
      const evidence = await run();
      results.push({ name, pass: true, evidence });
    } catch (error) {
      results.push({ name, pass: false, error: error.stack });
    }
    console.log((results.at(-1).pass ? 'PASS: ' : 'FAIL: ') + name);
  };

  const openDocument = async (name, text) => {
    const file = path.join(directory, name + '.md');
    await fs.writeFile(file, text);
    const result = await client.callTool({ name: 'markdown_preview_open',
      arguments: { file: { name: path.basename(file), resourceUri: 'codex-resource://browser-' + name } },
      _meta: { 'openai/resource': { path: file } } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.text, text);
    return { file, output: result.structuredContent };
  };

  const withViewer = async (document, options, run) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const host = await context.newPage();
    const session = { file: document?.file, output: document?.output, calls: [], browserReplies: [], urls: [] };
    host.on('pageerror', error => pageErrors.push(error.message));
    try {
      await host.exposeFunction('__callMarkdownTool', async params => {
        const request = { name: params.name, arguments: params.arguments,
          _meta: { 'openai/resource': { path: session.file } } };
        let result;
        if (request.name === openTool) {
          // Exercise the real HTTP service and renderer without opening a native browser window.
          result = session.browserReplies.length ? session.browserReplies.shift() : {
            structuredContent: await previews.open({ path: session.file,
              name: request.arguments.file.name, resourceUri: request.arguments.file.resourceUri },
            request.arguments.preferences),
          };
          if (result.structuredContent?.url) session.urls.push(result.structuredContent.url);
        } else result = await client.callTool(request);
        session.calls.push({ request, result });
        return result;
      });
      await host.setContent('<iframe title="Markdown Preview" style="width:100%;height:850px;border:0"></iframe>');
      const html = template.replace('<script>', () => '<script>window.openai='
        + JSON.stringify({ toolOutput: document?.output }).replace(/</g, '\\u003c') + ';</script><script>');
      await host.evaluate(({ html, supportsTools }) => {
        const iframe = document.querySelector('iframe');
        window.__toolCalls = [];
        window.__holdBrowser = false;
        window.__heldBrowser = null;
        window.addEventListener('message', async event => {
          const message = event.data;
          if (event.source !== iframe.contentWindow || message?.jsonrpc !== '2.0' || !message.method || !message.id) return;
          let result;
          if (message.method === 'ui/initialize') {
            result = { protocolVersion: '2026-01-26', hostInfo: { name: 'browser-test-host', version: '1.0.0' },
              hostCapabilities: supportsTools ? { serverTools: {} } : {} };
          } else if (message.method === 'tools/call') {
            window.__toolCalls.push(message);
            try { result = await window.__callMarkdownTool(message.params); }
            catch (error) {
              iframe.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id,
                error: { code: -32603, message: error.message } }, '*');
              return;
            }
            if (message.params.name === 'markdown_preview_open_browser' && window.__holdBrowser) {
              window.__heldBrowser = { id: message.id, result };
              window.__holdBrowser = false;
              return;
            }
          } else {
            iframe.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id,
              error: { code: -32601, message: 'Unsupported test host method: ' + message.method } }, '*');
            return;
          }
          iframe.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
        });
        iframe.srcdoc = html;
      }, { html, supportsTools: options?.supportsTools !== false });
      const frame = await (await host.locator('iframe').elementHandle()).contentFrame();
      await frame.locator('#open-browser').waitFor({ timeout });
      if (document) {
        await frame.waitForFunction(text => document.getElementById('source').textContent === text, document.output.text, { timeout });
      }
      await run({ host, frame, session, context });
    } finally { await context.close(); }
  };

  const releaseBrowser = host => host.evaluate(() => {
    const held = window.__heldBrowser;
    document.querySelector('iframe').contentWindow.postMessage({ jsonrpc: '2.0', id: held.id, result: held.result }, '*');
    window.__heldBrowser = null;
  });

  const waitForOpened = async (host, frame) => {
    await host.waitForFunction(() => window.__toolCalls.some(call => call.params.name === 'markdown_preview_open_browser'), undefined, { timeout });
    await frame.waitForFunction(() => !document.getElementById('open-browser').disabled, undefined, { timeout });
  };

  const waitForDocument = (page, text, title) => page.waitForFunction(({ text, title }) =>
    document.getElementById('source').textContent === text
      && document.getElementById('content').textContent.includes(title)
      && document.getElementById('toc').textContent.includes('Destination section'), { text, title }, { timeout });

  const withBrowserPage = async (url, run) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await page.goto(url);
      await page.locator('#content h1').waitFor({ timeout });
      await run({ page, context });
    } finally { await context.close(); }
  };

  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === openTool));
    template = await viewerHtml();
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });

    await check('The browser button requires a valid current document', async () => {
      await withViewer(null, {}, async ({ frame, session }) => {
        assert.equal(await frame.locator('#open-browser').isDisabled(), true);
        assert.equal(session.calls.some(call => call.request.name === openTool), false);
      });
      const document = await openDocument('valid-document', markdown('Valid title', 'VALID_DOCUMENT'));
      await withViewer(document, {}, async ({ frame }) => {
        assert.equal(await frame.locator('#open-browser').isEnabled(), true);
        assert.match(await frame.locator('#open-browser').innerText(), /在浏览器打开/);
      });
      return { disabledWithoutDocument: true, enabledWithDocument: true };
    });

    await check('The button passes the current file and TOC preference, including from source mode', async () => {
      const document = await openDocument('source-mode-open', markdown('Source mode title', 'SOURCE_MODE_OPEN'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        await frame.locator('#toggle-source').click();
        await frame.locator('#toggle-toc').click();
        await frame.locator('#open-browser').click();
        await waitForOpened(host, frame);
        const calls = session.calls.filter(call => call.request.name === openTool);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].request.arguments, { file: {
          name: document.output.name, resourceUri: document.output.resourceUri,
        }, preferences: { tocVisible: false } });
        assert.equal(calls[0].request._meta['openai/resource'].path, document.file);
        assert.equal(session.urls.length, 1);
        const url = new URL(session.urls[0]);
        assert.equal(url.protocol, 'http:');
        assert.equal(url.hostname, '127.0.0.1');
        await withBrowserPage(session.urls[0], async ({ page }) => {
          assert.equal(await page.locator('#content').isVisible(), true);
          assert.equal(await page.locator('#source').isVisible(), false);
          assert.equal(await page.locator('aside').isVisible(), false);
          assert.equal(await page.locator('#open-browser').isVisible(), false);
          assert.equal(await page.locator('#name').innerText(), document.output.name);
          await page.evaluate(() => localStorage.setItem('markdown-preview:toc', 'visible'));
          await page.reload();
          await waitForDocument(page, document.output.text, 'Source mode title');
          assert.equal(await page.locator('aside').isVisible(), false,
            'The browser bootstrap TOC preference must take precedence over saved browser preferences');
        });
      });
      return { trustedFileContext: true, tocPreferencePassed: true, renderedReadingViewFromSourceMode: true };
    });

    await check('An opening operation preserves the layout and rejects duplicate clicks', async () => {
      const document = await openDocument('markdown-browser-layout-sample-document', markdown('Busy title', 'BUSY_BUTTON'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        const geometry = () => frame.evaluate(() => Object.fromEntries([
          ['header', 'body > header'], ['title', '#name'], ['actions', '.reader-actions'],
          ['button', '#open-browser'], ['main', '#main'],
        ].map(([name, selector]) => {
          const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
          return [name, { x, y, width, height }];
        })));
        // Find the title/actions wrapping boundary from their actual rendered sizes.
        // A shorter busy label used to move the controls back onto the title's row here.
        let viewportWidth, before;
        for (let width = 900; width >= 480; width -= 4) {
          await host.setViewportSize({ width, height: 900 });
          const bounds = await geometry();
          if (bounds.actions.y >= bounds.title.y + bounds.title.height) {
            viewportWidth = width;
            before = bounds;
            break;
          }
        }
        assert.ok(before, 'A title/actions wrapping boundary must be exercised');
        const label = await frame.locator('#open-browser').innerText();
        const screenshotArea = { x: 0, y: 0, width: viewportWidth, height: 300 };
        await host.screenshot({ path: path.join(directory, 'open-button-before.png'), clip: screenshotArea });
        await host.evaluate(() => { window.__holdBrowser = true; });
        await frame.locator('#open-browser').evaluate(button => { button.click(); button.click(); });
        await host.waitForFunction(() => window.__heldBrowser !== null, undefined, { timeout });
        assert.equal(await frame.locator('#open-browser').isDisabled(), true);
        const pendingLabel = await frame.locator('#open-browser').innerText();
        const pending = await geometry();
        await host.screenshot({ path: path.join(directory, 'open-button-pending.png'), clip: screenshotArea });
        await frame.locator('#open-browser').evaluate(button => button.click());
        assert.equal(session.calls.filter(call => call.request.name === openTool).length, 1);
        await releaseBrowser(host);
        await frame.waitForFunction(() => !document.getElementById('open-browser').disabled, undefined, { timeout });
        const after = await geometry();
        await fs.writeFile(path.join(directory, 'open-button-layout.json'), JSON.stringify({
          viewportWidth, label, pendingLabel, before, pending, after,
        }, null, 2));
        assert.deepEqual(pending, before, 'Opening must not change header, title, controls, button, or document bounds');
        assert.deepEqual(after, before, 'Completing the open operation must preserve the layout');
        assert.equal(pendingLabel, label, 'The button label must remain stable while opening');
        assert.equal(await frame.locator('#open-browser').innerText(), label);
      });
      return { oneOpenForRepeatedClicks: true, busyStateCleared: true, stableLabelAndLayout: true };
    });

    await check('An opening error is visible and can be retried successfully', async () => {
      const document = await openDocument('retry-button', markdown('Retry title', 'RETRY_BUTTON'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        session.browserReplies.push({ isError: true, content: [{ type: 'text', text: 'TEST_BROWSER_FAILURE' }] });
        await frame.locator('#open-browser').click();
        await frame.locator('#error').filter({ hasText: 'TEST_BROWSER_FAILURE' }).waitFor({ timeout });
        assert.equal(await frame.locator('#open-browser').isEnabled(), true);
        assert.equal(await frame.locator('#source').textContent(), document.output.text);
        await frame.locator('#open-browser').click();
        await host.waitForFunction(() => window.__toolCalls.filter(call => call.params.name === 'markdown_preview_open_browser').length === 2, undefined, { timeout });
        await frame.waitForFunction(() => !document.getElementById('open-browser').disabled
          && document.getElementById('error').hidden, undefined, { timeout });
        assert.equal(session.urls.length, 1);
      });
      return { usefulError: true, retryEnabled: true, successfulRetryClearsError: true };
    });

    await check('A delayed error for the previous document cannot affect the newly selected file', async () => {
      const first = await openDocument('old-open', markdown('Old title', 'OLD_OPEN'));
      const second = await openDocument('new-open', markdown('New title', 'NEW_OPEN'));
      await withViewer(first, {}, async ({ host, frame, session }) => {
        session.browserReplies.push({ isError: true, content: [{ type: 'text', text: 'STALE_BROWSER_FAILURE' }] });
        await host.evaluate(() => { window.__holdBrowser = true; });
        await frame.locator('#open-browser').click();
        await host.waitForFunction(() => window.__heldBrowser !== null, undefined, { timeout });
        session.file = second.file;
        session.output = second.output;
        await frame.evaluate(output => {
          const globals = { toolOutput: output, toolResponseMetadata: {} };
          Object.assign(window.openai, globals);
          window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
        }, second.output);
        await waitForDocument(frame, second.output.text, 'New title');
        await releaseBrowser(host);
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await frame.locator('#error').isVisible(), false);
        assert.equal(await frame.locator('#open-browser').isEnabled(), true);
        assert.equal(await frame.locator('#source').textContent(), second.output.text);
        await frame.locator('#open-browser').click();
        await frame.waitForFunction(() => !document.getElementById('open-browser').disabled, undefined, { timeout });
        const latest = session.calls.filter(call => call.request.name === openTool).at(-1);
        assert.equal(latest.request.arguments.file.resourceUri, second.output.resourceUri);
        assert.equal(latest.request._meta['openai/resource'].path, second.file);
      });
      return { staleFailureIgnored: true, followingClickUsesNewFile: true };
    });

    await check('Hosts without serverTools explain why browser opening is unavailable', async () => {
      const document = await openDocument('unsupported-browser-host', markdown('Unsupported title', 'UNSUPPORTED_BROWSER_HOST'));
      await withViewer(document, { supportsTools: false }, async ({ frame, session }) => {
        await frame.locator('#open-browser').click();
        await frame.locator('#error').waitFor({ timeout });
        assert.match(await frame.locator('#error').innerText(), /宿主|serverTools/);
        assert.equal(await frame.locator('#open-browser').isEnabled(), true);
        assert.equal(await frame.locator('#source').textContent(), document.output.text);
        assert.equal(session.calls.length, 0);
      });
      return { capabilityChecked: true, readableFailure: true, noToolCalls: true };
    });

    await check('The actual HTTP page renders formulas, diagrams, highlighted code, and navigable headings', async () => {
      const document = await openDocument('http-rendering', markdown('HTTP rendering title', 'HTTP_RENDERING'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        await frame.locator('#open-browser').click();
        await waitForOpened(host, frame);
        await withBrowserPage(session.urls[0], async ({ page }) => {
          assert.ok(await page.locator('#content .katex').count() > 0);
          await page.locator('#content .mermaid svg').waitFor({ timeout });
          assert.ok(await page.locator('#content pre .token').count() > 0);
          assert.equal(await page.locator('#open-browser').isVisible(), false);
          assert.equal(await page.evaluate(() => 'openai' in window), false,
            'Browser preview must receive its initial document without creating a Codex host global');
          assert.equal(await page.locator('aside').isVisible(), true);
          await page.locator('#toc a').filter({ hasText: 'Destination section' }).click();
          await page.waitForFunction(() => {
            const main = document.getElementById('main');
            const bounds = main.getBoundingClientRect();
            const heading = document.querySelector('#content h2').getBoundingClientRect();
            return main.scrollTop > 1000 && heading.top >= bounds.top && heading.bottom <= bounds.bottom;
          }, undefined, { timeout });
        });
      });
      return { loopbackPage: true, katex: true, mermaid: true, codeHighlight: true, tocNavigation: true };
    });

    await check('The actual HTTP page refreshes ordinary and atomic saves while preserving reading state', async () => {
      const document = await openDocument('http-live-refresh', markdown('HTTP original title', 'HTTP_ORIGINAL'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        await frame.locator('#open-browser').click();
        await waitForOpened(host, frame);
        await withBrowserPage(session.urls[0], async ({ page }) => {
          await page.locator('#main').evaluate(node => node.scrollTo({ top: 460, behavior: 'instant' }));
          const scroll = await page.locator('#main').evaluate(node => node.scrollTop);
          assert.ok(scroll > 400);
          const ordinary = markdown('HTTP ordinary title', 'HTTP_ORDINARY');
          await fs.writeFile(document.file, ordinary);
          await waitForDocument(page, ordinary, 'HTTP ordinary title');
          await page.waitForFunction(scroll => Math.abs(document.getElementById('main').scrollTop - scroll) < 2, scroll, { timeout });
          await page.locator('#toggle-source').click();
          await page.locator('#toggle-toc').click();
          await page.locator('#main').evaluate(node => node.scrollTo({ top: 580, behavior: 'instant' }));
          const sourceScroll = await page.locator('#main').evaluate(node => node.scrollTop);
          for (const version of [1, 2]) {
            const title = 'HTTP atomic title ' + version;
            const text = markdown(title, 'HTTP_ATOMIC_' + version);
            const replacement = document.file + '.replacement';
            await fs.writeFile(replacement, text);
            await fs.rename(replacement, document.file);
            await waitForDocument(page, text, title);
            await page.waitForFunction(scroll => Math.abs(document.getElementById('main').scrollTop - scroll) < 2, sourceScroll, { timeout });
            assert.equal(await page.locator('#source').isVisible(), true);
            assert.equal(await page.locator('#content').isVisible(), false);
            assert.equal(await page.locator('aside').isVisible(), false);
          }
        });
      });
      return { ordinarySave: true, consecutiveAtomicSaves: 2, readingScroll: true, sourceState: true, tocState: true };
    });

    await check('The actual HTTP page reconnects an expired watch and keeps following ordinary and atomic saves', async () => {
      const document = await openDocument('http-expired-watch', markdown('HTTP expiry original title', 'HTTP_EXPIRY_ORIGINAL'));
      let evidence;
      await withViewer(document, {}, async ({ host, frame, session }) => {
        await frame.locator('#open-browser').click();
        await waitForOpened(host, frame);
        await withBrowserPage(session.urls[0], async ({ page }) => {
          await page.locator('#toggle-source').click();
          await page.locator('#toggle-toc').click();
          await page.locator('#main').evaluate(node => node.scrollTo({ top: 580, behavior: 'instant' }));
          const scroll = await page.locator('#main').evaluate(node => node.scrollTop);
          assert.ok(scroll > 500);

          const refreshRequests = [];
          page.on('request', request => {
            if (new URL(request.url()).pathname.endsWith('/refresh')) {
              refreshRequests.push(request.postDataJSON());
            }
          });
          let expiredWatchId;
          const reconnectResponses = Promise.all([
            page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/refresh')
              && response.status() === 410, { timeout }),
            page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/reopen')
              && response.status() === 200, { timeout }),
          ]);
          await page.route('**/refresh', async route => {
            if (!expiredWatchId) {
              expiredWatchId = route.request().postDataJSON().watchId;
              // Retire the real watch; let the owned HTTP transport produce WATCH_EXPIRED.
              watches.release(expiredWatchId);
            }
            await route.continue();
          });

          const [expiredResponse, reopenedResponse] = await reconnectResponses;
          const expired = await expiredResponse.json();
          const reopened = await reopenedResponse.json();
          assert.equal(expired.code, 'WATCH_EXPIRED');
          assert.equal(expired.errorCode, 'WATCH_EXPIRED');
          assert.equal(reopened.resourceUri, document.output.resourceUri);
          assert.equal(reopened.text, document.output.text);
          assert.equal(typeof reopened.watchId, 'string');
          assert.notEqual(reopened.watchId, expiredWatchId);
          assert.equal(reopened.revision, 1);

          const nextRefresh = await page.waitForRequest(request =>
            new URL(request.url()).pathname.endsWith('/refresh')
              && request.postDataJSON().watchId === reopened.watchId, { timeout });
          assert.equal(nextRefresh.postDataJSON().revision, reopened.revision);
          const retiredRequests = refreshRequests.filter(request => request.watchId === expiredWatchId).length;
          assert.equal(retiredRequests, 1);

          const assertReadingState = async () => {
            await page.waitForFunction(scroll =>
              Math.abs(document.getElementById('main').scrollTop - scroll) < 2, scroll, { timeout });
            assert.equal(await page.locator('#source').isVisible(), true);
            assert.equal(await page.locator('#content').isVisible(), false);
            assert.equal(await page.locator('aside').isVisible(), false);
            assert.equal(await page.locator('#toggle-toc').getAttribute('aria-expanded'), 'false');
            assert.equal(await page.locator('#status').isVisible(), false);
            assert.equal(await page.locator('#error').isVisible(), false);
          };
          await assertReadingState();

          let revision = reopened.revision;
          for (const [kind, title, marker] of [
            ['ordinary', 'HTTP expiry ordinary title', 'HTTP_EXPIRY_ORDINARY'],
            ['atomic', 'HTTP expiry atomic title', 'HTTP_EXPIRY_ATOMIC'],
          ]) {
            const text = markdown(title, marker);
            const updatedResponse = page.waitForResponse(async response => {
              const request = response.request();
              if (!new URL(response.url()).pathname.endsWith('/refresh')
                || response.status() !== 200
                || request.postDataJSON().watchId !== reopened.watchId) return false;
              const update = await response.json();
              return update.document?.text === text && update.document.watchId === reopened.watchId;
            }, { timeout });
            if (kind === 'atomic') {
              const replacement = document.file + '.replacement';
              await fs.writeFile(replacement, text);
              await fs.rename(replacement, document.file);
            } else await fs.writeFile(document.file, text);
            const updated = await (await updatedResponse).json();
            assert.ok(updated.revision > revision);
            assert.equal(updated.document.revision, updated.revision);
            revision = updated.revision;
            await waitForDocument(page, text, title);
            await assertReadingState();
            assert.equal(refreshRequests.filter(request => request.watchId === expiredWatchId).length,
              retiredRequests, 'The expired token must not be used after reconnecting');
          }
          evidence = { expiryFromActualHttp: true, reopenedWatchId: reopened.watchId,
            expiredWatchId, expiredTokenRequests: retiredRequests, ordinarySave: true,
            atomicSave: true, sourceState: true, tocState: true, scroll: true };
        });
      });
      return evidence;
    });

    await check('Browser links use browser tabs and local-file links explain the unsupported action', async () => {
      const document = await openDocument('http-links', markdown('HTTP links title', 'HTTP_LINKS'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        await frame.locator('#open-browser').click();
        await waitForOpened(host, frame);
        await withBrowserPage(session.urls[0], async ({ page, context }) => {
          await context.route('https://example.com/browser-preview-external', route => route.fulfill({
            status: 200, contentType: 'text/html', body: '<!doctype html><title>External browser page</title><h1>External target reached</h1>',
          }));
          await page.evaluate(() => {
            window.__codexMessages = [];
            window.addEventListener('message', event => {
              if (event.data?.jsonrpc === '2.0') window.__codexMessages.push(event.data);
            });
          });
          const popupEvent = context.waitForEvent('page', { timeout });
          await page.locator('#content a').filter({ hasText: 'External page' }).click();
          const popup = await popupEvent;
          await popup.locator('h1').filter({ hasText: 'External target reached' }).waitFor({ timeout });
          assert.equal(popup.url(), 'https://example.com/browser-preview-external');
          assert.equal(await popup.evaluate(() => window.opener), null);
          assert.match(page.url(), /^http:\/\/127\.0\.0\.1:/);
          await popup.close();
          await page.locator('#content a').filter({ hasText: 'Local document' }).click();
          await page.locator('#error').waitFor({ timeout });
          assert.match(await page.locator('#error').innerText(), /浏览器预览暂不支持打开本地文件|返回 Codex/);
          assert.match(page.url(), /^http:\/\/127\.0\.0\.1:/);
          assert.deepEqual(await page.evaluate(() => window.__codexMessages), []);
        });
      });
      return { externalBrowserNavigation: true, noopener: true, localFileMessage: true, noCodexBridgeCalls: true };
    });

    await check('Browser opening and refresh produce no uncaught page errors', async () => {
      assert.ok(launches.length >= 1, 'The real browser service must call the injected launch hook');
      assert.deepEqual(pageErrors, []);
      return { launchHookInvoked: true, nativeBrowserWindowsOpened: 0, pageErrors: 0 };
    });
  } finally {
    await browser?.close();
    await client.close();
    await previews.close();
    watches.close();
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ results, pageErrors, launches }, null, 2));
    await fs.writeFile(path.join(directory, 'server.log'), serverLog.join(''));
    for (const result of results.filter(result => !result.pass)) console.log('DETAIL: ' + result.name + '\n' + result.error);
    console.log('Artifacts: ' + directory);
    if (results.some(result => !result.pass)) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
