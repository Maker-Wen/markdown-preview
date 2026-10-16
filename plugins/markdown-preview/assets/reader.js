'use strict';

window.initializeReader = function initializeReader({ nodes, host, mermaid }) {
  const $ = id => nodes.get(id);
  let documentOutput;
  let generation = 0;
  let watching;
  let suspended = false;
  const expiredWatches = new Set();
  let browserRequest;
  const appearance = createReaderAppearance(refreshTheme);
  const tocLayout = createTocLayout({
    reader: $('reader'), separator: $('toc-resizer'), toggle: $('toggle-toc'),
    saveVisibility: visible => savePreference('toc', visible ? 'visible' : 'hidden')
  });
  $('open-browser').hidden = typeof host.openBrowser !== 'function';

  function stopWatching() {
    if (watching) clearTimeout(watching.timer);
    watching = undefined;
  }

  function setWatchStatus(message = '', detail = '') {
    $('status').textContent = message;
    $('status').title = detail;
    $('status').hidden = !message;
  }

  function validDocument(output) {
    return output && typeof output.text === 'string' && typeof output.name === 'string'
      && typeof output.resourceUri === 'string' && typeof output.html === 'string'
      && typeof output.toc === 'string' && Number.isFinite(output.bytes);
  }

  function currentWatch(state) {
    return !suspended && watching === state && documentOutput?.watchId === state.watchId
      && documentOutput?.resourceUri === state.resourceUri;
  }

  function scheduleWatch(state, delay = 1000) {
    if (currentWatch(state) && !state.unsupported) {
      state.timer = setTimeout(() => refreshDocument(state), delay);
    }
  }

  async function refreshDocument(state) {
    if (!currentWatch(state)) return;
    try {
      let update;
      try {
        update = await host.refreshDocument(state.watchId, state.revision);
      } catch (error) {
        if (error.code !== 'WATCH_EXPIRED' || !currentWatch(state)) throw error;
        // Sleeping computers and throttled background tabs may outlive a watch lease.
        const reopened = await host.reopenDocument({
          name: documentOutput.name, resourceUri: state.resourceUri
        });
        if (!currentWatch(state)) return;
        if (!validDocument(reopened) || reopened.resourceUri !== state.resourceUri
          || typeof reopened.watchId !== 'string' || !Number.isInteger(reopened.revision)) {
          throw new Error('宿主返回了无效的文档更新。');
        }
        expiredWatches.add(state.watchId);
        await acceptDocument(reopened);
        return;
      }
      if (!currentWatch(state)) return;
      if (update.document) {
        const next = update.document;
        if (!validDocument(next) || next.resourceUri !== state.resourceUri
          || next.watchId !== state.watchId || next.revision !== update.revision) {
          throw new Error('宿主返回了无效的文档更新。');
        }
        if (update.revision > state.revision) await acceptDocument(next);
      } else if (update.revision !== state.revision) {
        throw new Error('文档更新缺少渲染内容。');
      }
      if (!currentWatch(state)) return;
      state.failures = 0;
      state.message = state.detail = '';
      setWatchStatus();
    } catch (error) {
      if (!currentWatch(state)) return;
      state.unsupported = error.unsupported === true;
      state.message = state.unsupported ? '自动刷新不可用' : '自动刷新失败';
      state.detail = error.message;
      state.failures++;
      setWatchStatus(state.message, state.detail);
    } finally {
      scheduleWatch(state, Math.min(10000, 1000 * 2 ** Math.min(state.failures, 4)));
    }
  }

  function watchDocument(output) {
    if (suspended || typeof output.watchId !== 'string' || !Number.isInteger(output.revision)) {
      stopWatching();
      return;
    }
    if (watching?.watchId === output.watchId && watching.resourceUri === output.resourceUri) {
      watching.revision = output.revision;
      return;
    }
    stopWatching();
    watching = { watchId: output.watchId, resourceUri: output.resourceUri,
      revision: output.revision, failures: 0, message: '', detail: '' };
    scheduleWatch(watching);
  }

  function suspend() {
    tocLayout.cancel();
    suspended = true;
    generation++;
    stopWatching();
  }

  function resume() {
    if (!suspended) return;
    suspended = false;
    if (documentOutput) {
      watchDocument(documentOutput);
      // A font wait retired by pagehide still needs a drawing in the current view.
      renderDiagrams();
    }
  }

  function readPreference(name, allowed) {
    try {
      const value = localStorage.getItem('markdown-preview:' + name);
      return allowed.includes(value) ? value : null;
    } catch {
      return null;
    }
  }

  function savePreference(name, value) {
    try {
      localStorage.setItem('markdown-preview:' + name, value);
    } catch {
      // Hosts may disable storage; the controls must still work in this page.
    }
  }

  function refreshTheme(dark) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      themeVariables: { fontFamily: getComputedStyle($('content')).fontFamily }
    });
    if (documentOutput) paintDocument($('main').scrollTop);
  }

  function setError(message) {
    $('error').textContent = message;
    $('error').hidden = !message;
  }

  function showSource(text) {
    const fragment = document.createDocumentFragment();
    const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [''];
    if (/[\r\n]$/.test(text)) lines.push('');
    for (const line of lines) {
      const span = document.createElement('span');
      span.textContent = line;
      fragment.append(span);
    }
    $('source').replaceChildren(fragment);
  }

  function setSourceMode(source) {
    // Changing views retires the previous diagram's error and scroll continuation.
    generation++;
    $('source').hidden = !source;
    $('content').hidden = source;
    $('toggle-source').querySelector('.button-label').textContent = source ? '返回阅读' : '查看源码';
    $('toggle-source').setAttribute('aria-pressed', String(source));
  }

  function showReadError(message) {
    generation++;
    stopWatching();
    documentOutput = null;
    $('open-browser').disabled = true;
    setWatchStatus();
    setError(message);
    $('content').replaceChildren();
    $('toc').replaceChildren();
    $('source').textContent = '';
  }

  async function renderDiagrams(id = generation) {
    if (suspended || $('content').hidden) return;
    try {
      await document.fonts.ready;
      if (suspended || id !== generation || $('content').hidden) return;
      await mermaid.run({ nodes: $('content').querySelectorAll('.mermaid') });
    } catch {
      if (id === generation) {
        setError('有一张图表无法渲染，可切换到源码检查语法。');
      }
    }
  }

  async function acceptDocument(output) {
    // Adapter read failures are values, including an explicitly empty message.
    if (output instanceof Error) {
      showReadError(output.message);
      return;
    }
    if (output?.error) {
      showReadError(typeof output.error === 'string'
        ? output.error : '无法读取文档，请关闭后重新打开。');
      return;
    }
    if (!output) return;
    if (expiredWatches.has(output.watchId)) return;
    if (!validDocument(output)) {
      showReadError('插件返回了无效的文档内容，请关闭后重新打开。');
      return;
    }
    if (documentOutput?.watchId && documentOutput.watchId === output.watchId
      && output.revision < documentOutput.revision) return;

    const sameFile = documentOutput?.resourceUri === output.resourceUri;
    if (!sameFile) tocLayout.reset();
    const scroll = sameFile ? $('main').scrollTop : 0;
    documentOutput = output;
    watchDocument(output);
    await paintDocument(scroll);
  }

  async function paintDocument(scroll) {
    const output = documentOutput;
    const id = ++generation;
    $('open-browser').disabled = Boolean(browserRequest);
    $('name').textContent = output.name;
    document.title = output.name + ' · Markdown Preview';
    showSource(output.text);
    setError('');
    $('content').innerHTML = output.html;
    $('toc').innerHTML = output.toc || '<p>此文档没有标题。</p>';
    setWatchStatus(watching?.message, watching?.detail);
    $('main').scrollTop = scroll;
    await renderDiagrams(id);
    if (id !== generation) return;
    $('main').scrollTo({ top: scroll, behavior: 'instant' });
  }

  document.addEventListener('copy', event => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return;
    const range = selection.getRangeAt(0);
    if (!$('source').contains(range.commonAncestorContainer)) return;
    event.clipboardData.setData('text/plain', range.cloneContents().textContent);
    event.preventDefault();
  });

  $('toggle-source').addEventListener('click', () => {
    const source = $('source').hidden;
    setSourceMode(source);
    if (!source) renderDiagrams();
  });

  $('open-browser').addEventListener('click', async () => {
    if (!documentOutput || browserRequest) return;
    const request = { resourceUri: documentOutput.resourceUri };
    browserRequest = request;
    $('open-browser').disabled = true;
    try {
      setError('');
      await host.openBrowser({
        name: documentOutput.name, resourceUri: request.resourceUri
      }, { tocVisible: $('reader').dataset.toc !== 'hidden' });
    } catch (error) {
      if (documentOutput?.resourceUri === request.resourceUri) setError('无法打开浏览器：' + error.message);
    } finally {
      if (browserRequest === request) browserRequest = undefined;
      $('open-browser').disabled = !documentOutput;
    }
  });

  document.addEventListener('click', async event => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    const documentAtClick = documentOutput;
    const href = link.getAttribute('href');
    try {
      setError('');
      if (link.dataset.linkError) throw new Error(link.dataset.linkError);
      if (link.dataset.filePath) {
        await host.openFile(link.dataset.filePath);
      } else if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        const heading = $('content').querySelector('[id="' + CSS.escape(id) + '"]');
        if (!heading) throw new Error('没有找到链接指向的标题。');
        heading.scrollIntoView({ block: 'start' });
      } else {
        await host.openLink(href);
      }
    } catch (error) {
      if (documentOutput === documentAtClick) setError('无法打开链接：' + error.message);
    }
  });

  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume);
  const { initialDocument, tocVisible, initialAppearance, surface } = host.connect(acceptDocument, appearance.update);
  document.documentElement.dataset.surface = surface === 'browser' ? 'browser' : 'embedded';
  const savedToc = readPreference('toc', ['visible', 'hidden']);
  tocLayout.setVisible(typeof tocVisible === 'boolean'
    ? tocVisible
    : savedToc === null ? !matchMedia('(max-width:700px)').matches : savedToc === 'visible');
  appearance.update(initialAppearance);
  appearance.refresh();
  acceptDocument(initialDocument);
};

function createTocLayout({ reader, separator, toggle, saveVisibility }) {
  const defaultWidth = 200;
  // Operable-pane floors, not a comfortable reading width or a fixed TOC maximum.
  const minimumWidth = 120;
  const minimumBodyWidth = 120;
  const collapseWidth = 60;
  const narrow = matchMedia('(max-width:700px)');
  let preferredWidth = defaultWidth;
  let visible = true;
  let drag;

  const maximumWidth = () => Math.max(minimumWidth, reader.clientWidth - minimumBodyWidth);
  const clampWidth = width => Math.min(maximumWidth(), Math.max(minimumWidth, width));

  function draw() {
    const width = clampWidth(drag ? drag.width : preferredWidth);
    reader.style.setProperty('--toc-width', width + 'px');
    reader.dataset.toc = visible ? 'visible' : 'hidden';
    toggle.setAttribute('aria-expanded', String(visible));
    separator.hidden = !visible || narrow.matches;
    separator.setAttribute('aria-valuemax', String(maximumWidth()));
    separator.setAttribute('aria-valuenow', String(visible ? Math.round(width) : 0));
    separator.setAttribute('aria-valuetext', visible ? Math.round(width) + ' 像素' : '已收起');
  }

  function focusAfterCollapse() {
    if (!visible) toggle.focus({ preventScroll: true });
  }

  function finish(commit) {
    if (!drag) return;
    const finished = drag;
    drag = undefined;
    delete reader.dataset.tocResizing;
    if (commit) {
      // A collapsed gesture preserves the settled width from before it began.
      if (visible && finished.moved) preferredWidth = finished.width;
      if (visible !== finished.visible) saveVisibility(visible);
    } else {
      visible = finished.visible;
    }
    if (reader.hasPointerCapture(finished.pointerId)) reader.releasePointerCapture(finished.pointerId);
    draw();
    focusAfterCollapse();
  }

  function move(event) {
    if (event.pointerId !== drag?.pointerId) return;
    // The media-query change notification may follow the final pointer event.
    if (narrow.matches) {
      finish(false);
      return;
    }
    drag.moved ||= event.clientX !== drag.startX;
    const width = event.clientX - reader.getBoundingClientRect().left - drag.offset;
    // Hysteresis prevents flicker around the snap point.
    if (visible && width <= collapseWidth) visible = false;
    else if (!visible && width >= minimumWidth) visible = true;
    drag.width = clampWidth(width);
    draw();
  }

  separator.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || drag || !visible || narrow.matches) return;
    event.preventDefault();
    separator.focus({ preventScroll: true });
    const width = clampWidth(preferredWidth);
    drag = { pointerId: event.pointerId, width, visible, startX: event.clientX, moved: false,
      offset: event.clientX - reader.getBoundingClientRect().left - width };
    // The reader stays present when the separator is hidden on collapse.
    reader.setPointerCapture(event.pointerId);
    reader.dataset.tocResizing = 'true';
  });
  reader.addEventListener('pointermove', move);
  reader.addEventListener('pointerup', event => {
    if (event.pointerId !== drag?.pointerId) return;
    move(event);
    finish(true);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    reader.addEventListener(type, event => {
      if (event.pointerId === drag?.pointerId) finish(false);
    });
  }
  window.addEventListener('blur', () => finish(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      finish(false);
    }
  });

  separator.addEventListener('keydown', event => {
    if (drag || !visible || narrow.matches) return;
    const step = event.shiftKey ? 40 : 16;
    let width = clampWidth(preferredWidth);
    if (event.key === 'ArrowLeft') width -= step;
    else if (event.key === 'ArrowRight') width += step;
    else if (event.key === 'Home' || event.key === 'Enter') width = 0;
    else if (event.key === 'End') width = maximumWidth();
    else return;
    event.preventDefault();
    // The keyboard can cross the minimum in one step, without a drag gesture.
    if (width < minimumWidth) visible = false;
    else preferredWidth = clampWidth(width);
    draw();
    if (!visible) saveVisibility(false);
    focusAfterCollapse();
  });

  toggle.addEventListener('click', () => {
    finish(false);
    visible = !visible;
    draw();
    saveVisibility(visible);
  });
  narrow.addEventListener('change', () => {
    finish(false);
    draw();
  });
  new ResizeObserver(() => draw()).observe(reader);

  return {
    setVisible(value) {
      finish(false);
      visible = value;
      draw();
    },
    reset() {
      finish(false);
      preferredWidth = defaultWidth;
      draw();
    },
    cancel() { finish(false); }
  };
}
