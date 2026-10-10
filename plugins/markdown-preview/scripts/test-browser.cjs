'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { render, viewerHtml } = require('./render.cjs');

(async () => {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '../tests/fixtures/markdown-sample.md'));
  const text = await fs.readFile(file, 'utf8');
  const rendered = await render(file, text);
  const output = { name: path.basename(file), resourceUri: 'codex-resource://browser-a', bytes: Buffer.byteLength(text), text, ...rendered };
  const template = await viewerHtml();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-browser-test-'));
  const profile = path.join(directory, 'preferences-profile');
  const results = [], requests = [], preferenceLoads = [], preferenceRequests = [], pageErrors = [];
  let browser, preferenceContext;
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
  const setSystemTheme = async (page, colorScheme) => {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, colorScheme);
  };
  const observeDiagrams = async page => {
    await page.evaluate(() => {
      const probe = { original: mermaid.run, holdNext: false, runs: [] };
      window.__diagramTest = probe;
      mermaid.run = function (options) {
        const run = { held: probe.holdNext, rendered: false, settled: false };
        probe.holdNext = false;
        probe.runs.push(run);
        run.promise = (async () => {
          try {
            // Keep real SVG rendering; only its completion timing is controlled by the test.
            await probe.original.call(this, options);
            run.rendered = true;
            if (run.held) await new Promise((resolve, reject) => {
              run.release = error => error ? reject(new Error(error)) : resolve();
            });
          } finally { run.settled = true; }
        })();
        return run.promise;
      };
    });
    const waitForContinuation = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const waitForAll = async () => {
      await page.waitForFunction(() => window.__diagramTest.runs.every(run => run.settled));
      // The module's continuation follows the observed Mermaid promise.
      await waitForContinuation();
    };
    return {
      waitForAll,
      waitForLatest: async () => {
        await page.waitForFunction(() => {
          const run = window.__diagramTest.runs.at(-1);
          return run?.settled && !run.held;
        });
        await waitForContinuation();
      },
      holdNext: () => page.evaluate(() => { window.__diagramTest.holdNext = true; }),
      waitForHeld: async () => {
        await page.waitForFunction(() => window.__diagramTest.runs.some(run => run.held && run.rendered && run.release && !run.settled));
        return page.evaluate(() => window.__diagramTest.runs.findIndex(run => run.held && !run.settled));
      },
      release: (index, error) => page.evaluate(({ index, error }) => window.__diagramTest.runs[index].release(error), { index, error }),
      restore: async () => {
        await page.evaluate(async () => {
          const probe = window.__diagramTest;
          for (const run of probe.runs) run.release?.();
          mermaid.run = probe.original;
          await Promise.allSettled(probe.runs.map(run => run.promise));
        });
        await waitForAll();
        await page.evaluate(() => { delete window.__diagramTest; });
      }
    };
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
      assert.match(await page.locator('#content .mermaid').innerText(), /打开 Markdown 文档/);
      return { svgCount: await page.locator('#content .mermaid svg').count() };
    });
    await check('Initial host output can be exposed through inherited getters', async () => {
      const inherited = await context.newPage();
      inherited.on('pageerror', error => pageErrors.push(error.message));
      try {
        const html = template.replace('<script>', () => '<script>const initialHostOutput='
          + JSON.stringify(output).replace(/</g, '\\u003c')
          + ';window.openai=Object.create({get toolOutput(){return initialHostOutput;},'
          + 'get toolResponseMetadata(){return {};}});</script><script>');
        await inherited.setContent(html, { waitUntil: 'load' });
        await inherited.locator('#content .mermaid svg').waitFor({ timeout: 20000 });
        assert.equal(await inherited.locator('#name').textContent(), output.name);
        assert.equal(await inherited.locator('#source').textContent(), text);
        assert.equal(await inherited.locator('#error').isVisible(), false);
        return { initialDocumentRendered: true, inheritedHostGettersSupported: true };
      } finally { await inherited.close(); }
    });
    await check('Reader accepts inputs and opens links through its injected adapter without host globals', async () => {
      const injected = await context.newPage();
      injected.on('pageerror', error => pageErrors.push(error.message));
      const nextText = '# Adapter document\n\nADAPTER_DOCUMENT\n\n[External](https://example.com/reader-interface)\n';
      const next = { name: 'adapter-document.md', resourceUri: 'codex-resource://reader-interface',
        text: nextText, bytes: Buffer.byteLength(nextText), ...await render(file, nextText) };
      try {
        const bridge = 'const initialDocument=' + JSON.stringify(output).replace(/</g, '\\u003c') + ';\n'
          + "for (const name of ['openai', 'markdownBrowser']) {\n"
          + "  Object.defineProperty(window, name, { get() { throw new Error('Reader accessed host globals'); } });\n"
          + '}\n'
          + 'window.__openedLinks=[];\n'
          + 'window.markdownHost={\n'
          + '  connect(onDocument) { window.__publishDocument=onDocument; return {initialDocument,tocVisible:false}; },\n'
          + '  async openLink(url) { window.__openedLinks.push(url); }\n'
          + '};\n';
        await injected.setContent(await viewerHtml({ hostBridge: bridge }), { waitUntil: 'load' });
        await injected.locator('#content .mermaid svg').waitFor({ timeout: 20000 });
        assert.equal(await injected.locator('#source').textContent(), text);
        assert.equal(await injected.locator('aside').isVisible(), false);
        assert.equal(await injected.locator('#open-browser').isVisible(), false);
        await injected.locator('#toggle-source').click();
        await injected.evaluate(document => window.__publishDocument(document), next);
        assert.equal(await injected.locator('#name').textContent(), next.name);
        assert.equal(await injected.locator('#source').textContent(), nextText);
        assert.equal(await injected.locator('#source').isVisible(), true);
        await injected.locator('#toggle-source').click();
        await injected.getByRole('link', { name: 'External', exact: true }).click();
        assert.deepEqual(await injected.evaluate(() => window.__openedLinks), ['https://example.com/reader-interface']);
        assert.equal(await injected.locator('#error').isVisible(), false);
        return { initialSnapshot: true, notifiedSnapshot: true, sourceModePreserved: true,
          startupTocPreference: true, externalLinkUsesAdapter: true, hostGlobalsUnread: true };
      } finally { await injected.close(); }
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
      const link = page.locator('#toc a').filter({ hasText: '后续阅读' });
      await link.click();
      await page.waitForFunction(() => {
        const heading = [...document.querySelectorAll('#content h2')].find(node => node.textContent.includes('后续阅读'));
        const rect = heading.getBoundingClientRect(), bounds = document.getElementById('main').getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      });
      const info = await page.evaluate(() => {
        const main = document.getElementById('main');
        const heading = [...document.querySelectorAll('#content h2')].find(node => node.textContent.includes('后续阅读'));
        const rect = heading.getBoundingClientRect(), bounds = main.getBoundingClientRect();
        return { scroll: main.scrollTop, top: rect.top, bottom: rect.bottom, mainTop: bounds.top, mainBottom: bounds.bottom };
      });
      assert.ok(info.top >= info.mainTop && info.bottom <= info.mainBottom); return info;
    });
    await page.screenshot({ path: path.join(directory, 'desktop-math.png') });
    await check('Source toggle preserves exact Markdown', async () => {
      assert.deepEqual(await page.locator('header button').evaluateAll(nodes => nodes.map(node => node.id)), ['toggle-toc', 'toggle-source', 'open-browser']);
      assert.equal(await page.locator('#toggle-toc').innerText(), '目录');
      assert.equal(await page.locator('#toggle-source').innerText(), '查看源码');
      assert.equal(await page.locator('header #name').innerText(), output.name);
      assert.equal(await page.locator('header #status, header [role=status]').count(), 0);
      assert.equal(await page.locator('header button svg, #toggle-search, #open-folder, #document-search').count(), 0);
      await page.locator('#toggle-source').click();
      assert.equal(await page.locator('#source').textContent(), text);
      assert.equal(await page.locator('#source').isVisible(), true);
      assert.equal(await page.locator('#content').isVisible(), false);
      await page.locator('#toggle-source').click();
      assert.equal(await page.locator('#content').isVisible(), true);
    });
    await check('System theme changes update colors and rerender diagram', async () => {
      assert.equal(await page.locator('#theme').count(), 0);
      const lightFill = await page.locator('#content .mermaid svg .node rect').first().evaluate(node => getComputedStyle(node).fill);
      assert.notEqual(lightFill, 'none');
      await setSystemTheme(page, 'dark');
      await page.waitForFunction(previous => {
        const svg = document.querySelector('#content .mermaid svg'), node = svg?.querySelector('.node rect');
        return svg?.viewBox.baseVal.width > 100 && node && getComputedStyle(node).fill !== previous;
      }, lightFill);
      const darkFill = await page.locator('#content .mermaid svg .node rect').first().evaluate(node => getComputedStyle(node).fill);
      assert.notEqual(darkFill, 'none');
      assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(23, 26, 32)');
      assert.equal(await page.locator('#content pre').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(32, 36, 43)');
      assert.equal(await page.locator('#content pre code').first().evaluate(node => getComputedStyle(node).color), 'rgb(226, 232, 240)');
      await setSystemTheme(page, 'light');
      await page.waitForFunction(expected => {
        const node = document.querySelector('#content .mermaid svg .node rect');
        return node && getComputedStyle(node).fill === expected;
      }, lightFill);
      assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
      await setSystemTheme(page, 'dark');
      await page.waitForFunction(expected => {
        const node = document.querySelector('#content .mermaid svg .node rect');
        return node && getComputedStyle(node).fill === expected;
      }, darkFill);
      await page.screenshot({ path: path.join(directory, 'desktop-dark.png') });
      return { lightFill, darkFill, systemChangesFollowed: true };
    });
    await check('TOC visibility toggle', async () => {
      await page.locator('#toggle-toc').click(); assert.equal(await page.locator('aside').isVisible(), false);
      assert.equal(await page.locator('#toggle-toc').getAttribute('aria-expanded'), 'false');
      await page.locator('#toggle-toc').click(); assert.equal(await page.locator('aside').isVisible(), true);
    });
    await check('System theme change in source mode preserves diagram layout', async () => {
      const darkFill = await page.locator('#content .mermaid svg .node rect').first().evaluate(node => getComputedStyle(node).fill);
      await page.locator('#toggle-source').click();
      try {
        await setSystemTheme(page, 'light');
        assert.equal(await page.locator('#source').textContent(), text);
      } finally { await page.locator('#toggle-source').click(); }
      await page.waitForFunction(previous => {
        const svg = document.querySelector('#content .mermaid svg'), node = svg?.querySelector('.node rect');
        return svg?.viewBox.baseVal.width > 100 && node && getComputedStyle(node).fill !== previous;
      }, darkFill, { timeout: 10000 });
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
      assert.doesNotMatch(await page.locator('#content').innerText(), /Markdown 功能示例/);
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
      assert.equal(await page.locator('#status').isVisible(), false);
      assert.equal(await page.locator('#content').innerText(), '');
      assert.equal(await page.locator('#source').textContent(), '');
      assert.equal(await page.locator('#toc').innerText(), '');
    });
    await check('Theme change cannot restore stale document after error', async () => {
      await setSystemTheme(page, 'dark');
      assert.equal(await page.locator('#content').innerText(), '');
      assert.equal(await page.locator('#error').innerText(), 'TEST_READ_FAILURE');
    });
    await check('Recovery accepts next successful document', async () => {
      await event(page, { toolResponseMetadata: {}, toolOutput: output });
      await page.locator('#content .mermaid svg').waitFor();
      assert.equal(await page.locator('#error').isVisible(), false);
      assert.equal(await page.locator('#name').textContent(), output.name);
    });
    await check('Metadata read errors retain empty-message clearing for initial and later inputs', async () => {
      const globals = { toolResponseMetadata: { status: 'error' }, toolOutput: { error: '' } };
      await event(page, globals);
      assert.equal(await page.locator('#content').innerText(), '');
      assert.equal(await page.locator('#source').textContent(), '');
      assert.equal(await page.locator('#toc').innerText(), '');
      assert.equal(await page.locator('#error').isVisible(), false);
      assert.equal(await page.locator('#open-browser').isDisabled(), true);

      const initialFailure = await context.newPage();
      initialFailure.on('pageerror', error => pageErrors.push(error.message));
      try {
        const html = template.replace('<script>', () => '<script>window.openai='
          + JSON.stringify(globals).replace(/</g, '\\u003c') + ';</script><script>');
        await initialFailure.setContent(html, { waitUntil: 'load' });
        assert.equal(await initialFailure.locator('#error').isVisible(), false);
        assert.equal(await initialFailure.locator('#source').textContent(), '');
        assert.equal(await initialFailure.locator('#open-browser').isDisabled(), true);
      } finally { await initialFailure.close(); }
      return { explicitEmptyFailureClearsDocument: true, initialFailureUsesSameTranslation: true };
    });
    await check('A valid snapshot with an empty raw error field is still accepted', async () => {
      await event(page, { toolResponseMetadata: {}, toolOutput: { ...output, error: '' } });
      await page.locator('#content .mermaid svg').waitFor();
      assert.equal(await page.locator('#source').textContent(), text);
      assert.equal(await page.locator('#name').textContent(), output.name);
      assert.equal(await page.locator('#error').isVisible(), false);
      assert.equal(await page.locator('#open-browser').isEnabled(), true);
      return { emptyRawErrorIsNotReadFailure: true };
    });
    await check('Output-only error cannot restore stale document on theme change', async () => {
      await event(page, { toolResponseMetadata: {}, toolOutput: { error: 'OUTPUT_ONLY_FAILURE' } });
      await setSystemTheme(page, 'light');
      assert.equal(await page.locator('#content').innerText(), '');
      assert.equal(await page.locator('#error').innerText(), 'OUTPUT_ONLY_FAILURE');
    });
    await check('Malformed document output clears the previous document', async () => {
      await event(page, { toolResponseMetadata: {}, toolOutput: output });
      await page.locator('#content .mermaid svg').waitFor();
      await event(page, { toolResponseMetadata: {}, toolOutput: { ...output, html: undefined } });
      assert.equal(await page.locator('#status').isVisible(), false);
      assert.match(await page.locator('#error').innerText(), /无效的文档内容/);
      assert.equal(await page.locator('#content').innerText(), '');
      assert.equal(await page.locator('#source').textContent(), '');
      assert.equal(await page.locator('#toc').innerText(), '');
      await setSystemTheme(page, 'dark');
      assert.equal(await page.locator('#content').innerText(), '');
    });
    await check('Authored shell IDs preserve heading styles and UI controls', async () => {
      const collisionText = 'COLLISION_DOCUMENT_ONLY\n\n# Ordinary heading\n\n# source\n\n' +
        '## Ordinary section\n\n## detail\n\n## error\n\n## name\n\n## status\n\n' +
        '## [toc](https://example.com/) {#toc}\n\n' +
        '## [Ordinary linked heading](https://example.com/) {#ordinary-linked-heading}\n\n' +
        '<script>window.__markdown_script_executed = true</script>\n\n' +
        '<img src="https://example.invalid/probe.png" onerror="window.__markdown_script_executed = true">\n';
      const collision = { name: 'Collision document.md', resourceUri: 'codex-resource://browser-collision', text: collisionText,
        bytes: Buffer.byteLength(collisionText), ...await render(file, collisionText) };
      await event(page, { toolResponseMetadata: {}, toolOutput: collision });
      assert.equal((await page.locator('article h1#source').innerText()).trim(), 'source');
      assert.equal((await page.locator('article h2#detail').innerText()).trim(), 'detail');
      const styles = await page.locator('article#content').evaluate(content => {
        const properties = ['fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'color', 'whiteSpace',
          'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight',
          'marginBottom', 'marginLeft', 'maxWidth', 'borderTopWidth', 'borderBottomWidth'];
        const readStyle = selector => {
          const style = getComputedStyle(content.querySelector(selector));
          return Object.fromEntries(properties.map(property => [property, style[property]]));
        };
        const links = ['#toc a', '#ordinary-linked-heading a'].map(selector => {
          const style = getComputedStyle(content.querySelector(selector));
          return { color: style.color, textDecorationLine: style.textDecorationLine };
        });
        return { normalH1: readStyle('#ordinary-heading'), source: readStyle('h1#source'),
          normalH2: readStyle('#ordinary-section'),
          headings: ['detail', 'error', 'name', 'status', 'toc'].map(id => ({ id, style: readStyle('h2#' + id) })), links };
      });
      assert.deepEqual(styles.source, styles.normalH1, 'source heading inherits source-view styles');
      for (const heading of styles.headings) {
        assert.deepEqual(heading.style, styles.normalH2, heading.id + ' heading inherits shell styles');
      }
      assert.deepEqual(styles.links[0], styles.links[1], 'toc heading link inherits directory styles');
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
    await check('Same-document updates and theme changes preserve reading position', async () => {
      const diagrams = await observeDiagrams(page);
      try {
        const source = '# Reading position\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n' +
          Array.from({ length: 50 }, (_, i) => 'Paragraph ' + i + '\n\n').join('');
        const readingOutput = { name: 'reading-position.md', resourceUri: 'codex-resource://reading-position', text: source,
          bytes: Buffer.byteLength(source), ...await render(file, source) };
        await event(page, { toolResponseMetadata: {}, toolOutput: readingOutput });
        await diagrams.waitForAll();
        await page.locator('#content .mermaid svg').waitFor();
        await page.locator('#main').evaluate(node => node.scrollTo({ top: 101, behavior: 'instant' }));
        const updatedText = source + 'UPDATED_DOCUMENT_END\n';
        await event(page, { toolResponseMetadata: {}, toolOutput: { ...readingOutput, text: updatedText,
          bytes: Buffer.byteLength(updatedText), ...await render(file, updatedText) } });
        await diagrams.waitForAll();
        await page.locator('#content .mermaid svg').waitFor();
        assert.match(await page.locator('#content').innerText(), /UPDATED_DOCUMENT_END/);
        await page.waitForFunction(() => Math.abs(document.getElementById('main').scrollTop - 101) < 2);
        await setSystemTheme(page, 'light');
        await diagrams.waitForAll();
        await page.locator('#content .mermaid svg').waitFor();
        await page.waitForFunction(() => Math.abs(document.getElementById('main').scrollTop - 101) < 2);
        return { contentUpdated: true, refreshKeepsScroll: true, themeKeepsScroll: true };
      } finally { await diagrams.restore(); }
    });
    await check('Switching to source while Mermaid completes preserves the new reading position', async () => {
      const source = '# Delayed source toggle\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n' +
        Array.from({ length: 80 }, (_, i) => 'Source paragraph ' + i + '\n\n').join('');
      const delayed = { name: 'delayed-source.md', resourceUri: 'codex-resource://delayed-source', text: source,
        bytes: Buffer.byteLength(source), ...await render(file, source) };
      const diagrams = await observeDiagrams(page);
      try {
        await diagrams.holdNext();
        await event(page, { toolResponseMetadata: {}, toolOutput: delayed });
        const held = await diagrams.waitForHeld();
        await page.locator('#main').evaluate(node => node.scrollTo({ top: 101, behavior: 'instant' }));
        await page.locator('#toggle-source').click();
        await page.locator('#main').evaluate(node => node.scrollTo({ top: 211, behavior: 'instant' }));
        assert.equal(await page.locator('#source').isVisible(), true);
        assert.equal(await page.locator('#main').evaluate(node => node.scrollTop), 211);
        await diagrams.release(held);
        await diagrams.waitForAll();
        assert.equal(await page.locator('#source').isVisible(), true);
        assert.equal(await page.locator('#source').textContent(), source);
        assert.equal(await page.locator('#main').evaluate(node => node.scrollTop), 211,
          'A reading render that finishes after switching modes must not restore its earlier scroll');
        assert.equal(await page.locator('#error').isVisible(), false);
        return { realSvgRendered: true, completionHeld: true, sourceModeAndNewScrollPreserved: true };
      } finally {
        await diagrams.restore();
        if (await page.locator('#source').isVisible()) await page.locator('#toggle-source').click();
      }
    });
    await check('Old diagram success and failure cannot alter a newer document', async () => {
      const source = '# Old diagram\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n' +
        Array.from({ length: 70 }, (_, i) => 'Old paragraph ' + i + '\n\n').join('');
      const renderedOld = await render(file, source);
      const newSource = '# New document\n\nCURRENT_DOCUMENT_ONLY\n\n' +
        Array.from({ length: 70 }, (_, i) => 'Current paragraph ' + i + '\n\n').join('');
      const renderedNew = await render(file, newSource);
      const diagrams = await observeDiagrams(page);
      try {
        for (const outcome of ['success', 'failure']) {
          await diagrams.holdNext();
          await event(page, { toolResponseMetadata: {}, toolOutput: {
            name: 'old-' + outcome + '.md', resourceUri: 'codex-resource://old-diagram-' + outcome,
            text: source, bytes: Buffer.byteLength(source), ...renderedOld
          } });
          const held = await diagrams.waitForHeld();
          await event(page, { toolResponseMetadata: {}, toolOutput: {
            name: 'current-' + outcome + '.md', resourceUri: 'codex-resource://current-diagram-' + outcome,
            text: newSource, bytes: Buffer.byteLength(newSource), ...renderedNew
          } });
          await diagrams.waitForLatest();
          await page.locator('#main').evaluate(node => node.scrollTo({ top: 173, behavior: 'instant' }));
          await diagrams.release(held, outcome === 'failure' ? 'OLD_DIAGRAM_FAILURE' : undefined);
          await diagrams.waitForAll();
          assert.equal(await page.locator('#source').textContent(), newSource);
          assert.match(await page.locator('#content').innerText(), /CURRENT_DOCUMENT_ONLY/);
          assert.equal(await page.locator('#content svg').count(), 0);
          assert.equal(await page.locator('#main').evaluate(node => node.scrollTop), 173,
            'A diagram from the previous document must not change the current scroll');
          assert.equal(await page.locator('#error').isVisible(), false,
            'A diagram failure from the previous document must not become the current error');
        }
        return { oldSuccessIgnored: true, oldFailureIgnored: true, currentDocumentAndScrollPreserved: true };
      } finally { await diagrams.restore(); }
    });
    await check('Old diagram success and failure cannot alter a newer theme render', async () => {
      const source = '# Delayed theme\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n' +
        Array.from({ length: 70 }, (_, i) => 'Theme paragraph ' + i + '\n\n').join('');
      const themed = { name: 'delayed-theme.md', resourceUri: 'codex-resource://delayed-theme', text: source,
        bytes: Buffer.byteLength(source), ...await render(file, source) };
      const diagrams = await observeDiagrams(page);
      try {
        for (const outcome of ['success', 'failure']) {
          await diagrams.holdNext();
          await event(page, { toolResponseMetadata: {}, toolOutput: themed });
          const held = await diagrams.waitForHeld();
          const nextTheme = await page.evaluate(() => document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
          await setSystemTheme(page, nextTheme);
          await diagrams.waitForLatest();
          await page.locator('#main').evaluate(node => node.scrollTo({ top: 197, behavior: 'instant' }));
          await diagrams.release(held, outcome === 'failure' ? 'OLD_THEME_DIAGRAM_FAILURE' : undefined);
          await diagrams.waitForAll();
          assert.equal(await page.locator('#source').textContent(), source);
          assert.equal(await page.locator('#content .mermaid svg').count(), 1);
          assert.equal(await page.locator('#main').evaluate(node => node.scrollTop), 197,
            'The earlier theme render must not restore its scroll after the current theme render');
          assert.equal(await page.locator('#error').isVisible(), false,
            'The earlier theme render must not overwrite the current error state');
        }
        return { realSvgRendered: true, themeRerendersCompleted: true, oldSuccessAndFailureIgnored: true };
      } finally { await diagrams.restore(); }
    });
    await check('Empty documents preserve their exact source', async () => {
      for (const empty of ['', '\n', '\r\n']) {
        await event(page, { toolResponseMetadata: {}, toolOutput: { name: 'empty.md', resourceUri: 'codex-resource://empty-' + empty.length,
          text: empty, bytes: Buffer.byteLength(empty), ...await render(file, empty) } });
        assert.equal(await page.locator('#error').isVisible(), false);
        assert.equal(await page.locator('#content').innerText(), '');
        await page.locator('#toggle-source').click();
        assert.equal(await page.locator('#source').textContent(), empty);
        await page.locator('#toggle-source').click();
      }
      await event(page, { toolResponseMetadata: {}, toolOutput: output });
      await page.locator('#content .mermaid svg').waitFor();
      return { emptyDocuments: 3 };
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
      await narrow.locator('#toc a').filter({ hasText: '后续阅读' }).click();
      await narrow.waitForFunction(() => document.getElementById('main').scrollTop > 0);
      await narrow.screenshot({ path: path.join(directory, 'narrow.png') });
      await narrow.close(); return size;
    });
    await check('Source preserves newlines and exact selected copying', async () => {
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
        await frame.locator('#content h1').filter({ hasText: '链接检查' }).waitFor({ state: 'visible' });
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
    const linkAdapterText = '# Link adapter\n\n[HTTPS](https://example.com/adapter)\n\n[HTTP](http://localhost:8000/adapter)\n\n[Mail](mailto:adapter@example.com)\n';
    const linkAdapterOutput = { name: 'link-adapter.md', resourceUri: 'codex-resource://link-adapter', text: linkAdapterText,
      bytes: Buffer.byteLength(linkAdapterText), ...await render(file, linkAdapterText) };
    const withLinkHost = async ({ externalMode, capabilities = { openLinks: {} }, reply = 'success' }, run) => {
      const hostPage = await context.newPage();
      hostPage.on('pageerror', error => pageErrors.push(error.message));
      try {
        await hostPage.setContent('<iframe style="width:100%;height:850px;border:0"></iframe>');
        await hostPage.evaluate(({ html, capabilities, reply }) => {
          const iframe = document.querySelector('iframe');
          window.__linkRequests = [];
          window.addEventListener('message', event => {
            const message = event.data;
            if (event.source !== iframe.contentWindow || message?.jsonrpc !== '2.0') return;
            window.__linkRequests.push(message);
            if (!message.id) return;
            let response;
            if (message.method === 'ui/initialize') {
              response = { result: { protocolVersion: '2026-01-26', hostCapabilities: capabilities } };
            } else if (message.method === 'ui/open-link' && reply === 'jsonrpc-error') {
              response = { error: { code: -32000, message: 'TEST_LINK_RPC_FAILED' } };
            } else {
              response = { result: reply === 'isError' ? { isError: true } : {} };
            }
            iframe.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, ...response }, '*');
          });
          iframe.srcdoc = html;
        }, { html: bootstrap(linkAdapterOutput), capabilities, reply });
        const frame = await (await hostPage.locator('iframe').elementHandle()).contentFrame();
        await frame.locator('#content h1').filter({ hasText: 'Link adapter' }).waitFor();
        await frame.evaluate(mode => {
          const probe = { mode, calls: [], rejectPending: null };
          window.__linkProbe = probe;
          if (!mode) return;
          window.openai.openExternal = function ({ href }) {
            probe.calls.push({ href, receiverIsOpenai: this === window.openai });
            if (probe.mode === 'reject') return Promise.reject(new Error('TEST_EXTERNAL_FAILED'));
            if (probe.mode === 'hold') return new Promise((_, reject) => { probe.rejectPending = reject; });
            return Promise.resolve();
          };
        }, externalMode);
        await run({ hostPage, frame });
      } finally { await hostPage.close(); }
    };

    await check('HTTPS host shortcuts start synchronously, preserve the receiver, and do not fall back on rejection', async () => {
      await withLinkHost({ externalMode: 'success' }, async ({ hostPage, frame }) => {
        const synchronousCalls = await frame.evaluate(() => {
          document.querySelector('#content a').click();
          return window.__linkProbe.calls;
        });
        assert.deepEqual(synchronousCalls, [{ href: 'https://example.com/adapter', receiverIsOpenai: true }],
          'The host shortcut must start in the click turn before any initialization await');
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(await hostPage.evaluate(() => window.__linkRequests), []);
        assert.equal(await frame.locator('#error').isVisible(), false);

        await frame.evaluate(() => { window.__linkProbe.mode = 'reject'; });
        await frame.locator('#content a').filter({ hasText: 'HTTPS' }).click();
        await frame.locator('#error').filter({ hasText: 'TEST_EXTERNAL_FAILED' }).waitFor();
        assert.deepEqual(await hostPage.evaluate(() => window.__linkRequests), [],
          'A rejected host shortcut must not initialize or attempt a second opening route');
        assert.equal(await frame.locator('#source').textContent(), linkAdapterText);

        await frame.evaluate(() => { window.__linkProbe.mode = 'success'; });
        await frame.locator('#content a').filter({ hasText: 'HTTPS' }).click();
        assert.equal(await frame.locator('#error').isVisible(), false);
        assert.ok((await frame.evaluate(() => window.__linkProbe.calls)).every(call => call.receiverIsOpenai));
      });
      return { synchronousStart: true, originalReceiver: true, rejectionVisibleWithoutFallback: true, retryClearsError: true };
    });

    await check('HTTP and mail links keep using the negotiated host route when the HTTPS shortcut is available', async () => {
      await withLinkHost({ externalMode: 'success' }, async ({ hostPage, frame }) => {
        for (const [label, url] of [['HTTP', 'http://localhost:8000/adapter'], ['Mail', 'mailto:adapter@example.com']]) {
          await frame.getByRole('link', { name: label, exact: true }).click();
          await hostPage.waitForFunction(expected => window.__linkRequests.some(message =>
            message.method === 'ui/open-link' && message.params.url === expected), url);
        }
        assert.deepEqual(await frame.evaluate(() => window.__linkProbe.calls), []);
        const messages = await hostPage.evaluate(() => window.__linkRequests);
        assert.equal(messages.filter(message => message.method === 'ui/initialize').length, 1);
        assert.deepEqual(messages.filter(message => message.method === 'ui/open-link').map(message => message.params.url),
          ['http://localhost:8000/adapter', 'mailto:adapter@example.com']);
        assert.equal(await frame.locator('#error').isVisible(), false);
      });
      return { shortcutRestrictedToHttps: true, httpAndMailUseHostRoute: true, singleInitialization: true };
    });

    await check('Missing link capabilities and fallback host failures are visible without losing the document', async () => {
      const cases = [
        { capabilities: {}, reply: 'success', message: '当前宿主不支持打开外部链接。', openCalls: 0 },
        { reply: 'isError', message: '宿主未能打开此链接。', openCalls: 1 },
        { reply: 'jsonrpc-error', message: 'TEST_LINK_RPC_FAILED', openCalls: 1 },
      ];
      for (const scenario of cases) {
        await withLinkHost(scenario, async ({ hostPage, frame }) => {
          await frame.locator('#content a').filter({ hasText: 'HTTPS' }).click();
          await frame.locator('#error').filter({ hasText: scenario.message }).waitFor();
          const messages = await hostPage.evaluate(() => window.__linkRequests);
          assert.equal(messages.filter(message => message.method === 'ui/initialize').length, 1);
          assert.equal(messages.filter(message => message.method === 'ui/open-link').length, scenario.openCalls);
          assert.equal(await frame.locator('#source').textContent(), linkAdapterText);
          assert.equal(await frame.locator('#name').textContent(), linkAdapterOutput.name);
          assert.equal((await frame.locator('#content h1').textContent()).trim(), 'Link adapter');
        });
      }
      return { missingCapabilityChecked: true, toolFailureVisible: true, protocolFailureVisible: true, documentRetained: true };
    });

    await check('A delayed HTTPS host-shortcut error cannot affect a newly selected document', async () => {
      const nextText = '# Next link document\n\nNEW_LINK_DOCUMENT\n\n[HTTPS](https://example.com/new-document)\n';
      const next = { name: 'next-link-document.md', resourceUri: 'codex-resource://next-link-document', text: nextText,
        bytes: Buffer.byteLength(nextText), ...await render(file, nextText) };
      await withLinkHost({ externalMode: 'hold' }, async ({ hostPage, frame }) => {
        await frame.locator('#content a').filter({ hasText: 'HTTPS' }).click();
        await frame.waitForFunction(() => typeof window.__linkProbe.rejectPending === 'function');
        await event(frame, { toolOutput: next, toolResponseMetadata: {} });
        await frame.locator('#name').filter({ hasText: next.name }).waitFor();
        await frame.evaluate(() => window.__linkProbe.rejectPending(new Error('STALE_EXTERNAL_FAILURE')));
        await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await frame.locator('#error').isVisible(), false);
        assert.equal(await frame.locator('#source').textContent(), nextText);
        assert.match(await frame.locator('#content').innerText(), /NEW_LINK_DOCUMENT/);
        assert.deepEqual(await hostPage.evaluate(() => window.__linkRequests), []);

        await frame.evaluate(() => { window.__linkProbe.mode = 'success'; });
        await frame.locator('#content a').filter({ hasText: 'HTTPS' }).click();
        assert.equal((await frame.evaluate(() => window.__linkProbe.calls)).at(-1).href, 'https://example.com/new-document');
        assert.equal(await frame.locator('#error').isVisible(), false);
      });
      return { previousDocumentErrorIgnored: true, selectedDocumentRetained: true, nextLinkStillOpens: true };
    });

    // about:blank cannot provide localStorage. Serve only these two virtual pages
    // through Playwright, so persistence uses a real origin without any server.
    const preferenceOrigin = 'https://markdown-preview.test';
    const preferenceText = '# Preference document\n\nPREFERENCE_DOCUMENT_READABLE\n\n## Section\n';
    const preferenceOutput = { name: 'preference-a.md', resourceUri: 'codex-resource://preference-a', text: preferenceText,
      bytes: Buffer.byteLength(preferenceText), ...await render(file, preferenceText) };
    const preferencePages = new Map([
      [preferenceOrigin + '/a.html', bootstrap(preferenceOutput)],
      [preferenceOrigin + '/b.html', bootstrap({ ...preferenceOutput, name: 'preference-b.md', resourceUri: 'codex-resource://preference-b' })]
    ]);
    const servePreferences = async context => {
      await context.route('**/*', route => {
        const request = route.request(), html = preferencePages.get(request.url());
        if (html && request.resourceType() === 'document') {
          preferenceLoads.push(request.url());
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
        }
        preferenceRequests.push(request.url());
        return route.abort();
      });
    };
    const openPreferencePage = async (context, document = 'a', viewport) => {
      const opened = await context.newPage();
      opened.on('pageerror', error => pageErrors.push(error.message));
      if (viewport) await opened.setViewportSize(viewport);
      await opened.goto(preferenceOrigin + '/' + document + '.html');
      await opened.locator('#content').filter({ hasText: 'PREFERENCE_DOCUMENT_READABLE' }).waitFor();
      return opened;
    };
    const assertPreferences = async (opened, color, tocVisible) => {
      await opened.waitForFunction(value => document.documentElement.dataset.theme === value, color);
      assert.equal(await opened.locator('aside').isVisible(), tocVisible);
      assert.equal(await opened.locator('#toggle-toc').getAttribute('aria-expanded'), String(tocVisible));
    };
    const storedPreferences = opened => opened.evaluate(() => ({
      theme: localStorage.getItem('markdown-preview:theme'), toc: localStorage.getItem('markdown-preview:toc')
    }));
    const launchPreferences = async colorScheme => {
      const context = await chromium.launchPersistentContext(profile, { headless: true,
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
        viewport: { width: 1280, height: 900 }, colorScheme, offline: true });
      await servePreferences(context);
      return context;
    };
    preferenceContext = await launchPreferences('light');
    let preferencePage;
    await check('System theme and TOC preference survive refresh and reopening another document', async () => {
      preferencePage = await openPreferencePage(preferenceContext);
      await assertPreferences(preferencePage, 'light', true);
      assert.deepEqual(await storedPreferences(preferencePage), { theme: null, toc: null });
      await setSystemTheme(preferencePage, 'dark');
      await preferencePage.locator('#toggle-toc').click();
      await preferencePage.reload();
      await assertPreferences(preferencePage, 'dark', false);
      await preferencePage.close();
      preferencePage = await openPreferencePage(preferenceContext, 'b');
      assert.equal(await preferencePage.locator('#name').textContent(), 'preference-b.md');
      await assertPreferences(preferencePage, 'light', false);
      await preferencePage.reload();
      await assertPreferences(preferencePage, 'light', false);
      assert.deepEqual(await storedPreferences(preferencePage), { theme: null, toc: 'hidden' });
      return { refresh: true, reopenedDifferentDocument: true, stored: await storedPreferences(preferencePage) };
    });
    await check('Explicit TOC preference survives narrow and wide reopenings', async () => {
      await preferencePage.close();
      preferencePage = await openPreferencePage(preferenceContext, 'a', { width: 390, height: 844 });
      await assertPreferences(preferencePage, 'light', false);
      await preferencePage.locator('#toggle-toc').click();
      await preferencePage.reload();
      await assertPreferences(preferencePage, 'light', true);
      await preferencePage.close();
      preferencePage = await openPreferencePage(preferenceContext, 'b');
      await assertPreferences(preferencePage, 'light', true);
      await preferencePage.locator('#toggle-toc').click();
      await preferencePage.reload();
      await assertPreferences(preferencePage, 'light', false);
      return { narrowVisible: true, wideVisible: true, wideHidden: true };
    });
    await check('Browser restart uses the current system theme and retains TOC preference', async () => {
      await assertPreferences(preferencePage, 'light', false);
      assert.deepEqual(await storedPreferences(preferencePage), { theme: null, toc: 'hidden' });
      await preferenceContext.close();
      preferenceContext = await launchPreferences('dark');
      preferencePage = await openPreferencePage(preferenceContext, 'a');
      await assertPreferences(preferencePage, 'dark', false);
      await setSystemTheme(preferencePage, 'light');
      await assertPreferences(preferencePage, 'light', false);
      assert.deepEqual(await storedPreferences(preferencePage), { theme: null, toc: 'hidden' });
      return { persistedProfileRestart: true, systemChangesFollowed: true, tocRetained: true };
    });
    await preferenceContext.close();
    preferenceContext = undefined;
    await check('Legacy theme preferences cannot override the system theme', async () => {
      for (const savedTheme of ['light', 'dark', 'system']) {
        const colorScheme = savedTheme === 'dark' ? 'light' : 'dark';
        const legacyContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme, offline: true });
        try {
          await servePreferences(legacyContext);
          await legacyContext.addInitScript(value => {
            if (location.origin !== 'https://markdown-preview.test') return;
            localStorage.setItem('markdown-preview:theme', value);
            localStorage.setItem('markdown-preview:toc', 'hidden');
          }, savedTheme);
          const legacyPage = await openPreferencePage(legacyContext);
          await assertPreferences(legacyPage, colorScheme, false);
          await setSystemTheme(legacyPage, colorScheme === 'dark' ? 'light' : 'dark');
          await assertPreferences(legacyPage, colorScheme === 'dark' ? 'light' : 'dark', false);
          assert.equal((await storedPreferences(legacyPage)).toc, 'hidden');
        } finally { await legacyContext.close(); }
      }
      return { ignoredValues: ['light', 'dark', 'system'], systemChangesFollowed: true, tocRetained: true };
    });
    await check('Invalid and unavailable storage leave reading controls usable', async () => {
      const cases = ['invalid', 'denied', 'quota'];
      for (const mode of cases) {
        const storageContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', offline: true });
        try {
          await servePreferences(storageContext);
          await storageContext.addInitScript(mode => {
            if (location.origin !== 'https://markdown-preview.test') return;
            if (mode === 'denied') {
              Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('TEST_STORAGE_DENIED', 'SecurityError'); } });
            } else if (mode === 'invalid') {
              localStorage.setItem('markdown-preview:theme', 'sepia');
              localStorage.setItem('markdown-preview:toc', 'sometimes');
            } else {
              Storage.prototype.setItem = () => { throw new DOMException('TEST_STORAGE_QUOTA', 'QuotaExceededError'); };
            }
          }, mode);
          const storagePage = await openPreferencePage(storageContext);
          await assertPreferences(storagePage, 'light', false);
          await setSystemTheme(storagePage, 'dark');
          await storagePage.locator('#toggle-toc').click();
          await assertPreferences(storagePage, 'dark', true);
          await storagePage.locator('#toggle-source').click();
          assert.equal(await storagePage.locator('#source').textContent(), preferenceText);
          assert.equal(await storagePage.locator('#source').isVisible(), true);
          assert.equal(await storagePage.locator('#error').isVisible(), false);
        } finally { await storageContext.close(); }
      }
      return { invalidValuesIgnored: true, storageDeniedUsable: true, quotaExceededUsable: true };
    });
    await check('Self-contained UI makes no network requests', async () => {
      assert.deepEqual(requests, []);
      assert.deepEqual(preferenceRequests, []);
      return { offlineVirtualPageLoads: preferenceLoads.length, externalRequests: 0 };
    });
    await check('No uncaught browser errors', async () => { assert.deepEqual(pageErrors, []); });
  } finally {
    await preferenceContext?.close();
    await browser?.close();
    await fs.rm(profile, { recursive: true, force: true });
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ file, results, requests, preferenceLoads, preferenceRequests, pageErrors }, null, 2));
    for (const result of results.filter(item => !item.pass)) console.log('DETAIL: ' + result.name + ': ' + result.error);
    console.log('Artifacts: ' + directory);
    if (results.some(result => !result.pass)) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
