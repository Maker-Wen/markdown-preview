'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { render, viewerHtml } = require('./render.cjs');

(async () => {
  const fixture = path.resolve(__dirname, '../tests/fixtures/markdown-sample.md');
  const sample = await fs.readFile(fixture, 'utf8');
  // CRLF, Unicode, tables, code, formulas, and a long scrollable document share
  // the same real renderer and reader used by the embedded app.
  const text = (sample + '\n## Long notes\n\n'
    + Array.from({ length: 60 }, (_, index) => `Note ${index}: 中文、emoji 🐾 and \`inlineCode\`.\n\n`).join(''))
    .replace(/\n/g, '\r\n');
  const output = { name: 'host-style-fixture.md', resourceUri: 'codex-resource://host-style-fixture',
    text, bytes: Buffer.byteLength(text), ...await render(fixture, text) };
  const template = await viewerHtml();
  const embeddedFont = template.match(/url\((data:font\/woff2;base64,[A-Za-z0-9+/=]+)\)/)?.[1];
  assert.ok(embeddedFont, 'The fixture must reuse a real embedded WOFF2 font.');
  const fontFaces = ['Host Test Sans', 'Host Test Mono'].map(family =>
    `@font-face{font-family:"${family}";src:url("${embeddedFont}") format("woff2");font-display:swap;}`).join('\n');
  const darkVariables = {
    '--font-sans': '"Host Test Sans", sans-serif', '--font-mono': '"Host Test Mono", monospace',
    '--color-background-primary': '#172338', '--color-background-secondary': '#223148',
    '--color-text-primary': '#dae6f3', '--color-text-secondary': '#adbdd3',
    '--color-border-primary': '#4a5d76', '--color-text-info': '#9ac7ff'
  };
  const darkAppearance = { theme: 'dark', styles: { variables: darkVariables, css: { fonts: fontFaces } } };
  const results = [], requests = [], pageErrors = [];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-preview-host-styles-'));
  let browser;
  const bootstrap = () => template.replace('<script>', () => '<script>window.openai='
    + JSON.stringify({ toolOutput: output }).replace(/</g, '\\u003c') + ';</script><script>');
  const check = async (name, run) => {
    try { results.push({ name, pass: true, evidence: await run() }); }
    catch (error) { results.push({ name, pass: false, error: error.stack || error.message }); }
    console.log(`${results.at(-1).pass ? 'PASS' : 'FAIL'}: ${name}`);
  };
  const settle = frame => frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const appearance = frame => frame.evaluate(() => {
    const style = selector => {
      const node = document.querySelector(selector), css = getComputedStyle(node);
      return { background: css.backgroundColor, color: css.color, font: css.fontFamily, display: css.display };
    };
    return { theme: document.documentElement.dataset.theme, body: style('body'), heading: style('#content h1'),
      paragraph: style('#content p'), button: style('#toggle-source'), code: style('#content pre code'),
      source: style('pre#source'), errorVisible: !document.getElementById('error').hidden };
  });
  const diagramFill = frame => frame.locator('#content .mermaid svg .node rect').first()
    .evaluate(node => getComputedStyle(node).fill);

  async function reader({ hostContext = {}, systemTheme = 'light', behavior = 'respond', width = 900, holdFonts = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: systemTheme, offline: true });
    await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    if (holdFonts) await context.addInitScript(() => {
      window.fontWaitReads = 0;
      const ready = new Promise(resolve => { window.releaseFonts = resolve; });
      Object.defineProperty(document.fonts, 'ready', { get() { window.fontWaitReads++; return ready; } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setContent('<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style>'
      + '<iframe id="reader"></iframe><iframe id="other" hidden></iframe>');
    await page.evaluate(({ html, hostContext, behavior }) => {
      const iframe = document.getElementById('reader');
      window.hostRequests = [];
      window.hostContext = hostContext;
      window.hostBehavior = behavior;
      window.replyToInitialize = (message, reply) => iframe.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, ...reply }, '*');
      window.addEventListener('message', event => {
        const message = event.data;
        if (event.source !== iframe.contentWindow || message?.jsonrpc !== '2.0') return;
        window.hostRequests.push(message);
        if (message.method !== 'ui/initialize' || !message.id) return;
        window.initializationRequest = message;
        if (window.hostBehavior === 'hold') return;
        if (window.hostBehavior === 'reject') {
          window.replyToInitialize(message, { error: { code: -32000, message: 'HOST_APPEARANCE_UNAVAILABLE' } });
        } else {
          window.replyToInitialize(message, { result: { protocolVersion: '2026-01-26',
            hostInfo: { name: 'offline-style-test', version: '1' }, hostCapabilities: {}, hostContext: window.hostContext } });
        }
      });
      iframe.srcdoc = html;
    }, { html: bootstrap(), hostContext, behavior });
    const frame = await (await page.locator('#reader').elementHandle()).contentFrame();
    await frame.locator('#content h1').filter({ hasText: 'Markdown 功能示例' }).waitFor();
    if (holdFonts) await frame.waitForFunction(() => window.fontWaitReads > 0);
    else {
      await frame.locator('#content .mermaid svg').waitFor({ timeout: 20000 });
      await frame.evaluate(() => document.fonts.ready);
    }
    await settle(frame);
    const notify = async params => {
      await page.evaluate(params => document.getElementById('reader').contentWindow.postMessage({ jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed', params }, '*'), params);
      await settle(frame);
    };
    return { page, frame, context, notify, close: () => context.close() };
  }

  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });

    await check('Parent initialization applies host fonts, semantic colors, and theme before system defaults', async () => {
      const app = await reader({ hostContext: darkAppearance, systemTheme: 'light' });
      try {
        await app.frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        const styles = await appearance(app.frame);
        assert.equal(styles.body.background, 'rgb(23, 35, 56)');
        assert.equal(styles.body.color, 'rgb(218, 230, 243)');
        for (const item of ['body', 'heading', 'paragraph', 'button']) assert.match(styles[item].font, /Host Test Sans/);
        for (const item of ['code', 'source']) assert.match(styles[item].font, /Host Test Mono/);
        const fonts = await app.frame.evaluate(async () => {
          await document.fonts.ready;
          return [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family);
        });
        assert.ok(fonts.some(font => font.includes('Host Test Sans')));
        assert.ok(fonts.some(font => font.includes('Host Test Mono')));
        const messages = await app.page.evaluate(() => window.hostRequests);
        assert.equal(messages.filter(message => message.method === 'ui/initialize').length, 1);
        assert.ok(messages.some(message => message.method === 'ui/notifications/initialized'));
        assert.equal(styles.errorVisible, false);
        await app.page.emulateMedia({ colorScheme: 'dark' });
        await app.page.emulateMedia({ colorScheme: 'light' });
        await settle(app.frame);
        assert.equal((await appearance(app.frame)).theme, 'dark');
        return { realHandshake: true, themeOverridesOppositeSystemPreference: true, embeddedFontsLoaded: true,
          fontConsumers: ['body', 'heading', 'paragraph', 'button', 'code', 'source'], systemChangeKeepsHostTheme: true };
      } finally { await app.close(); }
    });

    await check('Missing host styles use readable defaults and follow subsequent system theme changes', async () => {
      const app = await reader();
      try {
        const light = await appearance(app.frame);
        assert.equal(light.theme, 'light');
        assert.ok(light.body.font.length && light.code.font.length);
        assert.notEqual(light.body.background, light.body.color);
        await app.page.emulateMedia({ colorScheme: 'dark' });
        await app.frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        const dark = await appearance(app.frame);
        assert.notEqual(dark.body.background, light.body.background);
        assert.notEqual(dark.body.color, light.body.color);
        assert.equal(dark.errorVisible, false);
        return { light, dark, sourceUnchanged: await app.frame.locator('#source').textContent() === text };
      } finally { await app.close(); }
    });

    await check('Context updates retain omitted fields and replace an explicitly supplied styles snapshot', async () => {
      const baseline = await reader({ hostContext: { theme: 'dark' } });
      const app = await reader({ hostContext: darkAppearance });
      try {
        const defaults = await appearance(baseline.frame);
        await app.frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        await app.notify({ theme: 'light' });
        const retained = await appearance(app.frame);
        assert.equal(retained.theme, 'light');
        assert.equal(retained.body.background, 'rgb(23, 35, 56)');
        assert.match(retained.body.font, /Host Test Sans/);
        await app.notify({ theme: 'dark', styles: { variables: { '--color-text-info': '#1f6feb' } } });
        const replaced = await appearance(app.frame);
        assert.equal(replaced.theme, 'dark');
        assert.deepEqual(replaced.body, defaults.body);
        assert.deepEqual(replaced.code, defaults.code);
        assert.equal(await app.frame.evaluate(() => document.documentElement.style.getPropertyValue('--color-text-info')), '#1f6feb');
        assert.equal(await app.frame.evaluate(() => document.documentElement.style.getPropertyValue('--color-background-primary')), '');
        assert.equal(await app.frame.evaluate(() => [...document.fonts].some(font => font.family.includes('Host Test'))), false);
        // A later theme-only notification must not erase the newer partial style snapshot.
        await app.notify({ theme: 'light' });
        assert.equal(await app.frame.evaluate(() => document.documentElement.style.getPropertyValue('--color-text-info')), '#1f6feb');
        await app.notify({ styles: {} });
        assert.equal(await app.frame.evaluate(() => document.documentElement.style.getPropertyValue('--color-text-info')), '');
        assert.equal(await app.frame.locator('#source').textContent(), text);
        return { themeOnlyRetainsStyles: true, explicitStylesReplacePreviousSnapshot: true,
          omittedVariablesAndFontCssRemoved: true, emptyStylesRestoreDefaults: true };
      } finally { await app.close(); await baseline.close(); }
    });

    await check('Variable validation and font-face filtering keep host styling within the embedded surface', async () => {
      const app = await reader({ hostContext: { theme: 'dark' } });
      try {
        const defaults = await appearance(app.frame);
        await app.notify({ styles: { variables: {
          '--color-background-primary': '#ffffff; } body { display:none; }',
          '--color-text-primary': 'url(https://fonts.invalid/color)',
          '--color-text-secondary': 'not-a-color',
          '--color-border-primary': '#444\u0000',
          '--font-sans': 'serif; display:none',
          '--font-mono': '@import "https://fonts.invalid/mono"',
          '--paper': 'hotpink', '--unknown-host-variable': 'url(https://fonts.invalid/unknown)'
        }, css: { fonts: '@import url("https://fonts.invalid/import.css");\n'
          + 'body{display:none!important} :root{--paper:hotpink!important}\n'
          + '@font-face{font-family:"Remote Forbidden";src:url("https://fonts.invalid/remote.woff2") format("woff2")}\n'
          + '@font-face{font-family:"Remote Fallback Forbidden";src:local("Missing Host Test Font"),url("https://fonts.invalid/fallback.woff2")}\n'
          + '@font-face{font-family:"Image Forbidden";src:url("data:image/png;base64,AA==")}\n'
          + '@font-face{font-family:"Local Allowed";src:local("Missing Host Test Font")}\n'
          + fontFaces } } });
        const filtered = await appearance(app.frame);
        assert.deepEqual(filtered.body, defaults.body);
        assert.deepEqual(filtered.code, defaults.code);
        const variables = await app.frame.evaluate(() => [...document.documentElement.style]
          .filter(name => name.startsWith('--')).map(name => [name, document.documentElement.style.getPropertyValue(name)]));
        assert.deepEqual(variables, []);
        const faces = await app.frame.evaluate(() => [...document.fonts].map(font => font.family));
        assert.ok(faces.some(family => family.includes('Host Test Sans')));
        assert.ok(faces.some(family => family.includes('Host Test Mono')));
        assert.ok(faces.some(family => family.includes('Local Allowed')));
        assert.ok(faces.every(family => !family.includes('Forbidden')));
        assert.equal(await app.frame.locator('#content').isVisible(), true);
        assert.equal(await app.frame.locator('#source').textContent(), text);
        assert.equal(await app.frame.locator('#error').isVisible(), false);
        return { invalidSemanticValuesRejected: true, privateAndUnknownVariablesIgnored: true,
          normalCssAndImportsIgnored: true, externalFontFaceRejected: true, safeEmbeddedFacesRetained: true };
      } finally { await app.close(); }
    });

    await check('Valid quoted host font names and multiline CSS values retain host appearance', async () => {
      const app = await reader();
      try {
        const variables = {
          '--font-sans': '"@Host; Sans",\n sans-serif',
          '--font-mono': '"Host; Mono",\n monospace',
          '--color-background-primary': 'rgb(\n240 241 242)'
        };
        const fonts = ['@Host; Sans', 'Host; Mono'].map(family =>
          `@font-face{font-family:"${family}";src:url("${embeddedFont}") format("woff2");}`).join('\n');
        await app.notify({ styles: { variables, css: { fonts } } });
        await app.frame.evaluate(() => document.fonts.ready);
        const styles = await appearance(app.frame);
        assert.match(styles.paragraph.font, /@Host; Sans/);
        assert.match(styles.code.font, /Host; Mono/);
        assert.equal(styles.body.background, 'rgb(240, 241, 242)');
        const loaded = await app.frame.evaluate(() => [...document.fonts]
          .filter(font => font.status === 'loaded').map(font => font.family));
        assert.ok(loaded.some(font => font.includes('@Host; Sans')));
        assert.ok(loaded.some(font => font.includes('Host; Mono')));
        assert.equal(await app.frame.locator('#source').textContent(), text);
        return { quotedFontNamesAccepted: true, multilineCssAccepted: true, hostFontsLoaded: true };
      } finally { await app.close(); }
    });

    await check('Delayed or failed appearance negotiation never blocks the document or source', async () => {
      const app = await reader({ behavior: 'hold' });
      try {
        await app.page.waitForFunction(() => window.initializationRequest);
        assert.equal(await app.frame.locator('#source').textContent(), text);
        assert.equal(await app.frame.locator('#error').isVisible(), false);
        await app.frame.locator('#toggle-source').click();
        assert.equal(await app.frame.locator('#source').isVisible(), true);
        await app.page.evaluate(() => window.replyToInitialize(window.initializationRequest,
          { error: { code: -32000, message: 'HOST_APPEARANCE_UNAVAILABLE' } }));
        await settle(app.frame);
        assert.equal(await app.frame.locator('#source').isVisible(), true);
        assert.equal(await app.frame.locator('#source').textContent(), text);
        assert.equal(await app.frame.locator('#error').isVisible(), false);
        await app.frame.locator('#toggle-source').click();
        await app.frame.locator('#content .mermaid svg').waitFor();
        return { initialDocumentAvailableWhileHandshakePending: true, initializationFailureKeepsSourceMode: true,
          noDocumentError: true, readingControlsUsable: true };
      } finally { await app.close(); }
    });

    await check('Only parent messages may initialize appearance or publish host-context updates', async () => {
      const app = await reader({ behavior: 'hold' });
      try {
        await app.page.waitForFunction(() => window.initializationRequest);
        const request = await app.page.evaluate(() => window.initializationRequest);
        const forged = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2026-01-26',
          hostCapabilities: {}, hostContext: darkAppearance } };
        await app.frame.evaluate(forged => window.postMessage(forged, '*'), forged);
        await settle(app.frame);
        assert.equal((await appearance(app.frame)).theme, 'light');
        await app.page.evaluate(forged => {
          const other = document.getElementById('other');
          other.contentWindow.readerTarget = document.getElementById('reader').contentWindow;
          other.contentWindow.forgedMessage = forged;
          other.contentWindow.eval('readerTarget.postMessage(forgedMessage,"*")');
        }, forged);
        await settle(app.frame);
        assert.equal((await appearance(app.frame)).theme, 'light');
        await app.page.evaluate(result => window.replyToInitialize(window.initializationRequest, { result }), forged.result);
        await app.frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        await app.frame.evaluate(() => window.postMessage({ jsonrpc: '2.0',
          method: 'ui/notifications/host-context-changed', params: { theme: 'light' } }, '*'));
        await settle(app.frame);
        assert.equal((await appearance(app.frame)).theme, 'dark');
        await app.page.evaluate(() => {
          const target = document.getElementById('reader').contentWindow;
          for (const message of [
            { jsonrpc: '1.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } },
            { jsonrpc: '2.0', id: 'notification-must-not-have-id', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } },
            { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: ['light'] }
          ]) target.postMessage(message, '*');
        });
        await settle(app.frame);
        assert.equal((await appearance(app.frame)).theme, 'dark');
        await app.notify({ theme: 'light' });
        await app.frame.waitForFunction(() => document.documentElement.dataset.theme === 'light');
        return { selfReplyIgnored: true, sameOriginSiblingReplyIgnored: true, selfNotificationIgnored: true,
          malformedParentNotificationsIgnored: true, parentReplyAccepted: true, parentNotificationAccepted: true };
      } finally { await app.close(); }
    });

    await check('Host theme notifications rerender real Mermaid while preserving source and reading position', async () => {
      const app = await reader({ hostContext: darkAppearance });
      try {
        await app.frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        const darkFill = await diagramFill(app.frame);
        await app.frame.evaluate(() => {
          window.diagramProbe = { calls: 0, completed: 0 };
          const original = mermaid.run;
          mermaid.run = async function (...args) {
            window.diagramProbe.calls++;
            try { return await original.apply(this, args); }
            finally { window.diagramProbe.completed++; }
          };
          document.getElementById('main').scrollTo({ top: 320, behavior: 'instant' });
        });
        await app.frame.waitForFunction(() => Math.abs(document.getElementById('main').scrollTop - 320) < 2);
        await app.notify({ theme: 'light' });
        await app.frame.waitForFunction(() => window.diagramProbe.calls > 0
          && window.diagramProbe.completed === window.diagramProbe.calls);
        await settle(app.frame);
        assert.notEqual(await diagramFill(app.frame), darkFill);
        assert.ok(Math.abs(await app.frame.locator('#main').evaluate(node => node.scrollTop) - 320) < 2);
        assert.equal(await app.frame.locator('#source').textContent(), text);
        await app.frame.locator('#toggle-source').click();
        await app.frame.locator('#main').evaluate(node => node.scrollTo({ top: 230, behavior: 'instant' }));
        await app.frame.waitForFunction(() => Math.abs(document.getElementById('main').scrollTop - 230) < 2);
        await app.notify({ theme: 'dark' });
        assert.equal(await app.frame.locator('#source').isVisible(), true);
        assert.equal(await app.frame.locator('#content').isVisible(), false);
        assert.equal(await app.frame.locator('#source').textContent(), text);
        assert.ok(Math.abs(await app.frame.locator('#main').evaluate(node => node.scrollTop) - 230) < 2);
        await app.frame.locator('#toggle-source').click();
        await app.frame.locator('#content .mermaid svg').waitFor();
        return { realSvgRepainted: true, readingScrollPreserved: true, sourceModePreserved: true, exactCRLFSource: true };
      } finally { await app.close(); }
    });

    await check('Page show completes a suspended font-waiting diagram without a document update', async () => {
      for (const readyBeforeShow of [true, false]) {
        const app = await reader({ holdFonts: true });
        try {
          assert.equal(await app.frame.locator('#content .mermaid svg').count(), 0);
          await app.frame.evaluate(() => {
            window.originalParagraph = document.querySelector('#content p');
            document.getElementById('main').scrollTo({ top: 320, behavior: 'instant' });
            window.dispatchEvent(new Event('pagehide'));
          });
          if (readyBeforeShow) {
            await app.frame.evaluate(() => window.releaseFonts());
            await settle(app.frame);
            assert.equal(await app.frame.locator('#content .mermaid svg').count(), 0,
              'A retired drawing must not run while the page is suspended');
          }
          await app.frame.evaluate(() => window.dispatchEvent(new Event('pageshow')));
          if (!readyBeforeShow) {
            assert.equal(await app.frame.locator('#content .mermaid svg').count(), 0);
            await app.frame.evaluate(() => window.releaseFonts());
          }
          await app.frame.locator('#content .mermaid svg').waitFor({ timeout: 5000 });
          await settle(app.frame);
          assert.equal(await app.frame.locator('#source').textContent(), text);
          assert.equal(await app.frame.evaluate(() => window.originalParagraph === document.querySelector('#content p')), true,
            'Resuming a diagram must not rebuild the document DOM');
          assert.ok(Math.abs(await app.frame.locator('#main').evaluate(node => node.scrollTop) - 320) < 2);
          const waits = await app.frame.evaluate(() => window.fontWaitReads);
          await app.frame.evaluate(() => window.dispatchEvent(new Event('pageshow')));
          await settle(app.frame);
          assert.equal(await app.frame.evaluate(() => window.fontWaitReads), waits,
            'An extra pageshow without a preceding pagehide must not start another drawing');
          assert.equal(await app.frame.locator('#error').isVisible(), false);
        } finally { await app.close(); }
      }
      return { fontReadyBeforeAndAfterResume: true, noDocumentUpdateRequired: true,
        originalDomAndScrollPreserved: true, extraPageShowIgnored: true };
    });

    await check('Resuming in source mode retains the latest paused document and defers diagrams until reading', async () => {
      const app = await reader({ holdFonts: true });
      try {
        const latestText = text.replace('Markdown 功能示例', 'Latest paused document')
          .replace('浏览目录', 'LATEST_RESUMED_DIAGRAM');
        const latest = { ...output, name: 'latest-paused.md', text: latestText,
          bytes: Buffer.byteLength(latestText), ...await render(fixture, latestText) };
        await app.frame.evaluate(() => {
          window.dispatchEvent(new Event('pagehide'));
          document.getElementById('toggle-source').click();
        });
        const waits = await app.frame.evaluate(() => window.fontWaitReads);
        await app.page.evaluate(toolOutput => {
          document.getElementById('reader').contentWindow.dispatchEvent(new CustomEvent('openai:set_globals',
            { detail: { globals: { toolOutput, toolResponseMetadata: {} } } }));
        }, latest);
        await app.notify({ theme: 'dark' });
        await app.frame.locator('#main').evaluate(node => node.scrollTo({ top: 230, behavior: 'instant' }));
        await app.frame.evaluate(() => {
          window.dispatchEvent(new Event('pageshow'));
          window.releaseFonts();
        });
        await settle(app.frame);
        assert.equal(await app.frame.locator('#source').isVisible(), true);
        assert.equal(await app.frame.locator('#source').textContent(), latestText);
        assert.equal(await app.frame.locator('#content .mermaid svg').count(), 0);
        assert.equal(await app.frame.evaluate(() => window.fontWaitReads), waits,
          'Hidden reading content must not wait on fonts or draw during source-mode resume');
        assert.ok(Math.abs(await app.frame.locator('#main').evaluate(node => node.scrollTop) - 230) < 2);
        await app.frame.locator('#toggle-source').click();
        await app.frame.locator('#content .mermaid svg').waitFor();
        assert.match(await app.frame.locator('#content .mermaid svg').textContent(), /LATEST_RESUMED_DIAGRAM/);
        assert.equal((await appearance(app.frame)).theme, 'dark');
        assert.equal(await app.frame.locator('#error').isVisible(), false);
        return { latestDocumentRetained: true, sourceModeAndScrollPreserved: true,
          hiddenDiagramsDeferred: true, staleFontContinuationIgnored: true };
      } finally { await app.close(); }
    });

    await check('Explicitly cleared host theme returns to system preference without changing the document', async () => {
      const app = await reader({ hostContext: { theme: 'dark' } });
      try {
        await app.frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        await app.notify({ theme: null });
        await app.frame.waitForFunction(() => document.documentElement.dataset.theme === 'light');
        await app.page.emulateMedia({ colorScheme: 'dark' });
        await app.frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        assert.equal(await app.frame.locator('#source').textContent(), text);
        return { clearRestoresSystemTheme: true, laterSystemChangesApplied: true };
      } finally { await app.close(); }
    });

    await check('Host fonts and mixed document content remain within a 400px pane', async () => {
      const app = await reader({ hostContext: darkAppearance, width: 400 });
      try {
        await app.frame.evaluate(() => document.fonts.ready);
        const info = await app.frame.evaluate(() => {
          const main = document.getElementById('main');
          return { width: innerWidth, outerWidth: document.documentElement.scrollWidth,
            mainWidth: main.clientWidth, mainContentWidth: main.scrollWidth,
            tocHidden: getComputedStyle(document.querySelector('aside')).display === 'none',
            tableCount: document.querySelectorAll('#content table').length,
            codeCount: document.querySelectorAll('#content pre code').length,
            formulaCount: document.querySelectorAll('#content .katex').length,
            diagramCount: document.querySelectorAll('#content .mermaid svg').length };
        });
        assert.ok(info.outerWidth <= info.width + 1);
        assert.ok(info.mainContentWidth <= info.mainWidth + 1);
        assert.ok(info.tocHidden && info.tableCount > 0 && info.codeCount > 0 && info.formulaCount > 0 && info.diagramCount > 0);
        await app.page.screenshot({ path: path.join(directory, 'host-style-narrow.png') });
        return info;
      } finally { await app.close(); }
    });

    await check('Embedded host styling makes no network requests and produces no unhandled browser errors', async () => {
      assert.deepEqual(requests, []);
      assert.deepEqual(pageErrors, []);
      return { requests, pageErrors };
    });
  } finally {
    await browser?.close();
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ results, requests, pageErrors }, null, 2));
    console.log(`Host-style test artifacts: ${directory}`);
  }
  if (results.some(result => !result.pass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
