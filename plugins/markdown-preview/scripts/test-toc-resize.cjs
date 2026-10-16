'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { render, viewerHtml } = require('./render.cjs');
const { createDocumentWatches } = require('./watch.cjs');
const { createBrowserPreviews } = require('./browser-preview.cjs');
const { buildBrowserHtml } = require('./browser-html.cjs');

const timeout = 15000;
const closeTo = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 2,
  `${message}: expected ${expected}, received ${actual}`);
const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
const markdown = '# Resizable document\n\n' + Array.from({ length: 45 }, (_, index) =>
  `## Section ${index} with a long title that wraps in a narrow table of contents\n\n`
  + `Paragraph ${index} keeps both the document and its table of contents scrollable.\n\n`).join('');

(async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-toc-test-')));
  const file = path.join(directory, 'toc-resize.md');
  await fs.writeFile(file, markdown);
  const output = { name: path.basename(file), resourceUri: 'codex-resource://toc-resize',
    text: markdown, bytes: Buffer.byteLength(markdown), ...await render(file, markdown) };
  const template = await viewerHtml();
  const watches = createDocumentWatches({ render });
  const previews = createBrowserPreviews({ watches, buildHtml: buildBrowserHtml, openBrowser: async () => {} });
  const results = [], pageErrors = [];
  let browser;

  const check = async (name, run) => {
    try { results.push({ name, pass: true, evidence: await run() }); }
    catch (error) { results.push({ name, pass: false, error: error.stack }); }
    console.log((results.at(-1).pass ? 'PASS: ' : 'FAIL: ') + name);
  };
  const width = view => view.locator('aside').evaluate(node => node.getBoundingClientRect().width);
  const waitWidth = (view, expected) => view.waitForFunction(expected =>
    Math.abs(document.querySelector('aside').getBoundingClientRect().width - expected) < 2,
  expected, { timeout });
  const visible = (view, expected) => view.waitForFunction(expected =>
    document.getElementById('toggle-toc').getAttribute('aria-expanded') === String(expected),
  expected, { timeout });
  const geometry = view => view.evaluate(() => Object.fromEntries([
    ['reader', '#reader'], ['toc', 'aside'], ['resizer', '#toc-resizer'], ['main', '#main'],
  ].map(([name, selector]) => {
    const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect();
    return [name, { x, y, width, height, right, bottom }];
  })));
  const beginDrag = async (page, view) => {
    const handle = await view.locator('#toc-resizer').boundingBox();
    assert.ok(handle && handle.width > 0, 'The expanded desktop separator must be visible');
    const startWidth = await width(view);
    const point = { x: handle.x + handle.width / 2, y: handle.y + Math.min(handle.height / 2, 100) };
    await view.evaluate(() => document.addEventListener('pointerdown', event => {
      window.__testPointerId = event.pointerId;
    }, { capture: true, once: true }));
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    return {
      move: target => page.mouse.move(point.x + target - startWidth, point.y, { steps: 5 }),
      release: () => page.mouse.up(),
    };
  };
  const resize = async (page, view, target) => {
    const drag = await beginDrag(page, view);
    await drag.move(target);
    await waitWidth(view, target);
    await drag.release();
  };
  const publish = (view, value) => view.evaluate(output => {
    window.openai.toolOutput = output;
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: output } } }));
  }, value);

  const withEmbedded = async run => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, colorScheme: 'light' });
    const host = await context.newPage();
    host.on('pageerror', error => pageErrors.push(error.message));
    const calls = [], urls = [];
    await host.exposeFunction('__testTool', async params => {
      calls.push(params);
      assert.equal(params.name, 'markdown_preview_open_browser');
      const opened = await previews.open({ path: file, name: output.name, resourceUri: output.resourceUri },
        params.arguments.preferences);
      urls.push(opened.url);
      return { structuredContent: opened };
    });
    const html = template.replace('<script>', () => '<script>window.openai=' + scriptJson({ toolOutput: output })
      + ';</script><script>');
    // The offset leaves real host-owned space to drag into outside the iframe.
    const hostHtml = '<!doctype html><meta charset="utf-8"><style>body{margin:0}iframe{position:absolute;left:80px;top:60px;'
      + 'width:1100px;height:850px;border:0}</style><iframe title="Markdown Preview"></iframe><script>'
      + 'const frame=document.querySelector("iframe");window.addEventListener("message",async event=>{'
      + 'const message=event.data;if(event.source!==frame.contentWindow||message?.jsonrpc!=="2.0"||!message.id)return;'
      + 'try{const result=message.method==="ui/initialize"?{protocolVersion:"2026-01-26",'
      + 'hostInfo:{name:"resize-test-host",version:"1.0.0"},hostCapabilities:{serverTools:{}}}'
      + ':await window.__testTool(message.params);'
      + 'frame.contentWindow.postMessage({jsonrpc:"2.0",id:message.id,result},"*");}'
      + 'catch(error){frame.contentWindow.postMessage({jsonrpc:"2.0",id:message.id,'
      + 'error:{code:-32603,message:error.message}},"*");}});frame.srcdoc=' + scriptJson(html) + ';</script>';
    await context.route('https://toc-resize.test/**', route => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: hostHtml,
    }));
    try {
      await host.goto('https://toc-resize.test/');
      const frame = await (await host.locator('iframe').elementHandle()).contentFrame();
      await frame.locator('#content h1').waitFor({ timeout });
      const setWidth = async value => {
        await host.locator('iframe').evaluate((node, width) => { node.style.width = width + 'px'; }, value);
        await frame.waitForFunction(width => innerWidth === width, value, { timeout });
      };
      await run({ host, frame, context, calls, urls, setWidth });
    } finally { await context.close(); }
  };

  try {
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });

    await check('Desktop separator resizes live beyond 400px without covering the TOC scrollbar', async () => {
      await withEmbedded(async ({ host, frame }) => {
        await waitWidth(frame, 200);
        assert.equal(await frame.locator('#toc-resizer').getAttribute('role'), 'separator');
        assert.equal(await frame.locator('#toc-resizer').getAttribute('aria-orientation'), 'vertical');
        const before = await geometry(frame);
        assert.ok(before.resizer.width >= 6, 'The thin divider needs a usable pointer target');
        assert.ok(before.resizer.x >= before.toc.right - 1, 'The divider must not cover the TOC scrollbar');
        const textLeft = await frame.locator('#content').evaluate(node =>
          node.getBoundingClientRect().x + parseFloat(getComputedStyle(node).paddingLeft));
        assert.ok(textLeft >= before.resizer.right, 'The divider must stay clear of article text');
        assert.equal(await frame.evaluate(() => {
          const aside = document.querySelector('aside'), box = aside.getBoundingClientRect();
          return document.elementFromPoint(box.right - 2, box.y + box.height / 2)?.id === 'toc-resizer';
        }), false);
        const drag = await beginDrag(host, frame);
        await drag.move(530);
        await waitWidth(frame, 530); // Assert before pointerup: layout follows the pointer in real time.
        const during = await geometry(frame);
        assert.ok(during.main.width < before.main.width - 300);
        await drag.release();
        await host.screenshot({ path: path.join(directory, 'embedded-expanded.png') });
        await frame.locator('aside').evaluate(node => { node.scrollTop = 200; });
        assert.ok(await frame.locator('aside').evaluate(node => node.scrollTop > 0));
        closeTo(await width(frame), 530, 'Scrolling the TOC preserves its width');
      });
      return { defaultWidth: 200, testedWidth: 530, liveLayout: true, separateScrollbarTarget: true };
    });

    await check('One captured drag can collapse beyond the iframe edge and reverse to reopen', async () => {
      await withEmbedded(async ({ host, frame }) => {
        await resize(host, frame, 360);
        const drag = await beginDrag(host, frame);
        await drag.move(-35); // Pointer leaves the embedded surface into the surrounding host.
        await visible(frame, false);
        assert.equal(await frame.locator('#toc-resizer').isVisible(), false);
        await host.screenshot({ path: path.join(directory, 'embedded-collapsed.png') });
        await drag.move(90);
        assert.equal(await frame.locator('#toggle-toc').getAttribute('aria-expanded'), 'false',
          'The reopen threshold must avoid flicker near the collapsed edge');
        await drag.move(300);
        await visible(frame, true);
        await waitWidth(frame, 300);
        await drag.release();
        assert.equal(await frame.locator('#reader').getAttribute('data-toc-resizing'), null);
      });
      return { realPointerCapture: true, crossedIframeBoundary: true, reversedBeforeRelease: true };
    });

    await check('Completed collapse removes the edge target and the button restores the pre-drag width', async () => {
      await withEmbedded(async ({ host, frame }) => {
        await resize(host, frame, 380);
        const drag = await beginDrag(host, frame);
        await drag.move(40);
        await visible(frame, false);
        await drag.release();
        assert.equal(await frame.locator('#toc-resizer').isVisible(), false);
        const hidden = await geometry(frame);
        closeTo(hidden.main.width, hidden.reader.width, 'Collapsed TOC gives all available space to the document');
        assert.equal(await frame.evaluate(() => document.elementFromPoint(1,
          document.getElementById('reader').getBoundingClientRect().y + 30)?.id === 'toc-resizer'), false);
        const bounds = await frame.locator('#reader').boundingBox();
        await host.mouse.move(bounds.x + 1, bounds.y + 100);
        await host.mouse.down();
        await host.mouse.move(bounds.x + 300, bounds.y + 100);
        await host.mouse.up();
        await visible(frame, false);
        await frame.locator('#toggle-toc').click();
        await waitWidth(frame, 380);
        await frame.locator('#toggle-toc').click();
        await frame.locator('#toggle-toc').click();
        await waitWidth(frame, 380);
      });
      return { noCollapsedHotspot: true, restoredWidth: 380 };
    });

    await check('Pointer cancellation, Escape, and focus loss restore the drag starting state', async () => {
      await withEmbedded(async ({ host, frame }) => {
        await resize(host, frame, 350);
        for (const reason of ['pointercancel', 'lostpointercapture', 'escape', 'blur']) {
          const drag = await beginDrag(host, frame);
          await drag.move(reason === 'escape' ? 40 : 490);
          if (reason === 'pointercancel' || reason === 'lostpointercapture') await frame.evaluate(type =>
            document.getElementById('reader').dispatchEvent(new PointerEvent(type,
              { bubbles: true, pointerId: window.__testPointerId })), reason);
          else if (reason === 'escape') await host.keyboard.press('Escape');
          else await frame.evaluate(() => window.dispatchEvent(new Event('blur')));
          await drag.release();
          await visible(frame, true);
          await waitWidth(frame, 350);
          assert.equal(await frame.locator('#reader').getAttribute('data-toc-resizing'), null, reason);
          assert.equal(await frame.locator('#toggle-toc').getAttribute('aria-expanded'), 'true', reason);
        }
        await resize(host, frame, 410);
      });
      return { canceledBy: ['pointercancel', 'lostpointercapture', 'Escape', 'blur'], nextDragWorks: true };
    });

    await check('Content updates, theme changes, and source mode retain width; another resource resets it', async () => {
      await withEmbedded(async ({ host, frame }) => {
        await resize(host, frame, 425);
        await frame.locator('#toggle-source').click();
        const nextText = markdown + '\nSAME_DOCUMENT_UPDATED\n';
        const update = { ...output, text: nextText, bytes: Buffer.byteLength(nextText), ...await render(file, nextText) };
        await publish(frame, update);
        await frame.waitForFunction(text => document.getElementById('source').textContent === text, nextText);
        await waitWidth(frame, 425);
        assert.equal(await frame.locator('#source').isVisible(), true);
        await host.emulateMedia({ colorScheme: 'dark' });
        await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        await waitWidth(frame, 425);
        await frame.locator('#toggle-source').click();
        await waitWidth(frame, 425);
        await frame.locator('#toggle-toc').click();
        await publish(frame, { ...update, name: 'another.md', resourceUri: 'codex-resource://another' });
        await frame.locator('#name').filter({ hasText: 'another.md' }).waitFor();
        await visible(frame, false);
        await frame.locator('#toggle-toc').click();
        await waitWidth(frame, 200);
      });
      return { updatesAndThemePreserved: true, sourceModePreserved: true, differentResourceWidth: 200 };
    });

    await check('Viewport constraints and the 700px stacked layout preserve the preferred desktop width', async () => {
      await withEmbedded(async ({ host, frame, setWidth }) => {
        await resize(host, frame, 900);
        await setWidth(760);
        await frame.waitForFunction(() => document.querySelector('aside').getBoundingClientRect().width < 700);
        const clamped = await geometry(frame);
        const constraint = await frame.evaluate(() => ({ readerWidth: document.getElementById('reader').clientWidth,
          cssWidth: document.getElementById('reader').style.getPropertyValue('--toc-width'),
          maximum: document.getElementById('toc-resizer').getAttribute('aria-valuemax') }));
        assert.ok(clamped.main.width >= 119, 'The document retains minimum usable width: '
          + JSON.stringify({ clamped, constraint }));
        assert.ok(clamped.main.right <= clamped.reader.right + 1, 'Columns remain inside the reader');
        const click = await beginDrag(host, frame);
        await click.release(); // A click at the temporary constraint must not replace the preferred width.
        await setWidth(1100);
        await waitWidth(frame, 900);
        await setWidth(700);
        assert.equal(await frame.locator('#toc-resizer').isVisible(), false);
        const stacked = await geometry(frame);
        closeTo(stacked.toc.width, stacked.reader.width, 'Narrow layout keeps the TOC above the document');
        assert.ok(stacked.main.y >= stacked.toc.bottom - 1);
        await host.screenshot({ path: path.join(directory, 'embedded-narrow.png') });
        await setWidth(1100);
        await waitWidth(frame, 900);
        const drag = await beginDrag(host, frame);
        await drag.move(500);
        await setWidth(700);
        await drag.release();
        assert.equal(await frame.locator('#reader').getAttribute('data-toc-resizing'), null);
        await setWidth(1100);
        await waitWidth(frame, 900);
        await frame.locator('#toggle-toc').click();
        await setWidth(700);
        await setWidth(1100);
        await visible(frame, false);
        await frame.locator('#toggle-toc').click();
        await waitWidth(frame, 900);
      });
      return { desktopPreference: 900, temporaryClamp: true, exactBreakpoint: 700, narrowTransitionCancelsDrag: true };
    });

    await check('Keyboard users can resize and collapse the separator without losing a usable focus target', async () => {
      await withEmbedded(async ({ host, frame }) => {
        const separator = frame.getByRole('separator');
        await separator.focus();
        await host.keyboard.press('ArrowRight');
        await waitWidth(frame, 216);
        assert.equal(await separator.getAttribute('aria-valuenow'), '216');
        await host.keyboard.press('Shift+ArrowLeft');
        await waitWidth(frame, 176);
        await host.keyboard.press('End');
        await frame.waitForFunction(() => document.getElementById('toc-resizer').getAttribute('aria-valuenow')
          === document.getElementById('toc-resizer').getAttribute('aria-valuemax'));
        const maximum = await width(frame);
        const bounds = await geometry(frame);
        assert.ok(maximum > 400 && bounds.main.width >= 119);
        await host.keyboard.press('Home');
        await visible(frame, false);
        assert.equal(await frame.evaluate(() => document.activeElement.id), 'toggle-toc');
        await host.keyboard.press('Enter');
        await waitWidth(frame, maximum);
        await separator.focus();
        await host.keyboard.press('Enter');
        await visible(frame, false);
        assert.equal(await frame.evaluate(() => document.activeElement.id), 'toggle-toc');
      });
      return { keyboardResize: true, dynamicMaximum: true, collapseMovesFocusToToolbar: true };
    });

    await check('Width stays out of storage and a reload restores defaults while retaining the visibility preference', async () => {
      await withEmbedded(async ({ host, frame }) => {
        const stored = () => frame.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
        const before = await stored();
        await resize(host, frame, 460);
        assert.deepEqual(await stored(), before, 'Dragging must not write a width preference');
        await frame.locator('#toggle-toc').click();
        assert.equal(await frame.evaluate(() => localStorage.getItem('markdown-preview:toc')), 'hidden');
        await host.reload();
        const reopened = await (await host.locator('iframe').elementHandle()).contentFrame();
        await reopened.locator('#content h1').waitFor({ timeout });
        await visible(reopened, false);
        await reopened.locator('#toggle-toc').click();
        await waitWidth(reopened, 200);
        await resize(host, reopened, 470);
        await host.reload();
        const second = await (await host.locator('iframe').elementHandle()).contentFrame();
        await second.locator('#content h1').waitFor({ timeout });
        await waitWidth(second, 200);
      });
      return { noWidthStorage: true, reloadWidth: 200, visibilityStillPersists: true };
    });

    await check('The real browser bridge starts independently, resizes, and retains width across disk refresh', async () => {
      await withEmbedded(async ({ host, frame, context, calls, urls }) => {
        await resize(host, frame, 410);
        await frame.locator('#open-browser').click();
        await frame.waitForFunction(() => !document.getElementById('open-browser').disabled, undefined, { timeout });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].arguments.preferences, { tocVisible: true },
          'The embedded width must not be transferred to a browser session');
        assert.equal(urls.length, 1);
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(urls[0]);
        await page.locator('#content h1').waitFor({ timeout });
        assert.equal(await page.locator('html').getAttribute('data-surface'), 'browser');
        await waitWidth(page, 200);
        await resize(page, page, 510);
        await page.screenshot({ path: path.join(directory, 'browser-expanded.png') });
        const updated = markdown + '\nBROWSER_DISK_REFRESH\n';
        await fs.writeFile(file, updated);
        await page.waitForFunction(text => document.getElementById('source').textContent === text, updated, { timeout });
        await waitWidth(page, 510);
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        await waitWidth(page, 510);
        const drag = await beginDrag(page, page);
        await drag.move(40);
        await visible(page, false);
        await drag.release();
        await page.locator('#toggle-toc').click();
        await waitWidth(page, 510);
        await page.reload();
        await page.locator('#content h1').waitFor({ timeout });
        await waitWidth(page, 200);
        await waitWidth(frame, 410);
      });
      return { realHttpService: true, actualFileWatch: true, independentWidths: true, browserReloadWidth: 200 };
    });

    await check('Resize scenarios produce no uncaught page errors', async () => {
      assert.deepEqual(pageErrors, []);
      return { pageErrors: 0 };
    });
  } finally {
    await browser?.close();
    await previews.close();
    watches.close();
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ results, pageErrors }, null, 2));
    for (const result of results.filter(result => !result.pass)) console.log('DETAIL: ' + result.name + '\n' + result.error);
    console.log('Artifacts: ' + directory);
    if (results.some(result => !result.pass)) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
