(() => {
  const storageKey = 'zer0:theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const controls = Array.from(document.querySelectorAll('[data-theme-value]'));

  function preference() {
    const saved = localStorage.getItem(storageKey);
    return ['system', 'light', 'dark'].includes(saved) ? saved : 'system';
  }

  function resolvedTheme(value) {
    return value === 'system' ? (media.matches ? 'dark' : 'light') : value;
  }

  function applyTheme(value, { persist = true } = {}) {
    const safeValue = ['system', 'light', 'dark'].includes(value) ? value : 'system';
    const resolved = resolvedTheme(safeValue);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = safeValue;
    document.documentElement.style.colorScheme = resolved;
    if (persist) localStorage.setItem(storageKey, safeValue);
    for (const control of controls) {
      control.setAttribute('aria-pressed', String(control.dataset.themeValue === safeValue));
    }
  }

  for (const control of controls) {
    control.addEventListener('click', () => applyTheme(control.dataset.themeValue));
  }

  media.addEventListener('change', () => {
    if (preference() === 'system') applyTheme('system', { persist: false });
  });

  document.querySelector('[data-go-back]')?.addEventListener('click', () => {
    if (history.length > 1) {
      history.back();
    } else {
      window.location.assign('/');
    }
  });

  applyTheme(preference(), { persist: false });
})();
