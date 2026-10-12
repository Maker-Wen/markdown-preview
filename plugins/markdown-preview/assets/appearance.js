'use strict';

window.createReaderAppearance = function createReaderAppearance(onChange) {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const properties = new Map([
    ['--color-background-primary', 'color'],
    ['--color-background-secondary', 'color'],
    ['--color-text-primary', 'color'],
    ['--color-text-secondary', 'color'],
    ['--color-text-info', 'color'],
    ['--color-text-danger', 'color'],
    ['--color-border-primary', 'color'],
    ['--font-sans', 'font-family'],
    ['--font-mono', 'font-family']
  ]);
  let hostTheme;
  let fontStyle;
  let fontCss = '';
  let suppliedFontCss;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function refresh(changed = false) {
    const theme = hostTheme ?? (media.matches ? 'dark' : 'light');
    changed ||= root.dataset.theme !== theme;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    if (changed) onChange(theme === 'dark');
  }

  function safeFontCss(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      // Parse without adopting the sheet: imports and ordinary selectors never run.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(value);
      return Array.from(sheet.cssRules).filter(rule => {
        if (rule.type !== CSSRule.FONT_FACE_RULE) return false;
        const src = rule.style.getPropertyValue('src');
        if (!rule.style.getPropertyValue('font-family') || !src) return false;
        const urls = Array.from(src.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi));
        if (!urls.length && !/\blocal\s*\(/i.test(src)) return false;
        return urls.every(match => /^data:(?:font\/[\w-]+|application\/(?:font-woff|x-font-woff|x-font-ttf|x-font-opentype|vnd\.ms-fontobject|octet-stream));/i
          .test((match[1] ?? match[2] ?? match[3]).trim()));
      }).map(rule => rule.cssText).join('\n');
    } catch {
      return '';
    }
  }

  function update(context) {
    if (!isObject(context)) return;
    let changed = false;
    if (Object.hasOwn(context, 'theme')) {
      const theme = context.theme;
      if (theme === 'light' || theme === 'dark' || theme == null) {
        const next = theme ?? undefined;
        changed ||= next !== hostTheme;
        hostTheme = next;
      }
    }
    if (Object.hasOwn(context, 'styles')) {
      const styles = isObject(context.styles) ? context.styles : {};
      const variables = isObject(styles.variables) ? styles.variables : {};
      for (const [name, property] of properties) {
        const value = variables[name];
        const accepted = typeof value === 'string' && value.trim()
          && !/[;{}<>\u0000-\u001f]|url\s*\(|@/i.test(value)
          && CSS.supports(property, value);
        const next = accepted ? value.trim() : '';
        if (root.style.getPropertyValue(name) === next) continue;
        if (next) root.style.setProperty(name, next);
        else root.style.removeProperty(name);
        changed = true;
      }
      const nextSuppliedFontCss = styles.css?.fonts;
      const nextFontCss = nextSuppliedFontCss === suppliedFontCss ? fontCss : safeFontCss(nextSuppliedFontCss);
      suppliedFontCss = nextSuppliedFontCss;
      if (nextFontCss !== fontCss) {
        fontCss = nextFontCss;
        if (fontCss) {
          fontStyle ??= document.createElement('style');
          fontStyle.textContent = fontCss;
          if (!fontStyle.isConnected) document.head.append(fontStyle);
        } else {
          fontStyle?.remove();
        }
        changed = true;
      }
    }
    refresh(changed);
  }

  media.addEventListener('change', () => refresh());
  return { update, refresh };
};
