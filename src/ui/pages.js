const THEME_STORAGE_KEY = 'zer0:theme';

export function renderHomePage({ siteKey, captchaEnabled, retentionDays, adminOnlyMode }) {
  const retentionCopy = retentionDays > 0
    ? `The default is ${retentionDays} days. Set 0 for no expiry.`
    : 'Links do not expire by default. Enter a positive number to add an expiry.';
  const captchaMarkup = renderCaptcha({ siteKey, captchaEnabled });

  return renderDocument({
    title: 'zer0 URL shortener',
    bodyClass: 'public-page',
    styles: ['/assets/public.css'],
    scripts: ['/assets/public.js'],
    captchaScript: captchaEnabled,
    bodyAttributes: `data-admin-only="${adminOnlyMode}"`,
    content: `
      ${renderSiteHeader({ adminLink: true })}
      <main class="public-main" id="main-content">
        <section class="creator-tool" aria-labelledby="creator-title">
          <div class="creator-heading">
            <p class="eyebrow">Private by design. Fast by default.</p>
            <h1 id="creator-title">Shorten a URL</h1>
            <p>Turn long links into clean, memorable URLs you control.</p>
          </div>

          ${adminOnlyMode ? `
            <section id="creation-auth" class="unlock-panel" aria-labelledby="creation-auth-title">
              <div>
                <p class="section-kicker">Restricted creator</p>
                <h2 id="creation-auth-title">Unlock link creation</h2>
                <p id="admin-token-help">This instance requires an admin token to create links. Redirects remain public.</p>
              </div>
              <form id="admin-token-form" class="unlock-form">
                <div class="field">
                  <label for="admin-token">Admin token</label>
                  <div class="input-action">
                    <input id="admin-token" name="adminToken" type="password" autocomplete="current-password" required aria-describedby="admin-token-help" placeholder="Enter admin token">
                    <button type="submit" class="button button-primary">Unlock</button>
                  </div>
                </div>
                <div class="captcha-area">
                  ${captchaMarkup}
                </div>
              </form>
              <p id="auth-status" class="status-message" aria-live="polite"></p>
            </section>
          ` : ''}

          <section id="creator-panel" class="creator-panel"${adminOnlyMode ? ' hidden' : ''}>
            <form id="shorten-form" class="creator-form">
              <div class="field field-prominent">
                <label for="url">Destination URL</label>
                <input id="url" name="url" type="url" required autocomplete="url" placeholder="https://example.com/a/long/path">
              </div>

              <div class="settings-grid">
                <div class="field">
                  <div class="field-label-row">
                    <span class="label-help-group">
                      <label for="slug">Custom slug <span>Optional</span></label>
                      <span class="tooltip-wrapper">
                        <button type="button" class="tooltip-trigger" aria-label="Custom slug requirements" aria-describedby="slug-help">?</button>
                        <span id="slug-help" class="tooltip-bubble" role="tooltip">3-48 letters, numbers, underscores, or dashes.</span>
                      </span>
                    </span>
                    <button type="button" id="generate-slug" class="text-button">Generate</button>
                  </div>
                  <div class="slug-input">
                    <span aria-hidden="true">/</span>
                    <input id="slug" name="slug" pattern="[A-Za-z0-9_-]{3,48}" minlength="3" maxlength="48" autocomplete="off" aria-describedby="slug-help" placeholder="project-update">
                  </div>
                </div>

                <div class="field validity-field">
                  <div class="field-label-row">
                    <span class="label-help-group">
                      <label for="validity-days">Validity</label>
                      <span class="tooltip-wrapper">
                        <button type="button" class="tooltip-trigger" aria-label="Validity help" aria-describedby="validity-help">?</button>
                        <span id="validity-help" class="tooltip-bubble" role="tooltip">${escapeHtml(retentionCopy)}</span>
                      </span>
                    </span>
                  </div>
                  <div class="number-input">
                    <input id="validity-days" name="validityDays" type="number" min="0" step="1" inputmode="numeric" value="${retentionDays}" aria-describedby="validity-help">
                    <span>days</span>
                  </div>
                </div>
              </div>

              ${adminOnlyMode ? '' : `
                <div class="captcha-area">
                  ${captchaMarkup}
                </div>
              `}

              <div class="form-actions">
                <button type="submit" id="shorten-submit" class="button button-primary button-wide">Create short link</button>
              </div>
            </form>

            <section id="result" class="result-panel" aria-live="polite" aria-atomic="true" hidden></section>
          </section>
        </section>
      </main>
      ${renderFooter()}
    `,
  });
}

export function renderAdminPage({ siteKey = '', captchaEnabled = false } = {}) {
  const captchaMarkup = renderCaptcha({ siteKey, captchaEnabled });

  return renderDocument({
    title: 'zer0 admin',
    bodyClass: 'admin-page',
    styles: ['/assets/admin.css'],
    scripts: ['/assets/admin.js'],
    captchaScript: captchaEnabled,
    content: `
      ${renderSiteHeader({ homeLink: true })}
      <main class="admin-main" id="main-content">
        <section id="auth-panel" class="auth-tool" aria-labelledby="auth-title">
          <div class="auth-heading">
            <p class="eyebrow">Administration</p>
            <h1 id="auth-title">Manage your links</h1>
            <p id="admin-token-help">Enter the admin token for this zer0 instance. A successful token is stored in this browser.</p>
          </div>
          <form id="admin-form" class="auth-form">
            <div class="field">
              <label for="admin-token">Admin token</label>
              <input id="admin-token" name="token" type="password" autocomplete="current-password" required aria-describedby="admin-token-help" placeholder="Enter admin token">
            </div>
            <div class="captcha-area">
              ${captchaMarkup}
            </div>
            <button type="submit" class="button button-primary button-wide">Open dashboard</button>
          </form>
          <p id="auth-status" class="status-message" aria-live="polite"></p>
        </section>

        <section id="dashboard-panel" class="dashboard" aria-labelledby="dashboard-title" hidden>
          <header class="workspace-header">
            <div>
              <p class="section-kicker">Administration</p>
              <h1 id="dashboard-title">Links</h1>
            </div>
            <div class="workspace-actions">
              <button type="button" id="refresh" class="button button-secondary">Refresh</button>
              <button type="button" id="export-data" class="button button-secondary">Export</button>
              <button type="button" id="open-import" class="button button-primary">Import</button>
              <button type="button" id="logout" class="button button-quiet">Log out</button>
            </div>
          </header>

          <section id="summary" class="summary-band" aria-label="Dashboard summary"></section>

          <div class="list-toolbar">
            <div class="field search-field">
              <label class="sr-only" for="link-search">Search links</label>
              <input id="link-search" type="search" autocomplete="off" placeholder="Search slug or destination">
            </div>
            <label class="page-size" for="page-size">
              <span>Rows</span>
              <select id="page-size">
                <option>10</option>
                <option selected>25</option>
                <option>50</option>
                <option>100</option>
              </select>
            </label>
          </div>

          <p id="status" class="status-message" aria-live="polite"></p>
          <section id="results" class="link-results" aria-busy="false"></section>
        </section>
      </main>

      <dialog id="edit-dialog" class="dialog sheet-dialog" aria-labelledby="edit-title">
        <form id="edit-form" class="dialog-layout">
          <header class="dialog-header">
            <div>
              <p class="section-kicker">Link settings</p>
              <h2 id="edit-title">Edit link</h2>
            </div>
            <button type="button" class="icon-text-button" data-close-dialog="edit-dialog">Close</button>
          </header>
          <div class="dialog-content">
            <input id="edit-original-code" name="originalCode" type="hidden">
            <div class="field">
              <label for="edit-code">Slug</label>
              <div class="slug-input">
                <span aria-hidden="true">/</span>
                <input id="edit-code" name="code" pattern="[A-Za-z0-9_-]{3,48}" minlength="3" maxlength="48" required>
              </div>
              <p class="field-help">Changing the slug changes the public short URL.</p>
            </div>
            <div class="field">
              <label for="edit-target">Destination URL</label>
              <input id="edit-target" name="targetUrl" type="url" required>
            </div>
            <div class="field">
              <label for="edit-validity">Validity</label>
              <div class="number-input">
                <input id="edit-validity" name="validityDays" type="number" min="0" step="1" inputmode="numeric" required>
                <span>days</span>
              </div>
              <p class="field-help">Use 0 to keep this link valid indefinitely. Positive values start from save time.</p>
            </div>
            <p id="edit-status" class="status-message" aria-live="polite"></p>
          </div>
          <footer class="dialog-footer">
            <button type="button" class="button button-secondary" data-close-dialog="edit-dialog">Cancel</button>
            <button type="submit" class="button button-primary">Save changes</button>
          </footer>
        </form>
      </dialog>

      <dialog id="clicks-dialog" class="dialog clicks-dialog" aria-labelledby="clicks-title">
        <div class="dialog-layout">
          <header class="dialog-header">
            <div>
              <p class="section-kicker">Click analytics</p>
              <h2 id="clicks-title">Country breakdown</h2>
            </div>
            <button type="button" class="icon-text-button" data-close-dialog="clicks-dialog">Close</button>
          </header>
          <div class="dialog-content">
            <div class="clicks-overview">
              <div>
                <span>Total clicks</span>
                <strong id="clicks-total">0</strong>
              </div>
              <p id="clicks-link"></p>
            </div>
            <div id="clicks-country-list" class="country-list"></div>
          </div>
          <footer class="dialog-footer">
            <button type="button" class="button button-primary" data-close-dialog="clicks-dialog">Done</button>
          </footer>
        </div>
      </dialog>

      <dialog id="delete-dialog" class="dialog confirm-dialog" aria-labelledby="delete-title">
        <form id="delete-form" class="dialog-layout">
          <header class="dialog-header">
            <div>
              <p class="section-kicker danger-text">Destructive action</p>
              <h2 id="delete-title">Delete link?</h2>
            </div>
          </header>
          <div class="dialog-content">
            <p id="delete-copy"></p>
            <p class="field-help">The short URL, metadata, and click statistics will be removed. The slug becomes available again.</p>
            <input id="delete-code" name="code" type="hidden">
            <p id="delete-status" class="status-message" aria-live="polite"></p>
          </div>
          <footer class="dialog-footer">
            <button type="button" class="button button-secondary" data-close-dialog="delete-dialog">Cancel</button>
            <button type="submit" class="button button-danger">Delete link</button>
          </footer>
        </form>
      </dialog>

      <dialog id="import-dialog" class="dialog workflow-dialog" aria-labelledby="import-title">
        <form id="import-form" class="dialog-layout">
          <header class="dialog-header">
            <div>
              <p class="section-kicker">Data migration</p>
              <h2 id="import-title">Import links</h2>
            </div>
            <button type="button" class="icon-text-button" data-close-dialog="import-dialog">Close</button>
          </header>
          <div class="dialog-content">
            <ol class="stepper" aria-label="Import progress">
              <li data-step-indicator="select">Choose file</li>
              <li data-step-indicator="map">Map fields</li>
              <li data-step-indicator="review">Review</li>
              <li data-step-indicator="result">Results</li>
            </ol>

            <section data-import-step="select">
              <fieldset class="choice-group">
                <legend>Import format</legend>
                <label class="choice-card">
                  <input type="radio" name="importMode" value="zer0" checked>
                  <span><strong>zer0 backup</strong><small>Restore a JSON export with metadata and statistics.</small></span>
                </label>
                <label class="choice-card">
                  <input type="radio" name="importMode" value="custom">
                  <span><strong>Custom CSV</strong><small>Map columns from another application into zer0 fields.</small></span>
                </label>
              </fieldset>
              <div class="field">
                <label for="import-file">File</label>
                <input id="import-file" type="file" accept=".json,.csv,application/json,text/csv">
                <p class="field-help">Existing slugs are skipped. Other valid rows continue importing.</p>
              </div>
            </section>

            <section data-import-step="map" hidden>
              <div class="section-heading">
                <h3>Map CSV columns</h3>
                <p>Choose a source column or provide one value for every imported row.</p>
              </div>
              <div id="mapping-fields" class="mapping-grid"></div>
            </section>

            <section data-import-step="review" hidden>
              <div class="section-heading">
                <h3>Review import</h3>
                <p id="import-review-copy"></p>
              </div>
              <div id="import-preview" class="table-scroll"></div>
            </section>

            <section data-import-step="result" hidden>
              <div id="import-result"></div>
            </section>

            <p id="import-status" class="status-message" aria-live="polite"></p>
          </div>
          <footer class="dialog-footer">
            <button type="button" id="import-back" class="button button-secondary" hidden>Back</button>
            <span class="dialog-spacer"></span>
            <button type="button" id="import-next" class="button button-primary">Continue</button>
            <button type="submit" id="submit-import" class="button button-primary" hidden>Import links</button>
            <button type="button" id="finish-import" class="button button-primary" hidden>Done</button>
          </footer>
        </form>
      </dialog>

      ${renderFooter()}
    `,
  });
}

export function renderInvalidLinkPage() {
  return renderDocument({
    title: 'Link no longer valid - zer0',
    bodyClass: 'public-page error-page',
    styles: ['/assets/public.css'],
    content: `
      ${renderSiteHeader({ homeLink: true })}
      <main class="error-main" id="main-content">
        <section class="error-tool" aria-labelledby="invalid-link-title">
          <div class="error-code" aria-hidden="true">404</div>
          <p class="eyebrow">Link unavailable</p>
          <h1 id="invalid-link-title">This zer0 link is no longer valid</h1>
          <p>It may have expired, been removed, or never existed. Ask the sender for a fresh link.</p>
          <div class="button-row">
            <a class="button button-primary" href="/">Create a new link</a>
            <button type="button" class="button button-secondary" data-go-back>Go back</button>
          </div>
        </section>
      </main>
      ${renderFooter()}
    `,
  });
}

function renderDocument({
  title,
  bodyClass,
  styles = [],
  scripts = [],
  captchaScript = false,
  bodyAttributes = '',
  content,
}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <script>${themeBootstrapScript()}</script>
  <link rel="stylesheet" href="/assets/common.css">
  ${styles.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n  ')}
  <script src="/assets/theme.js" defer></script>
  ${scripts.map((src) => `<script src="${src}" defer></script>`).join('\n  ')}
  ${captchaScript ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
</head>
<body class="${bodyClass}" ${bodyAttributes}>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  ${content}
</body>
</html>`;
}

function renderSiteHeader({ homeLink = false, adminLink = false } = {}) {
  return `
    <header class="site-header">
      <a class="brand" href="/" aria-label="zer0 home">
        <span class="brand-mark" aria-hidden="true">0</span>
        <span>zer0</span>
      </a>
      <div class="site-header-actions">
        ${homeLink ? '<a class="header-link" href="/">Create link</a>' : ''}
        ${adminLink ? '<a class="header-link" href="/admin">Admin</a>' : ''}
        ${renderThemeControl()}
      </div>
    </header>
  `;
}

function renderThemeControl() {
  return `
    <div class="theme-control" role="group" aria-label="Color theme">
      <button type="button" data-theme-value="system" aria-pressed="true">System</button>
      <button type="button" data-theme-value="light" aria-pressed="false">Light</button>
      <button type="button" data-theme-value="dark" aria-pressed="false">Dark</button>
    </div>
  `;
}

function renderFooter() {
  return `
    <footer class="site-footer">
      <p>Made with ❤️ in Cape Town.</p>
      <a href="https://github.com/neoemit/zer0" target="_blank" rel="noopener noreferrer">View source on GitHub</a>
    </footer>
  `;
}

function themeBootstrapScript() {
  return `(()=>{try{const p=localStorage.getItem('${THEME_STORAGE_KEY}')||'system';const d=p==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;document.documentElement.dataset.theme=d;document.documentElement.dataset.themePreference=p;document.documentElement.style.colorScheme=d}catch{}})();`;
}

function renderCaptcha({ siteKey, captchaEnabled }) {
  return captchaEnabled
    ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}"></div>`
    : '<p class="field-help">CAPTCHA is disabled on this instance.</p>';
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
