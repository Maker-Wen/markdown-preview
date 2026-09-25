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
