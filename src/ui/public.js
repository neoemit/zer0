(() => {
  const form = document.querySelector('#shorten-form');
  if (!form) return;

  const result = document.querySelector('#result');
  const slug = document.querySelector('#slug');
  const generateSlug = document.querySelector('#generate-slug');
  const submit = document.querySelector('#shorten-submit');
  const adminOnlyMode = document.body.dataset.adminOnly === 'true';
  const tokenStorageKey = 'zer0:createAdminToken';
  const creationAuth = document.querySelector('#creation-auth');
  const adminTokenForm = document.querySelector('#admin-token-form');
  const adminToken = document.querySelector('#admin-token');
  const authStatus = document.querySelector('#auth-status');
  const creatorPanel = document.querySelector('#creator-panel');
  const adjectives = ['atomic', 'brisk', 'cosmic', 'crisp', 'electric', 'ember', 'frosty', 'golden', 'lunar', 'neon', 'nova', 'pixel', 'quantum', 'rapid', 'solar', 'tidy', 'turbo', 'velvet'];
  const nouns = ['beacon', 'comet', 'falcon', 'fox', 'koala', 'otter', 'panda', 'pulse', 'rocket', 'spark', 'tiger', 'wave', 'wizard', 'yak', 'zephyr'];

  function pick(items) {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return items[values[0] % items.length];
  }

  function randomNumber() {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return String(values[0] % 1000).padStart(3, '0');
  }

  function friendlySlug() {
    return [pick(adjectives), pick(nouns), randomNumber()].join('-');
  }

  function currentCreateToken() {
    return adminOnlyMode ? localStorage.getItem(tokenStorageKey) || '' : '';
  }

  function setStatus(element, message, tone = '') {
    if (!element) return;
    element.textContent = message;
    if (tone) {
      element.dataset.tone = tone;
    } else {
      delete element.dataset.tone;
    }
  }

  function unlockCreator(tokenValue) {
    if (!adminOnlyMode || !tokenValue) return;
    creatorPanel.hidden = false;
    creationAuth.hidden = true;
    setStatus(authStatus, 'Creator unlocked for this browser.', 'success');
    document.querySelector('#url')?.focus();
  }

  function lockCreator(message) {
    if (!adminOnlyMode) return;
    localStorage.removeItem(tokenStorageKey);
    creatorPanel.hidden = true;
    creationAuth.hidden = false;
    adminToken.value = '';
    setStatus(authStatus, message, 'error');
    adminToken.focus();
  }

  if (adminOnlyMode) {
    const storedToken = currentCreateToken();
    if (storedToken) {
      adminToken.value = storedToken;
      unlockCreator(storedToken);
    }

    adminTokenForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const tokenValue = adminToken.value.trim();
      if (!tokenValue) {
        lockCreator('Enter the admin token to unlock link creation.');
        return;
      }
      localStorage.setItem(tokenStorageKey, tokenValue);
      unlockCreator(tokenValue);
    });
  }

  generateSlug.addEventListener('click', () => {
    slug.value = friendlySlug();
    slug.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Creating link...';
    showResult('<p>Creating your short link...</p>', 'loading');

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    if (!payload.slug) delete payload.slug;
    const headers = { 'content-type': 'application/json' };
    if (adminOnlyMode) headers['X-Admin-Token'] = currentCreateToken();

    try {
      const response = await fetch('/api/shorten', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showResult(`<p>${escapeHtml(data.error || 'Failed to create short URL')}</p>`, 'error');
        if (response.status === 401 && adminOnlyMode) {
          lockCreator('The admin token was rejected. Enter the correct token to continue.');
        }
        if (window.turnstile) window.turnstile.reset();
        return;
      }

      const validityCopy = data.expiresInDays === null
        ? 'Valid indefinitely.'
        : `Expires in ${Number(data.expiresInDays)} days.`;
      showResult(`
        <div class="result-heading">
          <h2>Short link ready</h2>
          <span class="status-badge" data-tone="success">Created</span>
        </div>
        <a class="result-link" href="${escapeAttribute(data.shortUrl)}">${escapeHtml(data.shortUrl)}</a>
        <p class="result-meta">${escapeHtml(validityCopy)}</p>
        <div class="result-actions">
          <button type="button" class="button button-primary" data-copy-url="${escapeAttribute(data.shortUrl)}">Copy link</button>
          <a class="button button-secondary" href="${escapeAttribute(data.shortUrl)}" target="_blank" rel="noopener noreferrer">Open link</a>
        </div>
      `, 'success');
      form.reset();
      if (window.turnstile) window.turnstile.reset();
    } catch {
      showResult('<p>Could not reach the server. Check your connection and try again.</p>', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Create short link';
    }
  });

  result.addEventListener('click', async (event) => {
    const copyButton = event.target.closest('[data-copy-url]');
    if (!copyButton) return;
    const originalLabel = copyButton.textContent;
    try {
      await copyText(copyButton.dataset.copyUrl);
      copyButton.textContent = 'Copied';
    } catch {
      copyButton.textContent = 'Copy failed';
    }
    setTimeout(() => {
      copyButton.textContent = originalLabel;
    }, 1600);
  });

  function showResult(html, tone) {
    result.hidden = false;
    result.dataset.tone = tone;
    result.innerHTML = html;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Copy failed');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character]));
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#96;');
  }
})();
