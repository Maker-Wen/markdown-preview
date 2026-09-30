(() => {
  'use strict';
  const protocolVersion = '2026-01-26';
  const requestPrefix = `markdown-files-${crypto.getRandomValues(new Uint32Array(2)).join('-')}-`;
  let nextId = 0;
  let initialized;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function request(method, params) {
    if (window.parent === window) return Promise.reject(new Error('此页面没有可用的文件宿主。'));
    return new Promise((resolve, reject) => {
      const id = `${requestPrefix}${++nextId}`;
      const finish = (error, result) => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        error ? reject(error) : resolve(result);
      };
      const onMessage = event => {
        const data = event.data;
        if (event.source !== window.parent || !isObject(data)
          || data.jsonrpc !== '2.0' || data.id !== id || 'method' in data) return;
        if (Object.hasOwn(data, 'error')) {
          const error = new Error(typeof data.error?.message === 'string'
            ? data.error.message : '宿主返回了无效的错误响应。');
          if (Number.isInteger(data.error?.code)) error.code = data.error.code;
          finish(error);
        } else if (isObject(data.result)) {
          finish(null, data.result);
        } else {
          finish(new Error('宿主返回了无效的响应。'));
        }
      };
      const timer = setTimeout(() => finish(new Error('等待文件宿主响应超时。')), 10000);
      window.addEventListener('message', onMessage);
      try {
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      } catch (error) {
        finish(error);
      }
    });
  }

  function initialize() {
    initialized ??= request('ui/initialize', {
      protocolVersion,
      appInfo: { name: 'markdown-preview', version: '1.0.0' },
      appCapabilities: {},
    }).then(result => {
      if (result.protocolVersion !== protocolVersion) {
        throw new Error(`宿主使用了不支持的 MCP Apps 协议：${result.protocolVersion ?? '未知'}。`);
      }
      window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
      return result.hostCapabilities;
    }).catch(error => {
      initialized = undefined;
      throw error;
    });
    return initialized;
  }

  window.markdownHost = {
    async openFile(path) {
      if (typeof path !== 'string' || !path.length || path.includes('\0')) {
        throw new Error('文件路径无效。');
      }
      const capabilities = await initialize();
      if (!isObject(capabilities?.experimental?.['openai/files'])) {
        throw new Error('当前宿主不支持从预览打开本地文件。');
      }
      const result = await request('openai/files/open', { path });
      if (result.isError === true) throw new Error('宿主未能打开此文件。');
    },
    async openLink(url) {
      if (typeof url !== 'string' || !url.length || url.includes('\0')) throw new Error('链接无效。');
      const capabilities = await initialize();
      if (!isObject(capabilities?.openLinks)) throw new Error('当前宿主不支持打开外部链接。');
      const result = await request('ui/open-link', { url });
      if (result.isError === true) throw new Error('宿主未能打开此链接。');
    },
  };
})();
