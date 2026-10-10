'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { AsyncLocalStorage } = require('node:async_hooks');
const { readRegularFile } = require('./files.cjs');
const crossnotePath = require.resolve('crossnote', { paths: [path.join(__dirname, '../runtime/renderer')] });
const { Notebook, MarkdownEngine, utility } = require(crossnotePath);
const cheerio = require(require.resolve('cheerio', { paths: [path.dirname(crossnotePath)] }));
const build = utility.getCrossnoteBuildDirectory();
const notebooks = new Map();
const renderContext = new AsyncLocalStorage();
const escape = value => String(value).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const imageTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function localFile(file, root) {
  if (!inside(root, path.resolve(file))) throw new Error('资源不在当前文档目录内。');
  const real = await fs.realpath(file);
  if (!inside(root, real)) throw new Error('资源链接指向当前文档目录之外。');
  return real;
}
// The callback is process-wide: keep it independent of the active document.
utility.useExternalAddFileProtocolFunction(file => pathToFileURL(file).href);

async function notebookFor(root) {
  if (notebooks.has(root)) return notebooks.get(root);
  const deny = async () => { throw new Error('文档预览只读。'); };
  const notebook = await Notebook.init({ notebookPath: pathToFileURL(root).href, fs: {
    readFile: async (file, encoding = 'utf8') => fs.readFile(await localFile(file, root), encoding),
    exists: async file => !path.relative(root, file).split(path.sep).includes('.crossnote') && !!(await localFile(file, root).catch(() => null)),
    stat: async file => fs.stat(await localFile(file, root)), readdir: async () => [],
    writeFile: deny, mkdir: deny, unlink: deny
  }, config: {
    enableScriptExecution: false, enableHTML5Embed: false, enableWikiLinkSyntax: false,
    alwaysShowBacklinksInPreview: false, enableEmojiSyntax: false,
    mathRenderingOption: 'KaTeX', katexConfig: { trust: false, strict: 'warn' },
    mermaidConfig: { securityLevel: 'strict' },
    parserConfig: { onWillParseMarkdown: async text => {
      const marker = renderContext.getStore();
      // Crossnote imports standalone images/wiki embeds as well as @import directives.
      // Hide imports everywhere, including HTML comments, until preprocessing has finished.
      return text.replace(/<!--(?=\s+@import\b)/g, '<' + marker + '!--')
        .replace(/@import\b/g, '@' + marker + 'import')
        .replaceAll('![[', '!' + marker + '[[')
        .replace(/^([^\S\n]*(?:>+[^\S\n]?)*[^\S\n]*)(!\[)/gm,
        (_, prefix, opening) => prefix + opening[0] + marker + opening.slice(1));
    } }
  } });
  const renderMarkdown = notebook.renderMarkdown;
  notebook.renderMarkdown = function (text, options) {
    // Restore our unique marker before Markdown parses code, entities, escapes or attributes.
    // The context belongs to this render, even when the cached notebook renders concurrently.
    return renderMarkdown.call(this, text.replaceAll(renderContext.getStore(), ''), options);
  };
  const validateLink = notebook.md.validateLink;
  notebook.md.validateLink = href => /^file:\/\/(?:\/|localhost\/)/i.test(href) || validateLink(href);
  const linkOpen = notebook.md.renderer.rules.link_open;
  notebook.md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    // Crossnote rewrites local hrefs; keep the Markdown target until we resolve it ourselves.
    tokens[index].attrSet('data-reader-href', tokens[index].attrGet('href'));
    return linkOpen ? linkOpen(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
  };
  notebook.md.core.ruler.push('readonly-fences', state => {
    for (const token of state.tokens) {
      if (token.type === 'fence' || token.type === 'colon_fence') {
        const language = (token.info.trim().match(/^[a-zA-Z0-9_-]+/) || ['text'])[0];
        token.info = language === 'mermaid' ? 'mermaid' : `${language} {code_block=true}`;
      } else if (token.type === 'colon_div_open') token.info = '';
    }
  });
  notebook.md.renderer.rules.html_block = (tokens, i) => /^<p data-source-line="\d+" class="empty-line final-line end-of-document" style="margin:0;"><\/p>\s*$/.test(tokens[i].content) ? '' : escape(tokens[i].content);
  notebook.md.renderer.rules.html_inline = (tokens, i) => {
    const html = tokens[i].content;
    if (/^<input type="checkbox" class="task-list-item-checkbox"(?: data-source-line="\d+")?\s*(?:checked)?>$/.test(html)) return html.replace('>', ' disabled>');
    return /^<\/?span>$/.test(html) ? html : escape(html);
  };
  notebooks.set(root, notebook);
  return notebook;
}

async function render(file, text) {
  const root = path.dirname(file);
  const notebook = await notebookFor(root);
  const engine = new MarkdownEngine({ notebook, filePath: file });
  // An absent format-character sequence survives preprocessing without changing heading slugs.
  // Exclude raw and single-pass decoded sequences, so restoration cannot eat authored entities.
  const decodedText = notebook.md.utils.unescapeAll(text);
  let marker = '\u2063'.repeat(16);
  while (text.includes(marker) || decodedText.includes(marker)) marker += marker;
  // Crossnote treats an empty string as a request to reread its file.
  const result = await renderContext.run(marker, () => engine.parseMD(text === '' ? '\n' : text, {
    isForPreview: true, useRelativeFilePath: false,
    hideFrontMatter: false, runAllCodeChunks: false, triggeredBySave: false, vscodePreviewPanel: {} }));
  // Front matter tables can bypass renderMarkdown.
  const $ = cheerio.load(result.html.replaceAll(marker, ''), {}, false);
  for (const img of $('img').toArray()) {
    const src = $(img).attr('src') || '';
    try {
      if (!src.startsWith('file:')) throw new Error('外部图片暂未载入');
      const candidate = fileURLToPath(src);
      // Crossnote combines the literal notebook root with a URL-encoded relative image path.
      const decoded = inside(root, candidate) ? path.resolve(root, decodeURIComponent(path.relative(root, candidate))) : candidate;
      const imagePath = await localFile(decoded, root);
      const type = imageTypes[path.extname(imagePath).toLowerCase()];
      if (!type) throw new Error('不支持此图片格式');
      const bytes = await readRegularFile(imagePath);
      $(img).attr('src', `data:${type};base64,${bytes.toString('base64')}`).removeAttr('srcset');
    } catch (error) {
      const reason = error.code ? '无法读取' : error.message;
      $(img).replaceWith($('<span class="image-unavailable"></span>')
        .text(`[${$(img).attr('alt') || '图片'}：${reason}]`));
    }
  }
  // Only generated Markdown/KaTeX markup reaches the widget. Authored HTML is escaped above.
  $('script,iframe,object,embed,form,base,link,meta').remove();
  for (const element of $('*').toArray()) {
    for (const key of Object.keys(element.attribs || {})) {
      if (/^on/i.test(key) || key === 'srcdoc') $(element).removeAttr(key);
    }
  }
  for (const a of $('a[href]').toArray()) {
    const link = $(a);
    const href = link.attr('data-reader-href') ?? link.attr('href');
    link.removeAttr('data-reader-href').removeAttr('data-file-path').removeAttr('data-link-error');
    try {
      if (href.startsWith('#') || /^(https?:\/\/|mailto:)/i.test(href)) {
        link.attr('href', href);
      } else {
        if (/^[/\\]{2}/.test(href)) throw new Error('暂不支持网络共享路径。');
        const url = new URL(href, pathToFileURL(file));
        if (url.protocol !== 'file:') throw new Error('暂不支持此链接类型。');
        const target = fileURLToPath(url);
        if (/[\x00-\x1f\x7f]/.test(target) || !path.isAbsolute(target)) throw new Error('文件链接的路径无效。');
        if (target === file && url.hash) link.attr('href', url.hash);
        else {
          link.attr('href', url.href).attr('data-file-path', target);
          if (url.hash) link.attr('title', '打开目标文件；暂不定位到文件内的标题。');
        }
      }
    } catch (error) {
      link.attr('href', '#').attr('data-link-error', error.code ? '文件链接的路径无效。' : error.message);
    }
  }
  // Crossnote's tocHTML includes raw heading HTML. Build link labels as text instead.
  const toc = $('<div class="md-toc"></div>');
  for (const heading of $('h1,h2,h3,h4,h5,h6').toArray()) {
    const id = $(heading).attr('id');
    if (!id) continue;
    toc.append($('<a class="md-toc-link"></a>').attr('href', '#' + encodeURIComponent(id))
      .attr('style', 'display:block;padding-left:' + (Number(heading.tagName.slice(1)) - 1) * 12 + 'px')
      .text($(heading).text()));
  }
  return { html: $.html(), toc: toc.children().length ? $.html(toc) : '' };
}

async function viewerHtml({ hostBridge: suppliedBridge } = {}) {
  const template = await fs.readFile(path.join(__dirname, '../assets/viewer.html'), 'utf8');
  let katex = await fs.readFile(path.join(build, 'dependencies/katex/katex.min.css'), 'utf8');
  const fonts = [...new Set([...katex.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(x => x[1]))];
  for (const font of fonts) {
    const data = await fs.readFile(path.join(build, 'dependencies/katex', font));
    katex = katex.replaceAll(`url(${font})`, `url(data:font/woff2;base64,${data.toString('base64')})`);
  }
  // Drop fallback font URLs: every supported Codex browser supports the embedded WOFF2 fonts.
  katex = katex.replace(/,url\(fonts\/[^)]+\) format\("[^"]+"\)/g, '');
  const styles = ['styles/prism_theme/github.css', 'styles/markdown-it-admonition.css', 'styles/markdown-it-callout.css'];
  const css = (await Promise.all(styles.map(file => fs.readFile(path.join(build, file), 'utf8')))).join('\n') + katex;
  const mermaid = await fs.readFile(path.join(build, 'dependencies/mermaid/mermaid.min.js'), 'utf8');
  const hostBridge = suppliedBridge ?? await fs.readFile(path.join(__dirname, '../assets/host-bridge.js'), 'utf8');
  const reader = await fs.readFile(path.join(__dirname, '../assets/reader.js'), 'utf8');
  return template.replace('/* BUNDLED_STYLES */', () => css.replace(/<\/style/gi, '<\\/style'))
    .replace('/* BUNDLED_HOST_BRIDGE */', () => hostBridge.replace(/<\/script/gi, '<\\/script'))
    .replace('/* BUNDLED_MERMAID */', () => mermaid.replace(/<\/script/gi, '<\\/script'))
    .replace('/* BUNDLED_READER */', () => reader.replace(/<\/script/gi, '<\\/script'));
}
module.exports = { render, viewerHtml };
