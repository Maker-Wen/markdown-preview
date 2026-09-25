'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { render, viewerHtml } = require('./render.cjs');

(async () => {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '../tests/reader.md'));
  const text = await fs.readFile(file, 'utf8');
  const rendered = await render(file, text);
  const output = { name: path.basename(file), resourceUri: 'codex-resource://browser-a', bytes: Buffer.byteLength(text), text, ...rendered };
  const template = await viewerHtml();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'md-viewer-browser-'));
  const results = [], requests = [], pageErrors = [];
  let browser;
  const bootstrap = value => template.replace('<script>', () => '<script>window.openai=' + JSON.stringify({ toolOutput: value }).replace(/</g, '\\u003c') + ';</script><script>');
  const event = (page, globals) => page.evaluate(value => {
    Object.assign(window.openai, value);
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: value } }));
  }, globals);
  const check = async (name, run) => {
    try { const evidence = await run(); results.push({ name, pass: true, evidence }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
    console.log((results.at(-1).pass ? 'PASS' : 'FAIL') + ': ' + name);
  };
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', offline: true });
    await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setContent(bootstrap(output), { waitUntil: 'load' });
    await check('Mermaid renders as SVG', async () => {
      await page.locator('#content .mermaid svg').waitFor({ timeout: 20000 });
      assert.match(await page.locator('#content .mermaid').innerText(), /点击 Markdown 文件/);
      return { svgCount: await page.locator('#content .mermaid svg').count() };
    });
    await check('KaTeX uses loaded embedded fonts', async () => {
      const info = await page.evaluate(async () => {
        await document.fonts.ready;
        const node = document.querySelector('.katex .mathnormal');
        return { count: document.querySelectorAll('.katex').length, family: node && getComputedStyle(node).fontFamily,
          loaded: [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family),
          mathLoaded: document.fonts.check('16px KaTeX_Math'), mainLoaded: document.fonts.check('16px KaTeX_Main') };
      });
      assert.ok(info.count >= 2); assert.match(info.family, /KaTeX_Math/);
      assert.ok(info.loaded.includes('KaTeX_Math')); assert.ok(info.loaded.includes('KaTeX_Main'));
      assert.ok(info.mathLoaded && info.mainLoaded); return info;
    });
    await check('Syntax highlight and task checkboxes', async () => {
      assert.ok(await page.locator('#content pre .token.keyword').count() > 0);
      const boxes = await page.locator('#content input[type=checkbox]').evaluateAll(nodes => nodes.map(node => node.disabled));
      assert.equal(boxes.length, 4); assert.ok(boxes.every(Boolean)); return { disabledCheckboxes: boxes.length };
    });
    await page.screenshot({ path: path.join(directory, 'desktop-top.png') });
    await check('TOC navigates to final section', async () => {
      const link = page.locator('#toc a').filter({ hasText: '最后一节' });
      await link.click();
      await page.waitForFunction(() => {
        const heading = [...document.querySelectorAll('#content h2')].find(node => node.textContent.includes('最后一节'));
        const rect = heading.getBoundingClientRect(), bounds = document.getElementById('main').getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      });
      const info = await page.evaluate(() => {
        const main = document.getElementById('main');
        const heading = [...document.querySelectorAll('#content h2')].find(node => node.textContent.includes('最后一节'));
        const rect = heading.getBoundingClientRect(), bounds = main.getBoundingClientRect();
        return { scroll: main.scrollTop, top: rect.top, bottom: rect.bottom, mainTop: bounds.top, mainBottom: bounds.bottom };
      });
      assert.ok(info.top >= info.mainTop && info.bottom <= info.mainBottom); return info;
    });
    await page.screenshot({ path: path.join(directory, 'desktop-math.png') });
    await check('Source toggle preserves exact Markdown', async () => {
      await page.locator('#toggle-source').click();
      assert.equal(await page.locator('#source').textContent(), text);
      assert.equal(await page.locator('#source').isVisible(), true);
      assert.equal(await page.locator('#content').isVisible(), false);
      await page.locator('#toggle-source').click();
      assert.equal(await page.locator('#content').isVisible(), true);
    });
    await check('Light, dark and system themes rerender diagram', async () => {
      await page.locator('#theme').selectOption('dark');
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.querySelector('#content .mermaid svg'));
      assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(23, 26, 32)');
      assert.equal(await page.locator('#content pre').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 36, 43)');
      assert.equal(await page.locator('#content pre code').first().evaluate(node => getComputedStyle(node).color), 'rgb(226, 232, 240)');
      await page.locator('#theme').selectOption('light');
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.querySelector('#content .mermaid svg'));
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.locator('#theme').selectOption('system');
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.querySelector('#content .mermaid svg'));
      await page.screenshot({ path: path.join(directory, 'desktop-dark.png') });
    });
    await check('TOC visibility toggle', async () => {
      await page.locator('#toggle-toc').click(); assert.equal(await page.locator('aside').isVisible(), false);
      assert.equal(await page.locator('#toggle-toc').getAttribute('aria-expanded'), 'false');
      await page.locator('#toggle-toc').click(); assert.equal(await page.locator('aside').isVisible(), true);
    });
    await check('Theme change in source mode preserves diagram layout', async () => {
      await page.locator('#toggle-source').click();
      try {
        await page.locator('#theme').selectOption('light');
      } finally { await page.locator('#toggle-source').click(); }
      await page.waitForFunction(() => document.querySelector('#content .mermaid svg')?.viewBox.baseVal.width > 100, null, { timeout: 10000 });
      const viewBox = await page.locator('#content .mermaid svg').getAttribute('viewBox');
      assert.ok(Number(viewBox.split(' ')[2]) > 100, 'Diagram collapsed to viewBox ' + viewBox);
      return { viewBox };
    });
    await check('Two document updates do not mix content', async () => {
      const secondText = '# Browser document B\n\nUNIQUE_BROWSER_DOCUMENT_B\n\n## Final B\n';
      const second = { name: 'Browser document B.md', resourceUri: 'codex-resource://browser-b', text: secondText,
        bytes: Buffer.byteLength(secondText), ...await render(file, secondText) };
      await event(page, { toolOutput: second, toolResponseMetadata: {} });
      assert.equal(await page.locator('#name').textContent(), second.name);
      assert.match(await page.locator('#content').innerText(), /UNIQUE_BROWSER_DOCUMENT_B/);
      assert.doesNotMatch(await page.locator('#content').innerText(), /增强预览测试/);
      assert.equal(await page.locator('#main').evaluate(node => node.scrollTop), 0);
      assert.equal(await page.locator('#source').textContent(), secondText);
      assert.match(await page.locator('#toc').innerText(), /Final B/);
      await event(page, { toolOutput: output, toolResponseMetadata: {} });
      await page.locator('#content .mermaid svg').waitFor();
      assert.doesNotMatch(await page.locator('#content').innerText(), /UNIQUE_BROWSER_DOCUMENT_B/);
      assert.equal(await page.locator('#source').textContent(), text);
      await page.evaluate(({ first, second }) => {
        for (const toolOutput of [first, second]) {
          window.openai.toolOutput = toolOutput;
          window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput } } }));
        }
      }, { first: output, second });
      await page.waitForTimeout(250);
      assert.match(await page.locator('#content').innerText(), /UNIQUE_BROWSER_DOCUMENT_B/);
      assert.equal(await page.locator('#content svg').count(), 0);
    });
    await check('Error output clears previous document', async () => {
      await event(page, { toolResponseMetadata: { status: 'error' }, toolOutput: { error: 'TEST_READ_FAILURE' } });
      assert.equal(await page.locator('#error').innerText(), 'TEST_READ_FAILURE');
      assert.equal(await page.locator('#status').innerText(), '读取失败');
      assert.equal(await page.locator('#content').innerText(), '');
      assert.equal(await page.locator('#source').textContent(), '');
      assert.equal(await page.locator('#toc').innerText(), '');
    });
    await check('Theme change cannot restore stale document after error', async () => {
      await page.locator('#theme').selectOption('light');
      assert.equal(await page.locator('#content').innerText(), '');
      assert.equal(await page.locator('#error').innerText(), 'TEST_READ_FAILURE');
    });
    await check('Recovery accepts next successful document', async () => {
      await event(page, { toolResponseMetadata: {}, toolOutput: output });
      await page.locator('#content .mermaid svg').waitFor();
      assert.equal(await page.locator('#error').isVisible(), false);
      assert.equal(await page.locator('#name').textContent(), output.name);
    });
    await check('Output-only error cannot restore stale document on theme change', async () => {
      await event(page, { toolResponseMetadata: {}, toolOutput: { error: 'OUTPUT_ONLY_FAILURE' } });
      await page.locator('#theme').selectOption('dark');
      assert.equal(await page.locator('#content').innerText(), '');
      assert.equal(await page.locator('#error').innerText(), 'OUTPUT_ONLY_FAILURE');
    });
    await check('Malformed document output clears the previous document', async () => {
      await event(page, { toolResponseMetadata: {}, toolOutput: output });
      await page.locator('#content .mermaid svg').waitFor();
      await event(page, { toolResponseMetadata: {}, toolOutput: { ...output, html: undefined } });
      assert.equal(await page.locator('#status').innerText(), '读取失败');
      assert.match(await page.locator('#error').innerText(), /无效的文档内容/);
      assert.equal(await page.locator('#content').innerText(), '');
      assert.equal(await page.locator('#source').textContent(), '');
      assert.equal(await page.locator('#toc').innerText(), '');
      await page.locator('#theme').selectOption('light');
      assert.equal(await page.locator('#content').innerText(), '');
    });
    await check('Authored source/detail headings cannot replace UI controls', async () => {
      const collisionText = '# source\n\nCOLLISION_DOCUMENT_ONLY\n\n## detail\n\n<script>window.__markdown_script_executed = true</script>\n\n<img src="https://example.invalid/probe.png" onerror="window.__markdown_script_executed = true">\n';
      const collision = { name: 'Collision document.md', resourceUri: 'codex-resource://browser-collision', text: collisionText,
        bytes: Buffer.byteLength(collisionText), ...await render(file, collisionText) };
      await event(page, { toolResponseMetadata: {}, toolOutput: collision });
      assert.equal((await page.locator('article h1#source').innerText()).trim(), 'source');
      assert.equal((await page.locator('article h2#detail').innerText()).trim(), 'detail');
      await page.locator('#toggle-source').click();
      try {
        assert.equal(await page.locator('pre#source').textContent(), collisionText);
        assert.equal(await page.locator('pre#source').isVisible(), true);
        assert.equal(await page.locator('article#content').isVisible(), false);
      } finally { await page.locator('#toggle-source').click(); }
      await page.locator('#toc a').filter({ hasText: 'detail' }).click();
      assert.equal(await page.locator('article#content').isVisible(), true);
      assert.equal(await page.evaluate(() => window.__markdown_script_executed), undefined);
      assert.equal(await page.locator('#content script, #content img[onerror]').count(), 0);
      assert.match(await page.locator('main > div#detail').innerText(), /字节/);
    });
    await check('Narrow viewport remains usable', async () => {
      const narrow = await context.newPage();
      narrow.on('pageerror', error => pageErrors.push(error.message));
      await narrow.setViewportSize({ width: 390, height: 844 });
      await narrow.setContent(bootstrap(output), { waitUntil: 'load' });
      await narrow.locator('#content .mermaid svg').waitFor();
      assert.equal(await narrow.locator('aside').isVisible(), false);
      let size = await narrow.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, mainHeight: document.getElementById('main').clientHeight }));
      assert.ok(size.documentWidth <= size.width); assert.ok(size.mainHeight > 500);
      await narrow.locator('#toggle-toc').click(); assert.equal(await narrow.locator('aside').isVisible(), true);
      await narrow.locator('#toc a').filter({ hasText: '最后一节' }).click();
      await narrow.waitForFunction(() => document.getElementById('main').scrollTop > 0);
      await narrow.screenshot({ path: path.join(directory, 'narrow.png') });
      await narrow.close(); return size;
    });
    await check('Partitioned source preserves newlines and exact selected copying', async () => {
      const samples = ['', '\n', 'a\n\n\nb', 'a\r\n\r\nb\r\n', 'a\rb', '中文🦊\n\n尾部\n', '单行'.repeat(1000)];
      for (const sourceText of samples) {
        await event(page, { toolResponseMetadata: {}, toolOutput: { name: 'source.md', resourceUri: 'codex-resource://source-copy',
          text: sourceText, bytes: Buffer.byteLength(sourceText), html: '<h1 id="copy-outside">Outside source</h1>', toc: '' } });
        if (!await page.locator('#source').isVisible()) await page.locator('#toggle-source').click();
        assert.equal(await page.locator('#source').textContent(), sourceText);
        if (!sourceText.length) continue;
        for (const [start, end] of [[0, sourceText.length], [1, sourceText.length - 1]].filter(([a, b]) => a < b)) {
          const copied = await page.evaluate(({ start, end }) => {
            const source = document.getElementById('source');
            const boundary = offset => {
              const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
              for (let node; node = walker.nextNode();) {
                if (offset <= node.length) return [node, offset];
                offset -= node.length;
              }
              return [source, source.childNodes.length];
            };
            const range = document.createRange(); range.setStart(...boundary(start)); range.setEnd(...boundary(end));
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
            let copied;
            const event = new Event('copy', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'clipboardData', { value: { setData: (type, text) => { if (type === 'text/plain') copied = text; } } });
            document.dispatchEvent(event); selection.removeAllRanges();
            return { text: copied, handled: event.defaultPrevented };
          }, { start, end });
          assert.equal(copied.text, sourceText.slice(start, end)); assert.equal(copied.handled, true);
        }
      }
      await page.locator('#toggle-source').click();
      const outsideHandled = await page.evaluate(() => {
        const range = document.createRange(); range.selectNodeContents(document.getElementById('content'));
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const event = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: { setData: () => {} } });
        document.dispatchEvent(event); selection.removeAllRanges(); return event.defaultPrevented;
      });
      assert.equal(outsideHandled, false);
      return { samples: samples.length, exactSourceAndSelections: true, outsideCopyUnchanged: true };
    });
    await check('Local and web links use the host bridge and surface failures', async () => {
      const linkText = '# 链接检查\n\n[相对文件](<./中文 空格%23.md>)\n\n[绝对文件](/private/tmp/result.json)\n\n[图片](/private/tmp/image.jpg)\n\n[代码](/private/tmp/check.cjs)\n\n[网页](https://example.com/)\n\n[HTTP](http://localhost:8000/)\n\n[邮件](mailto:user@example.com)\n\n[锚点](#终点)\n\n[禁止](ftp://example.com/file)\n\n## 终点\n';
      const linkOutput = { name: 'links.md', resourceUri: 'codex-resource://links', text: linkText,
        bytes: Buffer.byteLength(linkText), ...await render(file, linkText) };
      const host = await context.newPage();
      host.on('pageerror', error => pageErrors.push(error.message));
      try {
        await host.setContent('<iframe style="width:100%;height:850px;border:0"></iframe>');
        await host.evaluate(html => {
          const frame = document.querySelector('iframe');
          window.requests = [];
          window.capabilities = { experimental: { 'openai/files': {} }, openLinks: {} };
          window.addEventListener('message', event => {
            if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
            const message = event.data;
            window.requests.push(message);
            if (!message.id) return;
            if (window.hold && message.method === 'openai/files/open') { window.held = message; return; }
            const result = message.method === 'ui/initialize'
              ? { protocolVersion: '2026-01-26', hostInfo: { name: 'offline-test', version: '1' },
                hostCapabilities: window.capabilities, hostContext: {} } : {};
            const reply = window.rejectNext && message.method !== 'ui/initialize'
              ? { error: { code: -32000, message: 'TEST_OPEN_FAILED' } } : { result };
            window.rejectNext = false;
            frame.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, ...reply }, '*');
          });
          frame.srcdoc = html;
        }, bootstrap(linkOutput));
        const frame = host.frameLocator('iframe');
        const body = frame.locator('body');
        await frame.locator('#status').filter({ hasText: '增强阅读' }).waitFor();
        assert.deepEqual(await host.evaluate(() => window.requests), []);
        await frame.locator('#content a').filter({ hasText: '锚点' }).click();
        assert.deepEqual(await host.evaluate(() => window.requests), []);
        const targets = [['相对文件', path.join(path.dirname(file), '中文 空格#.md')],
          ['绝对文件', '/private/tmp/result.json'], ['图片', '/private/tmp/image.jpg'], ['代码', '/private/tmp/check.cjs']];
        for (const [label, expected] of targets) {
          await frame.locator('#content a').filter({ hasText: label }).click();
          await host.waitForFunction(value => window.requests.some(r => r.method === 'openai/files/open' && r.params.path === value), expected);
        }
        for (const [label, expected] of [['网页', 'https://example.com/'], ['HTTP', 'http://localhost:8000/'], ['邮件', 'mailto:user@example.com']]) {
          await frame.locator('#content a').filter({ hasText: label }).click();
          await host.waitForFunction(value => window.requests.some(r => r.method === 'ui/open-link' && r.params.url === value), expected);
        }
        const messages = await host.evaluate(() => window.requests);
        assert.deepEqual(messages.slice(0, 3).map(m => m.method), ['ui/initialize', 'ui/notifications/initialized', 'openai/files/open']);
        assert.equal(messages.filter(m => m.method === 'ui/initialize').length, 1);
        await host.evaluate(() => { window.rejectNext = true; });
        await frame.locator('#content a').filter({ hasText: '绝对文件' }).click();
        await frame.locator('#error').filter({ hasText: 'TEST_OPEN_FAILED' }).waitFor();
        await frame.locator('#content a').filter({ hasText: '禁止' }).click();
        await frame.locator('#error').filter({ hasText: '暂不支持此链接类型' }).waitFor();
        // A JSON-RPC reply from the app itself must not impersonate its parent host.
        await host.evaluate(() => { window.hold = true; });
        await body.evaluate(() => {
          window.probeSettled = false;
          window.markdownHost.openFile('/private/tmp/probe.md').then(() => { window.probeSettled = true; });
        });
        await host.waitForFunction(() => window.held);
        const held = await host.evaluate(() => window.held);
        await body.evaluate((_, id) => { window.postMessage({ jsonrpc: '2.0', id, result: {} }, '*'); }, held.id);
        await body.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await body.evaluate(() => window.probeSettled), false);
        await host.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ jsonrpc: '2.0', id: window.held.id, result: {} }, '*'));
        await body.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        assert.equal(await body.evaluate(() => window.probeSettled), true);
        // A new app instance must explain absent file-opening support without navigating away.
        await host.evaluate(html => {
          window.capabilities = { openLinks: {} }; window.requests = []; window.hold = false;
          document.querySelector('iframe').srcdoc = html;
        }, bootstrap(linkOutput));
        await frame.locator('#content a').filter({ hasText: '绝对文件' }).click();
        await frame.locator('#error').filter({ hasText: '不支持从预览打开本地文件' }).waitFor();
        assert.equal(await host.evaluate(() => window.requests.some(m => m.method === 'openai/files/open')), false);
        assert.equal(await frame.locator('#source').textContent(), linkText);
        return { fileLinks: targets.length, webLinks: 3, errorsVisible: true, parentValidated: true };
      } finally { await host.close(); }
    });
    await check('Self-contained UI makes no network requests', async () => { assert.deepEqual(requests, []); });
    await check('No uncaught browser errors', async () => { assert.deepEqual(pageErrors, []); });
  } finally {
    await browser?.close();
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ file, results, requests, pageErrors }, null, 2));
    for (const result of results.filter(item => !item.pass)) console.log('DETAIL: ' + result.name + ': ' + result.error);
    console.log('Artifacts: ' + directory);
    if (results.some(result => !result.pass)) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
