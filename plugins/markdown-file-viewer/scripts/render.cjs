'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { readFileBounded } = require('./files.cjs');
const crossnotePath = require.resolve('crossnote', { paths: [path.join(__dirname, '../runtime/renderer')] });
const { Notebook, MarkdownEngine, utility } = require(crossnotePath);
const cheerio = require(require.resolve('cheerio', { paths: [path.dirname(crossnotePath)] }));
const build = utility.getCrossnoteBuildDirectory();
const notebooks = new Map();
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
    parserConfig: { onWillParseMarkdown: async text => text.replace(/@import\b/g, '&#64;import')
      .replace(/^([^\n]*!\[[^\n]*)$/gm, '$1 <!-- preview-image -->').replace(/!\[\[/g, '\\!\\[\\['),
      onDidParseMarkdown: async html => html }
  } });
  notebook.md.core.ruler.push('readonly-fences', state => {
    const restore = tokens => {
      for (const token of tokens) {
        if (token.children) restore(token.children);
        if (['fence', 'colon_fence', 'code_inline', 'code_block'].includes(token.type)) {
          token.content = token.content.replace(/&#64;import/g, '@import')
            .replace(/ <!-- preview-image -->/g, '').replace(/\\!\\\[\\\[/g, '![[');
        }
      }
    };
    restore(state.tokens);
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
    if (html === '<!-- preview-image -->') return '';
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
  const result = await engine.parseMD(text, { isForPreview: true, useRelativeFilePath: false,
    hideFrontMatter: false, runAllCodeChunks: false, triggeredBySave: false, vscodePreviewPanel: {} });
  const $ = cheerio.load(result.html, {}, false);
  // ponytail: embed at most 5 MiB of local images per document; add streamed resources for larger documents.
  let remaining = 5 * 1024 * 1024;
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
      const bytes = await readFileBounded(imagePath, remaining);
      remaining -= bytes.length;
      $(img).attr('src', `data:${type};base64,${bytes.toString('base64')}`).removeAttr('srcset');
    } catch (error) {
      const reason = error instanceof RangeError ? '图片超过预览大小限制'
        : error.code ? '无法读取' : error.message;
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
    const href = $(a).attr('href');
    if (!/^(#|https?:\/\/|mailto:)/i.test(href)) $(a).removeAttr('href').attr('title', '请从文件列表打开此文档');
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

async function viewerHtml() {
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
  return template.replace('/* BUNDLED_STYLES */', () => css.replace(/<\/style/gi, '<\\/style'))
    .replace('/* BUNDLED_MERMAID */', () => mermaid.replace(/<\/script/gi, '<\\/script'));
}
module.exports = { render, viewerHtml };
