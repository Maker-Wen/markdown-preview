'use strict';

const childProcess = require('node:child_process');

function getBrowserCommand(url, platform = process.platform) {
  if (typeof url !== 'string' || !url.trim() || /[\u0000-\u001f\u007f]/.test(url)) {
    throw new Error('浏览器地址必须是有效的本机 HTTP URL。');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('浏览器地址必须是有效的本机 HTTP URL。');
  }
  const hostname = parsed.hostname;
  const loopback = hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  const hasUserInfo = /^http:\/\/[^/?#\\]*@/i.test(url.trim());
  if (parsed.protocol !== 'http:' || !loopback || parsed.username || parsed.password || hasUserInfo) {
    throw new Error('仅允许打开无凭证的本机 HTTP URL。');
  }

  const target = parsed.href;
  switch (platform) {
    case 'darwin':
      return { file: '/usr/bin/open', args: [target] };
    case 'win32':
      return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] };
    case 'linux':
      return { file: 'xdg-open', args: [target] };
    default:
      throw new Error(`当前平台不支持自动打开浏览器：${platform}`);
  }
}

async function openBrowser(url) {
  const { file, args } = getBrowserCommand(url);
  await new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { shell: false, windowsHide: true, timeout: 15_000 }, error => {
      if (!error) {
        resolve();
        return;
      }
      const failure = new Error('无法打开默认浏览器，请检查系统浏览器设置后重试。', { cause: error });
      failure.code = 'BROWSER_OPEN_FAILED';
      reject(failure);
    });
  });
}

module.exports = { openBrowser, getBrowserCommand };
