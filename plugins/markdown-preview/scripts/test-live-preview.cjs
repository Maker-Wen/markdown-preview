'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { viewerHtml } = require('./render.cjs');

const refreshTool = 'markdown_preview_refresh';
const timeout = 15000;
const markdown = (title, marker) => '# ' + title + '\n\n' + marker + '\n\n## ' + title + ' section\n\n'
  + Array.from({ length: 65 }, (_, i) => 'Paragraph ' + i + ' keeps this document scrollable.\n\n').join('');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-live-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-global-search-paths', path.join(__dirname, 'server.cjs')],
    stderr: 'pipe', env: { ...process.env },
  });
  const client = new Client({ name: 'markdown-preview-live-test', version: '1.0.0' });
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
    const result = await client.callTool({
      name: 'markdown_preview_open',
      arguments: { file: { name: path.basename(file), resourceUri: 'codex-resource://live-' + name } },
      _meta: { 'openai/resource': { path: file } },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const output = result.structuredContent;
    assert.equal(output.text, text);
    assert.equal(typeof output.watchId, 'string');
    assert.ok(output.watchId.length > 0);
    assert.ok(Number.isInteger(output.revision));
    assert.ok(output.revision > 0);
    return { file, output };
  };

  const withViewer = async (document, options, run) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    const host = await context.newPage();
    const session = { file: document.file, calls: [], expireNextRefresh: options?.expireFirstRefresh === true };
    host.on('pageerror', error => pageErrors.push(error.message));
    try {
      await host.exposeFunction('__callMarkdownTool', async params => {
        const requestedAt = Date.now();
        const request = { name: params.name, arguments: params.arguments,
          _meta: { 'openai/resource': { path: session.file } } };
        const injectExpiry = session.expireNextRefresh && request.name === refreshTool;
        session.expireNextRefresh = session.expireNextRefresh && !injectExpiry;
        const result = injectExpiry
          ? { isError: true, content: [{ type: 'text', text: '测试监听已过期。' }],
            structuredContent: { errorCode: 'WATCH_EXPIRED' } }
          : await client.callTool(request);
        session.calls.push({ request, result, requestedAt });
        return result;
      });
      await host.setContent('<iframe title="Markdown Preview" style="width:100%;height:850px;border:0"></iframe>');
      const html = template.replace('<script>', () => '<script>window.openai='
        + JSON.stringify({ toolOutput: document.output }).replace(/</g, '\\u003c') + ';</script><script>');
      await host.evaluate(({ html, supportsTools }) => {
        const iframe = document.querySelector('iframe');
        window.__toolCalls = [];
        window.__toolResults = [];
        window.__toolResponses = 0;
        window.__heldRefresh = null;
        window.__holdMarker = '';
        window.__heldReopen = null;
        window.__holdReopen = false;
        window.addEventListener('message', async event => {
          const message = event.data;
          if (event.source !== iframe.contentWindow || message?.jsonrpc !== '2.0' || !message.method || !message.id) return;
          let result;
          if (message.method === 'ui/initialize') {
            result = { protocolVersion: '2026-01-26', hostInfo: { name: 'live-test-host', version: '1.0.0' },
              hostCapabilities: supportsTools ? { serverTools: {} } : {} };
          } else if (message.method === 'tools/call') {
            window.__toolCalls.push(message);
            try {
              result = await window.__callMarkdownTool(message.params);
              window.__toolResponses++;
              window.__toolResults.push({ name: message.params.name, isError: result.isError,
                watchId: result.structuredContent?.watchId });
            } catch (error) {
              iframe.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id,
                error: { code: -32603, message: error.message } }, '*');
              return;
            }
            if (window.__holdMarker && result.structuredContent?.document?.text?.includes(window.__holdMarker)) {
              window.__heldRefresh = { id: message.id, result };
              window.__holdMarker = '';
              return;
            }
            if (window.__holdReopen && message.params.name === 'markdown_preview_open') {
              window.__heldReopen = { id: message.id, result };
              window.__holdReopen = false;
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
      const iframeElement = await host.locator('iframe').elementHandle();
      const frame = await iframeElement.contentFrame();
      await frame.locator('#name').filter({ hasText: document.output.name }).waitFor({ timeout });
      await frame.waitForFunction(text => document.getElementById('source').textContent === text, document.output.text, { timeout });
      await run({ host, frame, session });
    } finally { await context.close(); }
  };

  const waitForDocument = (frame, text, title) => frame.waitForFunction(({ text, title }) => {
    return document.getElementById('source').textContent === text
      && document.getElementById('content').textContent.includes(title)
      && document.getElementById('toc').textContent.includes(title + ' section');
  }, { text, title }, { timeout });

  const assertDocument = async (frame, output) => {
    assert.equal(await frame.locator('#source').textContent(), output.text);
    assert.equal(await frame.locator('#name').textContent(), output.name);
    assert.equal(await frame.locator('#content').innerHTML(), output.html);
    assert.equal(await frame.locator('#toc').innerHTML(), output.toc);
  };

  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === refreshTool));
    template = await viewerHtml();
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });

    await check('Saving a real file refreshes content, exact source, and TOC through the MCP host', async () => {
      const document = await openDocument('ordinary-save', markdown('Original title', 'ORIGINAL_CONTENT'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        await host.waitForFunction(() => window.__toolCalls.length >= 1, undefined, { timeout });
        const text = markdown('Saved title', 'SAVED_CONTENT');
        await fs.writeFile(document.file, text);
        await waitForDocument(frame, text, 'Saved title');
        assert.doesNotMatch(await frame.locator('#content').innerText(), /ORIGINAL_CONTENT/);
        const changed = session.calls.find(call => call.result.structuredContent?.document?.text === text);
        assert.ok(changed, 'The visible update must come from the real refresh tool');
        assert.equal(changed.request.name, refreshTool);
        assert.deepEqual(Object.keys(changed.request.arguments).sort(), ['revision', 'watchId']);
        assert.equal(changed.request.arguments.watchId, document.output.watchId);
        assert.equal(changed.request._meta['openai/resource'].path, document.file);
        assert.notEqual(changed.result.structuredContent.revision, document.output.revision);
        assert.equal(await frame.locator('#error').isVisible(), false);
      });
      return { realDiskSave: true, realMcpResponse: true, sourceAndTocUpdated: true };
    });

    await check('Atomic replacement saves continue refreshing the same open document', async () => {
      const document = await openDocument('atomic-save', markdown('Atomic original', 'ATOMIC_ORIGINAL'));
      await withViewer(document, {}, async ({ frame }) => {
        for (const version of [1, 2]) {
          const title = 'Atomic saved ' + version;
          const text = markdown(title, 'ATOMIC_REPLACEMENT_' + version);
          const replacement = document.file + '.replacement';
          await fs.writeFile(replacement, text);
          await fs.rename(replacement, document.file);
          await waitForDocument(frame, text, title);
        }
      });
      return { consecutiveAtomicReplacements: 2 };
    });

    await check('Temporary deletion retains the last successful document and recreation recovers', async () => {
      const document = await openDocument('delete-recreate', markdown('Retained title', 'RETAINED_CONTENT'));
      await withViewer(document, {}, async ({ frame }) => {
        await fs.unlink(document.file);
        await frame.waitForFunction(() => document.getElementById('status').textContent.includes('自动刷新失败'), undefined, { timeout });
        await assertDocument(frame, document.output);
        assert.equal(await frame.locator('#error').isVisible(), false);
        assert.ok(await frame.locator('#status').getAttribute('title'));
        const text = markdown('Recreated title', 'RECREATED_CONTENT');
        await fs.writeFile(document.file, text);
        await waitForDocument(frame, text, 'Recreated title');
        await frame.waitForFunction(() => !document.getElementById('status').textContent.includes('失败'), undefined, { timeout });
      });
      return { previousContentRetained: true, recreationRecovered: true };
    });

    await check('Refresh preserves reading position, source mode, and hidden TOC', async () => {
      const document = await openDocument('reading-state', markdown('Reading title', 'READING_STATE'));
      await withViewer(document, {}, async ({ frame }) => {
        await frame.locator('#main').evaluate(node => node.scrollTo({ top: 350, behavior: 'instant' }));
        const readingScroll = await frame.locator('#main').evaluate(node => node.scrollTop);
        assert.ok(readingScroll > 300);
        const readingText = document.output.text + '\nREADING_REFRESH_APPEND\n';
        await fs.writeFile(document.file, readingText);
        await waitForDocument(frame, readingText, 'Reading title');
        await frame.waitForFunction(scroll => Math.abs(document.getElementById('main').scrollTop - scroll) < 2, readingScroll, { timeout });
        await frame.locator('#toggle-source').click();
        await frame.locator('#toggle-toc').click();
        await frame.locator('#main').evaluate(node => node.scrollTo({ top: 520, behavior: 'instant' }));
        const sourceScroll = await frame.locator('#main').evaluate(node => node.scrollTop);
        assert.ok(sourceScroll > 500);
        const sourceText = readingText + '\nSOURCE_REFRESH_APPEND\n';
        await fs.writeFile(document.file, sourceText);
        await waitForDocument(frame, sourceText, 'Reading title');
        await frame.waitForFunction(scroll => Math.abs(document.getElementById('main').scrollTop - scroll) < 2, sourceScroll, { timeout });
        assert.equal(await frame.locator('#source').isVisible(), true);
        assert.equal(await frame.locator('#content').isVisible(), false);
        assert.equal(await frame.locator('aside').isVisible(), false);
        assert.equal(await frame.locator('#toggle-source').getAttribute('aria-pressed'), 'true');
        assert.equal(await frame.locator('#toggle-toc').getAttribute('aria-expanded'), 'false');
      });
      return { readingScrollPreserved: true, sourceScrollPreserved: true, sourceModePreserved: true, tocPreserved: true };
    });

    await check('An old in-flight refresh cannot overwrite a newly selected document', async () => {
      const first = await openDocument('stale-first', markdown('First title', 'FIRST_DOCUMENT'));
      const second = await openDocument('stale-second', markdown('Second title', 'SECOND_DOCUMENT'));
      await withViewer(first, {}, async ({ host, frame, session }) => {
        await host.evaluate(() => { window.__holdMarker = 'DELAYED_FIRST_DOCUMENT'; });
        await fs.writeFile(first.file, markdown('Delayed first title', 'DELAYED_FIRST_DOCUMENT'));
        await host.waitForFunction(() => window.__heldRefresh !== null, undefined, { timeout });
        session.file = second.file;
        await frame.evaluate(output => {
          window.openai.toolOutput = output;
          window.openai.toolResponseMetadata = {};
          window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: {
            toolOutput: output, toolResponseMetadata: {},
          } } }));
        }, second.output);
        await waitForDocument(frame, second.output.text, 'Second title');
        await host.evaluate(() => {
          const held = window.__heldRefresh;
          document.querySelector('iframe').contentWindow.postMessage({ jsonrpc: '2.0', id: held.id, result: held.result }, '*');
          window.__heldRefresh = null;
        });
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await frame.locator('#source').textContent(), second.output.text,
          'The old response must never replace the newly selected document');
        assert.equal(await frame.locator('#name').textContent(), second.output.name);
        const text = markdown('Second saved title', 'SECOND_SAVED_CONTENT');
        await fs.writeFile(second.file, text);
        await waitForDocument(frame, text, 'Second saved title');
        assert.doesNotMatch(await frame.locator('#content').innerText(), /FIRST_DOCUMENT/);
        assert.equal(await frame.locator('#name').textContent(), second.output.name);
        assert.equal(await frame.locator('#error').isVisible(), false);
      });
      return { delayedFirstResponseDiscarded: true, secondDocumentContinuesRefreshing: true };
    });

    await check('Hosts without serverTools show a clear unavailable status while retaining the document', async () => {
      const document = await openDocument('unsupported-host', markdown('Unsupported host title', 'UNSUPPORTED_HOST_CONTENT'));
      await withViewer(document, { supportsTools: false }, async ({ frame, session }) => {
        await frame.waitForFunction(() => document.getElementById('status').textContent.includes('自动刷新不可用'), undefined, { timeout });
        await assertDocument(frame, document.output);
        assert.match(await frame.locator('#status').getAttribute('title'), /宿主|serverTools|刷新/);
        assert.equal(await frame.locator('#error').isVisible(), false);
        assert.equal(session.calls.length, 0);
      });
      return { capabilityChecked: true, initialDocumentRetained: true, refreshToolCalls: 0 };
    });

    await check('An expired watch is reopened through the trusted host without losing source mode or scroll', async () => {
      const document = await openDocument('expired-watch', markdown('Expired title', 'EXPIRY_ORIGINAL_CONTENT'));
      await withViewer(document, { expireFirstRefresh: true }, async ({ host, frame, session }) => {
        await frame.locator('#toggle-source').click();
        await frame.locator('#toggle-toc').click();
        await frame.locator('#main').evaluate(node => node.scrollTo({ top: 520, behavior: 'instant' }));
        const scroll = await frame.locator('#main').evaluate(node => node.scrollTop);
        assert.ok(scroll > 500);
        await host.waitForFunction(() => window.__toolResults.some(result => result.name === 'markdown_preview_open'), undefined, { timeout });
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const reopened = session.calls.find(call => call.request.name === 'markdown_preview_open');
        assert.ok(reopened, 'The expired watch must be reopened through the actual MCP server');
        assert.equal(reopened.request._meta['openai/resource'].path, document.file);
        assert.deepEqual(reopened.request.arguments, { file: {
          name: document.output.name, resourceUri: document.output.resourceUri,
        } });
        assert.notEqual(reopened.result.isError, true);
        assert.notEqual(reopened.result.structuredContent.watchId, document.output.watchId);
        await frame.waitForFunction(scroll => Math.abs(document.getElementById('main').scrollTop - scroll) < 2, scroll, { timeout });
        assert.equal(await frame.locator('#source').textContent(), document.output.text);
        assert.equal(await frame.locator('#source').isVisible(), true);
        assert.equal(await frame.locator('aside').isVisible(), false);
        assert.equal(await frame.locator('#name').textContent(), document.output.name);
        const text = markdown('After expiry title', 'AFTER_EXPIRY_SAVED_CONTENT');
        await fs.writeFile(document.file, text);
        await waitForDocument(frame, text, 'After expiry title');
        assert.ok(session.calls.some(call => call.request.name === refreshTool
          && call.request.arguments.watchId === reopened.result.structuredContent.watchId
          && call.result.structuredContent?.document?.text === text));
        await frame.evaluate(() => {
          const globals = { theme: 'dark', displayMode: 'fullscreen' };
          Object.assign(window.openai, globals);
          window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
        });
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await frame.locator('#source').textContent(), text,
          'A globals update without toolOutput must retain the latest document after reopening');
        await frame.evaluate(output => {
          const globals = { toolOutput: output, toolResponseMetadata: {} };
          Object.assign(window.openai, globals);
          window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
        }, document.output);
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await frame.locator('#source').textContent(), text,
          'The expired original token must not replace the reopened document');
        const laterText = markdown('Later after expiry title', 'LATER_AFTER_EXPIRY_SAVED_CONTENT');
        await fs.writeFile(document.file, laterText);
        await waitForDocument(frame, laterText, 'Later after expiry title');
        assert.equal(await frame.locator('#source').isVisible(), true);
        assert.equal(await frame.locator('#error').isVisible(), false);
      });
      return { firstRefreshExpiryInjected: true, reopenAndFollowingRefreshUseRealMcp: true,
        readingStatePreserved: true, partialGlobalsAndExpiredHostTokenCannotRestoreOldContent: true };
    });

    await check('A stale host output cannot roll back a saved revision, including after a theme change', async () => {
      const document = await openDocument('stale-host-output', markdown('Host original title', 'HOST_ORIGINAL_CONTENT'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        const saved = markdown('Host saved title', 'HOST_SAVED_CONTENT');
        await fs.writeFile(document.file, saved);
        await waitForDocument(frame, saved, 'Host saved title');
        const update = session.calls.find(call => call.result.structuredContent?.document?.text === saved);
        assert.ok(update);
        assert.ok(update.result.structuredContent.revision > document.output.revision);
        await frame.evaluate(output => {
          const globals = { toolOutput: output, toolResponseMetadata: {}, theme: 'dark', locale: 'zh-CN' };
          Object.assign(window.openai, globals);
          window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
        }, document.output);
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await frame.locator('#source').textContent(), saved);
        assert.match(await frame.locator('#toc').innerText(), /Host saved title section/);
        await host.emulateMedia({ colorScheme: 'dark' });
        await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark', undefined, { timeout });
        assert.equal(await frame.locator('#source').textContent(), saved);
        assert.doesNotMatch(await frame.locator('#content').innerText(), /HOST_ORIGINAL_CONTENT/);
        const nextSaved = markdown('Host later saved title', 'HOST_LATER_SAVED_CONTENT');
        await fs.writeFile(document.file, nextSaved);
        await waitForDocument(frame, nextSaved, 'Host later saved title');
        assert.equal(await frame.locator('#error').isVisible(), false);
      });
      return { lowerHostRevisionDiscarded: true, themeCannotRestoreOldContent: true, laterRealSaveRefreshes: true };
    });

    await check('Page hide stops pending refreshes and page show resumes polling the current document', async () => {
      const document = await openDocument('page-lifecycle', markdown('Lifecycle title', 'LIFECYCLE_ORIGINAL_CONTENT'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        const saved = markdown('Lifecycle saved title', 'LIFECYCLE_HELD_SAVED_CONTENT');
        await host.evaluate(() => { window.__holdMarker = 'LIFECYCLE_HELD_SAVED_CONTENT'; });
        await fs.writeFile(document.file, saved);
        await host.waitForFunction(() => window.__heldRefresh !== null, undefined, { timeout });
        await frame.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        const callsAtHide = session.calls.length;
        await host.evaluate(() => {
          const held = window.__heldRefresh;
          document.querySelector('iframe').contentWindow.postMessage({ jsonrpc: '2.0', id: held.id, result: held.result }, '*');
          window.__heldRefresh = null;
        });
        // More than two normal polling intervals proves that a pending response cannot rearm the timer.
        await host.waitForTimeout(2200);
        assert.equal(session.calls.length, callsAtHide, 'A hidden page must not retain or rearm its polling timer');
        assert.equal(await frame.locator('#source').textContent(), document.output.text,
          'An in-flight response arriving after pagehide must be ignored');
        await frame.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await waitForDocument(frame, saved, 'Lifecycle saved title');
        assert.ok(session.calls.length > callsAtHide, 'Page show must resume queries');
        assert.equal(await frame.locator('#error').isVisible(), false);
      });
      return { inFlightResponseIgnoredAfterPageHide: true, noPollingAfterPageHide: true, pageShowResumesUpdates: true };
    });

    await check('A hidden page accepts a new document and theme without restarting refresh until page show', async () => {
      const first = await openDocument('hidden-first', markdown('Hidden first title', 'HIDDEN_FIRST_CONTENT'));
      const second = await openDocument('hidden-second', markdown('Hidden second title', 'HIDDEN_SECOND_CONTENT'));
      await withViewer(first, {}, async ({ host, frame, session }) => {
        await frame.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        const callsAtHide = session.calls.length;
        await host.emulateMedia({ colorScheme: 'dark' });
        await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark', undefined, { timeout });
        session.file = second.file;
        await frame.evaluate(output => {
          const globals = { toolOutput: output, toolResponseMetadata: {} };
          Object.assign(window.openai, globals);
          window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
        }, second.output);
        await waitForDocument(frame, second.output.text, 'Hidden second title');
        await assertDocument(frame, second.output);
        await host.waitForTimeout(2200);
        assert.equal(session.calls.length, callsAtHide,
          'Theme changes and document globals must not restart a hidden page\'s polling');

        const saved = markdown('Resumed second title', 'RESUMED_SECOND_CONTENT');
        await fs.writeFile(second.file, saved);
        await frame.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await waitForDocument(frame, saved, 'Resumed second title');
        const resumed = session.calls.slice(callsAtHide);
        assert.ok(resumed.length > 0, 'Page show must resume the latest accepted document');
        assert.ok(resumed.every(call => call.request.name === refreshTool
          && call.request.arguments.watchId === second.output.watchId
          && call.request._meta['openai/resource'].path === second.file));
        assert.equal(await frame.locator('#name').textContent(), second.output.name);
        assert.equal(await frame.locator('#error').isVisible(), false);
      });
      return { hiddenThemeApplied: true, hiddenDocumentAccepted: true, pollingRemainsSuspended: true,
        latestDocumentRefreshesAfterPageShow: true };
    });

    await check('An old refresh arriving after page show cannot roll back content or start a second polling chain', async () => {
      const document = await openDocument('late-after-resume', markdown('Late original title', 'LATE_ORIGINAL_CONTENT'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        const heldText = markdown('Held older title', 'HELD_OLDER_AFTER_RESUME');
        await host.evaluate(() => { window.__holdMarker = 'HELD_OLDER_AFTER_RESUME'; });
        await fs.writeFile(document.file, heldText);
        await host.waitForFunction(() => window.__heldRefresh !== null, undefined, { timeout });
        await frame.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        const latest = markdown('Resumed latest title', 'RESUMED_LATEST_CONTENT');
        await fs.writeFile(document.file, latest);
        await frame.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await waitForDocument(frame, latest, 'Resumed latest title');
        const refreshesBeforeRelease = session.calls.filter(call => call.request.name === refreshTool).length;
        await host.evaluate(() => {
          const held = window.__heldRefresh;
          document.querySelector('iframe').contentWindow.postMessage({ jsonrpc: '2.0', id: held.id, result: held.result }, '*');
          window.__heldRefresh = null;
        });
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await frame.locator('#source').textContent(), latest,
          'The pre-hide response must not replace a newer post-resume snapshot');
        await host.waitForFunction(count => window.__toolResponses >= count + 3, refreshesBeforeRelease, { timeout });
        const following = session.calls.filter(call => call.request.name === refreshTool).slice(refreshesBeforeRelease);
        assert.ok(following.length >= 3, 'The resumed document must continue refreshing');
        const intervals = following.slice(1).map((call, index) => call.requestedAt - following[index].requestedAt);
        assert.ok(intervals.every(interval => interval >= 850),
          'The old response must not introduce a duplicate polling chain: ' + JSON.stringify(intervals));
        assert.equal(await frame.locator('#source').textContent(), latest);
        assert.equal(await frame.locator('#error').isVisible(), false);
        assert.equal(await frame.locator('#status').isVisible(), false);
      });
      return { oldResponseIgnoredAfterResume: true, latestContentRetained: true, singlePollingChain: true };
    });

    await check('An expired-watch reopen arriving after a document switch cannot replace the new document', async () => {
      const first = await openDocument('reopen-old', markdown('Reopen old title', 'REOPEN_OLD_CONTENT'));
      const second = await openDocument('reopen-new', markdown('Reopen new title', 'REOPEN_NEW_CONTENT'));
      await withViewer(first, { expireFirstRefresh: true }, async ({ host, frame, session }) => {
        await host.evaluate(() => { window.__holdReopen = true; });
        await host.waitForFunction(() => window.__heldReopen !== null, undefined, { timeout });
        session.file = second.file;
        await frame.evaluate(output => {
          const globals = { toolOutput: output, toolResponseMetadata: {} };
          Object.assign(window.openai, globals);
          window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals } }));
        }, second.output);
        await waitForDocument(frame, second.output.text, 'Reopen new title');
        await host.evaluate(() => {
          const held = window.__heldReopen;
          document.querySelector('iframe').contentWindow.postMessage({ jsonrpc: '2.0', id: held.id, result: held.result }, '*');
          window.__heldReopen = null;
        });
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await assertDocument(frame, second.output);
        const saved = markdown('Reopen new saved title', 'REOPEN_NEW_SAVED_CONTENT');
        await fs.writeFile(second.file, saved);
        await waitForDocument(frame, saved, 'Reopen new saved title');
        assert.ok(session.calls.some(call => call.request.name === refreshTool
          && call.request.arguments.watchId === second.output.watchId
          && call.result.structuredContent?.document?.text === saved));
        assert.equal(await frame.locator('#error').isVisible(), false);
        assert.equal(await frame.locator('#status').isVisible(), false);
      });
      return { realReopenHeldInFlight: true, switchedDocumentRetained: true, newDocumentContinuesRefreshing: true };
    });

    await check('Unchanged refreshes omit document payloads and preserve the visible DOM', async () => {
      const document = await openDocument('unchanged', markdown('Unchanged title', 'UNCHANGED_CONTENT'));
      await withViewer(document, {}, async ({ host, frame, session }) => {
        await frame.locator('#content p').first().evaluate(node => { node.dataset.liveTestSentinel = 'same-node'; });
        await host.waitForFunction(() => window.__toolResponses >= 2, undefined, { timeout });
        assert.ok(session.calls.length >= 2);
        for (const { result } of session.calls) {
          assert.equal(result.isError, undefined);
          assert.equal(result.structuredContent.watchId, document.output.watchId);
          assert.equal(result.structuredContent.revision, document.output.revision);
          assert.equal(result.structuredContent.document, undefined);
        }
        assert.equal(await frame.locator('#content p').first().getAttribute('data-live-test-sentinel'), 'same-node');
        assert.equal(await frame.locator('#source').textContent(), document.output.text);
      });
      return { unchangedResponsesAreSmall: true, noRedundantDomReplacement: true };
    });

    await check('No uncaught browser errors', async () => { assert.deepEqual(pageErrors, []); });
  } finally {
    await browser?.close();
    await client.close();
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ results, pageErrors }, null, 2));
    await fs.writeFile(path.join(directory, 'server.log'), serverLog.join(''));
    for (const result of results.filter(result => !result.pass)) console.log('DETAIL: ' + result.name + '\n' + result.error);
    console.log('Artifacts: ' + directory);
    if (results.some(result => !result.pass)) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
