'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { viewerHtml } = require('./render.cjs');

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

async function buildBrowserHtml(output, preferences = {}) {
  const bridge = await fs.readFile(path.join(__dirname, '../assets/browser-bridge.js'), 'utf8');
  const bootstrap = 'window.markdownBrowser=' + scriptJson({
      document: output,
      tocVisible: typeof preferences.tocVisible === 'boolean' ? preferences.tocVisible : true
    }) + ';\n';
  return viewerHtml({ hostBridge: bootstrap + bridge });
}

module.exports = { buildBrowserHtml };
