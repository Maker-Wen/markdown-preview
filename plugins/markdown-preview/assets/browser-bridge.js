(() => {
  'use strict';
  async function request(action, body) {
    let response;
    try {
      response = await fetch(new URL(action, location.href), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(60000)
      });
    } catch {
      throw new Error('无法连接预览服务，请保持 Codex 聊天开启；服务结束后可从插件重新打开。');
    }
    let output;
    try { output = await response.json(); }
    catch { throw new Error('预览服务返回了无效的响应，请从插件重新打开。'); }
    if (!response.ok) {
      const error = new Error(output.error || '无法更新文档，请从插件重新打开。');
      error.code = output.code || output.errorCode;
      throw error;
    }
    return output;
  }

  window.markdownHost = {
    connect() {
      // Browser pages receive one initial snapshot; saves arrive through refresh.
      return {
        initialDocument: window.markdownBrowser?.document,
        tocVisible: window.markdownBrowser?.tocVisible ?? true
      };
    },
    async refreshDocument(watchId, revision) {
      const output = await request('refresh', { watchId, revision });
      if (output.watchId !== watchId || !Number.isInteger(output.revision) || output.revision < revision) {
        throw new Error('预览服务返回了无效的文档更新。');
      }
      return output;
    },
    async reopenDocument() { return request('reopen', {}); },
    async openFile() {
      throw new Error('浏览器预览暂不支持打开本地文件，请返回 Codex 打开。');
    },
    async openLink(url) {
      if (typeof url !== 'string' || !/^(https?:|mailto:)/i.test(url) || /[\u0000-\u001f]/.test(url)) {
        throw new Error('暂不支持此链接类型。');
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };
})();
