(() => {
  const tokenStorageKey = 'zer0:adminToken';
  const pageSizeStorageKey = 'zer0:adminPageSize';
  const allowedPageSizes = [10, 25, 50, 100];
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const countryNames = {
    ZA: 'South Africa',
    US: 'United States',
    GB: 'United Kingdom',
    IT: 'Italy',
    DE: 'Germany',
    FR: 'France',
    ES: 'Spain',
    NL: 'Netherlands',
    AU: 'Australia',
    CA: 'Canada',
    BR: 'Brazil',
    IN: 'India',
    JP: 'Japan',
    CN: 'China',
    RU: 'Russia',
    ZZ: 'Unknown',
  };
  const importFields = [
    { key: 'targetUrl', label: 'Target URL', required: true, aliases: ['targeturl', 'target', 'url', 'longurl', 'destination', 'destinationurl'] },
    { key: 'code', label: 'Slug', aliases: ['code', 'slug', 'source', 'shortcode', 'shorturl'], manualPlaceholder: 'Optional value for every row' },
    { key: 'createdAt', label: 'Created at', aliases: ['createdat', 'created', 'createdon'], manualPlaceholder: 'YYYY-MM-DD or ISO date' },
    { key: 'validityDays', label: 'Validity days', aliases: ['validitydays', 'retentiondays', 'expiresindays'], manualPlaceholder: '0 for indefinite' },
    { key: 'expiresAt', label: 'Expires at', aliases: ['expiresat', 'expires', 'expiry', 'expiration'], manualPlaceholder: 'Optional ISO date' },
    { key: 'totalClicks', label: 'Total clicks', aliases: ['totalclicks', 'clicks', 'visits', 'hits'], manualPlaceholder: '0' },
    { key: 'countriesJson', label: 'Countries JSON', aliases: ['countriesjson', 'countries', 'countrystats'], manualPlaceholder: '{"ZZ":0}' },
  ];

  const elements = {
    authPanel: document.querySelector('#auth-panel'),
    dashboardPanel: document.querySelector('#dashboard-panel'),
    authForm: document.querySelector('#admin-form'),
    authToken: document.querySelector('#admin-token'),
    authStatus: document.querySelector('#auth-status'),
    status: document.querySelector('#status'),
    summary: document.querySelector('#summary'),
    results: document.querySelector('#results'),
    logout: document.querySelector('#logout'),
    refresh: document.querySelector('#refresh'),
    exportData: document.querySelector('#export-data'),
    openImport: document.querySelector('#open-import'),
    search: document.querySelector('#link-search'),
    pageSize: document.querySelector('#page-size'),
    editDialog: document.querySelector('#edit-dialog'),
    editForm: document.querySelector('#edit-form'),
    editOriginalCode: document.querySelector('#edit-original-code'),
    editCode: document.querySelector('#edit-code'),
    editTarget: document.querySelector('#edit-target'),
    editValidity: document.querySelector('#edit-validity'),
    editStatus: document.querySelector('#edit-status'),
    clicksDialog: document.querySelector('#clicks-dialog'),
    clicksTotal: document.querySelector('#clicks-total'),
    clicksLink: document.querySelector('#clicks-link'),
    clicksCountryList: document.querySelector('#clicks-country-list'),
    deleteDialog: document.querySelector('#delete-dialog'),
    deleteForm: document.querySelector('#delete-form'),
    deleteCode: document.querySelector('#delete-code'),
    deleteCopy: document.querySelector('#delete-copy'),
    deleteStatus: document.querySelector('#delete-status'),
    importDialog: document.querySelector('#import-dialog'),
    importForm: document.querySelector('#import-form'),
    importFile: document.querySelector('#import-file'),
    importBack: document.querySelector('#import-back'),
    importNext: document.querySelector('#import-next'),
    importSubmit: document.querySelector('#submit-import'),
    importFinish: document.querySelector('#finish-import'),
    importStatus: document.querySelector('#import-status'),
    mappingFields: document.querySelector('#mapping-fields'),
    importReviewCopy: document.querySelector('#import-review-copy'),
    importPreview: document.querySelector('#import-preview'),
    importResult: document.querySelector('#import-result'),
  };

  const savedPageSize = normalizePageSize(localStorage.getItem(pageSizeStorageKey));
  elements.pageSize.value = String(savedPageSize);

  const state = {
    links: [],
    page: 1,
    pageSize: savedPageSize,
    searchQuery: '',
    token: '',
    import: emptyImportState(),
  };

  elements.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await verifyAdminAccess(elements.authToken.value.trim());
  });

  elements.refresh.addEventListener('click', async () => {
    if (state.token) await loadLinks(state.token, { persistToken: false, resetPage: false });
  });

  elements.exportData.addEventListener('click', exportLinks);
  elements.openImport.addEventListener('click', openImportDialog);
  elements.logout.addEventListener('click', logout);

  elements.pageSize.addEventListener('change', () => {
    state.pageSize = normalizePageSize(elements.pageSize.value);
    elements.pageSize.value = String(state.pageSize);
    localStorage.setItem(pageSizeStorageKey, String(state.pageSize));
    state.page = 1;
    renderDashboard();
  });

  elements.search.addEventListener('input', () => {
    state.searchQuery = elements.search.value.trim().toLowerCase();
    state.page = 1;
    renderDashboard();
  });

  elements.results.addEventListener('click', (event) => {
    const clicksButton = event.target.closest('[data-clicks-code]');
    if (clicksButton) {
      openClicksDialog(clicksButton.dataset.clicksCode);
      return;
    }
    const editButton = event.target.closest('[data-edit-code]');
    if (editButton) {
      openEditDialog(editButton.dataset.editCode);
      return;
    }
    const deleteButton = event.target.closest('[data-delete-code]');
    if (deleteButton) {
      openDeleteDialog(deleteButton.dataset.deleteCode);
    }
  });

  elements.editForm.addEventListener('submit', saveLink);
  elements.deleteForm.addEventListener('submit', deleteLink);
  elements.importForm.addEventListener('submit', submitImport);
  elements.importNext.addEventListener('click', advanceImport);
  elements.importBack.addEventListener('click', retreatImport);
  elements.importFinish.addEventListener('click', () => closeDialog(elements.importDialog));
  elements.importFile.addEventListener('change', readImportFile);
  elements.importForm.addEventListener('change', (event) => {
    if (event.target.name === 'importMode') resetImportFileState();
  });

  document.addEventListener('click', (event) => {
    const closeButton = event.target.closest('[data-close-dialog]');
    if (!closeButton) return;
    const dialog = document.getElementById(closeButton.dataset.closeDialog);
    if (dialog) closeDialog(dialog);
  });

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
  }

  const savedToken = localStorage.getItem(tokenStorageKey);
  if (savedToken) {
    elements.authToken.value = savedToken;
    loadLinks(savedToken, { persistToken: false, resetPage: true });
  } else {
    setAuthenticated(false);
  }

  async function verifyAdminAccess(adminToken) {
    if (!adminToken) {
      setStatus(elements.authStatus, 'Enter the admin token to continue.', 'error');
      elements.authToken.focus();
      return;
    }

    const payload = Object.fromEntries(new FormData(elements.authForm).entries());
    payload.adminToken = adminToken;
    setStatus(elements.authStatus, 'Verifying access...');

    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (window.turnstile) window.turnstile.reset();
        clearStoredToken();
        setAuthenticated(false);
        setStatus(elements.authStatus, data.error || 'Failed to verify admin access.', 'error');
        return;
      }
      await loadLinks(adminToken, { persistToken: true, resetPage: true });
    } catch {
      if (window.turnstile) window.turnstile.reset();
      setAuthenticated(false);
      setStatus(elements.authStatus, 'Could not verify admin access. Try again.', 'error');
    }
  }

  async function loadLinks(adminToken, { persistToken, resetPage }) {
    if (!adminToken) {
      setStatus(elements.authStatus, 'Enter the admin token to continue.', 'error');
      elements.authToken.focus();
      return;
    }

    state.token = adminToken;
    setStatus(elements.authStatus, 'Loading dashboard...');
    setStatus(elements.status, 'Loading links...');
    elements.results.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch('/api/admin/links', {
        headers: { 'X-Admin-Token': adminToken },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) clearStoredToken();
        setAuthenticated(false);
        setStatus(elements.authStatus, data.error || 'Failed to load links.', 'error');
        return;
      }

      if (persistToken) localStorage.setItem(tokenStorageKey, adminToken);
      state.links = Array.isArray(data.links) ? data.links : [];
      if (resetPage) state.page = 1;
      setAuthenticated(true);
      renderDashboard();
    } catch {
      setAuthenticated(false);
      setStatus(elements.authStatus, 'Could not reach the server. Try again.', 'error');
    } finally {
      elements.results.setAttribute('aria-busy', 'false');
    }
  }

  function setAuthenticated(authenticated) {
    elements.authPanel.hidden = authenticated;
    elements.dashboardPanel.hidden = !authenticated;
    elements.authToken.required = !authenticated;
    if (authenticated) {
      setStatus(elements.authStatus, '');
    } else {
      elements.summary.innerHTML = '';
      elements.results.innerHTML = '';
    }
  }

  function logout() {
    clearStoredToken();
    state.token = '';
    state.links = [];
    state.page = 1;
    state.searchQuery = '';
    elements.authToken.value = '';
    elements.search.value = '';
    setAuthenticated(false);
    setStatus(elements.authStatus, 'Logged out. Enter the admin token to reconnect.');
    elements.authToken.focus();
  }

  function clearStoredToken() {
    localStorage.removeItem(tokenStorageKey);
  }

  function renderDashboard() {
    const filteredLinks = matchingLinks();
    const pageCount = Math.max(1, Math.ceil(filteredLinks.length / state.pageSize));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    const start = (state.page - 1) * state.pageSize;
    const visibleLinks = filteredLinks.slice(start, start + state.pageSize);
    const totalClicks = state.links.reduce((sum, link) => sum + (Number(link.totalClicks) || 0), 0);
    const finiteLinks = state.links.filter((link) => link.expiresAt).length;

    elements.summary.innerHTML = [
      summaryItem('Total links', state.links.length),
      summaryItem('Total clicks', totalClicks),
      summaryItem('Expiring', finiteLinks),
      summaryItem('Indefinite', state.links.length - finiteLinks),
    ].join('');

    if (state.links.length === 0) {
      elements.results.innerHTML = emptyState('No links yet', 'Create a short link from the public page, then refresh this dashboard.');
      setStatus(elements.status, 'Dashboard loaded. No links yet.');
      return;
    }

    if (filteredLinks.length === 0) {
      elements.results.innerHTML = emptyState('No matching links', 'Try a different slug or destination search.');
      setStatus(elements.status, `No matches for "${state.searchQuery}".`);
      return;
    }

    const rows = visibleLinks.map(renderLinkRow).join('');
    elements.results.innerHTML = `
      <div class="table-shell">
        <table class="link-table">
          <thead>
            <tr>
              <th scope="col">Link</th>
              <th scope="col">Destination</th>
              <th scope="col">Clicks</th>
              <th scope="col">Validity</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${renderPager(pageCount, start, filteredLinks.length)}
      </div>
    `;

    const end = Math.min(start + state.pageSize, filteredLinks.length);
    const prefix = state.searchQuery ? `Matching "${state.searchQuery}": ` : '';
    setStatus(elements.status, `${prefix}showing ${start + 1}-${end} of ${filteredLinks.length} links.`);
    bindPager();
  }

  function summaryItem(label, value) {
    return `<div class="summary-item"><span class="summary-label">${escapeHtml(label)}</span><strong class="summary-value">${Number(value).toLocaleString()}</strong></div>`;
  }

  function renderLinkRow(link) {
    const totalClicks = Number(link.totalClicks || 0);
    const validity = validityData(link);
    return `
      <tr>
        <td data-label="Link">
          <a class="link-primary" href="${escapeAttribute(link.shortUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.code)}</a>
          <span class="cell-meta">${escapeHtml(link.shortUrl)}</span>
        </td>
        <td data-label="Destination">
          <a class="destination-link" href="${escapeAttribute(link.targetUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.targetUrl)}</a>
        </td>
        <td data-label="Clicks">
          <button
            type="button"
            class="click-count-button"
            data-clicks-code="${escapeAttribute(link.code)}"
            aria-label="View country breakdown for ${totalClicks.toLocaleString()} clicks on ${escapeAttribute(link.code)}"
          >${totalClicks.toLocaleString()}</button>
        </td>
        <td data-label="Validity">
          <div class="validity-inline">
            <span class="status-badge" data-tone="${validity.tone}">${escapeHtml(validity.label)}</span>
            <span class="validity-detail">${escapeHtml(validity.detail)}</span>
          </div>
        </td>
        <td data-label="Actions">
          <div class="row-actions">
            <button type="button" class="row-action" data-edit-code="${escapeAttribute(link.code)}">Edit</button>
            <button type="button" class="row-action row-action-danger" data-delete-code="${escapeAttribute(link.code)}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderPager(pageCount, start, total) {
    const end = Math.min(start + state.pageSize, total);
    return `
      <nav class="pager" aria-label="Pagination">
        <span class="pager-label">${start + 1}-${end} of ${total}</span>
        <div class="pager-actions">
          <button type="button" class="button button-secondary" data-page-direction="previous"${state.page <= 1 ? ' disabled' : ''}>Previous</button>
          <button type="button" class="button button-secondary" data-page-direction="next"${state.page >= pageCount ? ' disabled' : ''}>Next</button>
        </div>
      </nav>
    `;
  }

  function bindPager() {
    elements.results.querySelector('[data-page-direction="previous"]')?.addEventListener('click', () => {
      state.page -= 1;
      renderDashboard();
    });
    elements.results.querySelector('[data-page-direction="next"]')?.addEventListener('click', () => {
      state.page += 1;
      renderDashboard();
    });
  }

  function matchingLinks() {
    if (!state.searchQuery) return state.links;
    return state.links.filter((link) => (
      String(link.code || '').toLowerCase().includes(state.searchQuery)
      || String(link.targetUrl || '').toLowerCase().includes(state.searchQuery)
    ));
  }

  function openClicksDialog(code) {
    const link = state.links.find((candidate) => candidate.code === code);
    if (!link) return;

    const totalClicks = Math.max(0, Number(link.totalClicks) || 0);
    const countries = Object.entries(link.countries || {})
      .map(([country, count]) => [String(country || 'ZZ').toUpperCase(), Math.max(0, Number(count) || 0)])
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1]);

    elements.clicksTotal.textContent = totalClicks.toLocaleString();
    elements.clicksLink.textContent = link.code;
    elements.clicksCountryList.innerHTML = countries.length > 0
      ? countries.map(([country, count]) => countryBreakdownRow(country, count, totalClicks)).join('')
      : '<div class="country-empty"><strong>No country data</strong><p>This link has no geographically attributed clicks yet.</p></div>';
    openDialog(elements.clicksDialog, elements.clicksDialog.querySelector('[data-close-dialog]'));
  }

  function countryBreakdownRow(country, count, totalClicks) {
    const percentage = totalClicks > 0 ? Math.min(100, (count / totalClicks) * 100) : 0;
    return `
      <div class="country-row">
        <span class="country-flag" aria-hidden="true">${countryFlag(country)}</span>
        <div class="country-details">
          <div>
            <strong>${escapeHtml(countryName(country))}</strong>
            <span>${Number(count).toLocaleString()}</span>
          </div>
          <div class="country-meter" aria-hidden="true">
            <span style="width: ${percentage.toFixed(2)}%"></span>
          </div>
        </div>
        <span class="country-share">${formatPercentage(percentage)}</span>
      </div>
    `;
  }

  function countryFlag(code) {
    const normalized = String(code || 'ZZ').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized) || normalized === 'ZZ') {
      return String.fromCodePoint(0x1f30d);
    }
    return String.fromCodePoint(...[...normalized].map((character) => 0x1f1e6 + character.charCodeAt(0) - 65));
  }

  function formatPercentage(value) {
    if (value <= 0) return '0%';
    if (value < 1) return '<1%';
    return `${Math.round(value)}%`;
  }

  function openEditDialog(code) {
    const link = state.links.find((candidate) => candidate.code === code);
    if (!link) return;
    elements.editOriginalCode.value = link.code;
    elements.editCode.value = link.code;
    elements.editTarget.value = link.targetUrl;
    elements.editValidity.value = normalizeDays(link.validityDays);
    setStatus(elements.editStatus, '');
    openDialog(elements.editDialog, elements.editCode);
  }

  async function saveLink(event) {
    event.preventDefault();
    const originalCode = elements.editOriginalCode.value;
    const updates = {
      code: elements.editCode.value.trim(),
      targetUrl: elements.editTarget.value.trim(),
      validityDays: normalizeDays(elements.editValidity.value),
    };
    const submitButton = elements.editForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    setStatus(elements.editStatus, `Saving /${originalCode}...`);

    try {
      const response = await fetch(`/api/admin/links/${encodeURIComponent(originalCode)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'X-Admin-Token': state.token },
        body: JSON.stringify(updates),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) logout();
        setStatus(elements.editStatus, data.error || `Failed to save /${originalCode}.`, 'error');
        return;
      }

      const index = state.links.findIndex((link) => link.code === originalCode);
      if (index >= 0) state.links[index] = data;
      state.links.sort((left, right) => left.code.localeCompare(right.code));
      closeDialog(elements.editDialog);
      renderDashboard();
      setStatus(elements.status, `/${data.code} saved.`, 'success');
    } catch {
      setStatus(elements.editStatus, 'Could not reach the server. Try again.', 'error');
    } finally {
      submitButton.disabled = false;
    }
  }

  function openDeleteDialog(code) {
    const link = state.links.find((candidate) => candidate.code === code);
    if (!link) return;
    elements.deleteCode.value = link.code;
    elements.deleteCopy.textContent = `Delete /${link.code}?`;
    setStatus(elements.deleteStatus, '');
    openDialog(elements.deleteDialog, elements.deleteForm.querySelector('.button-danger'));
  }

  async function deleteLink(event) {
    event.preventDefault();
    const code = elements.deleteCode.value;
    const submitButton = elements.deleteForm.querySelector('[type="submit"]');
    submitButton.disabled = true;
    setStatus(elements.deleteStatus, `Deleting /${code}...`);

    try {
      const response = await fetch(`/api/admin/links/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Token': state.token },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) logout();
        setStatus(elements.deleteStatus, data.error || `Failed to delete /${code}.`, 'error');
        return;
      }

      state.links = state.links.filter((link) => link.code !== code);
      closeDialog(elements.deleteDialog);
      renderDashboard();
      setStatus(elements.status, data.deleted ? `/${code} deleted.` : `/${code} was already gone.`, 'success');
    } catch {
      setStatus(elements.deleteStatus, 'Could not reach the server. Try again.', 'error');
    } finally {
      submitButton.disabled = false;
    }
  }

  async function exportLinks() {
    if (!state.token) return;
    elements.exportData.disabled = true;
    setStatus(elements.status, 'Preparing export...');
    try {
      const response = await fetch('/api/admin/export', {
        headers: { 'X-Admin-Token': state.token },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) logout();
        setStatus(elements.status, data.error || 'Failed to export links.', 'error');
        return;
      }
      const blob = await response.blob();
      const download = document.createElement('a');
      download.href = URL.createObjectURL(blob);
      download.download = exportFilename(response.headers.get('content-disposition'));
      document.body.append(download);
      download.click();
      URL.revokeObjectURL(download.href);
      download.remove();
      setStatus(elements.status, 'Export downloaded.', 'success');
    } catch {
      setStatus(elements.status, 'Could not reach the server. Try again.', 'error');
    } finally {
      elements.exportData.disabled = false;
    }
  }

  function exportFilename(header) {
    const match = String(header || '').match(/filename="([^"]+)"/);
    return match ? match[1] : 'zer0-export.json';
  }

  function openImportDialog() {
    resetImportWorkflow();
    openDialog(elements.importDialog, elements.importFile);
  }

  function resetImportWorkflow() {
    state.import = emptyImportState();
    elements.importForm.reset();
    elements.mappingFields.innerHTML = '';
    elements.importPreview.innerHTML = '';
    elements.importResult.innerHTML = '';
    setStatus(elements.importStatus, '');
    setImportStep('select');
  }

  function resetImportFileState() {
    state.import = emptyImportState();
    elements.importFile.value = '';
    elements.mappingFields.innerHTML = '';
    elements.importPreview.innerHTML = '';
    setStatus(elements.importStatus, '');
    setImportStep('select');
  }

  async function readImportFile() {
    const file = elements.importFile.files?.[0];
    state.import = emptyImportState();
    elements.mappingFields.innerHTML = '';
    elements.importPreview.innerHTML = '';
    setStatus(elements.importStatus, '');
    if (!file) return;

    const mode = importMode();
    try {
      const text = await file.text();
      if (mode === 'zer0') {
        const parsed = JSON.parse(text);
        if (!parsed || parsed.app !== 'zer0' || !Array.isArray(parsed.links)) {
          throw new Error('Choose a valid zer0 export JSON file.');
        }
        state.import = {
          ...emptyImportState(),
          mode,
          payload: { mode: 'zer0', export: parsed },
          sourceCount: parsed.links.length,
        };
        setStatus(elements.importStatus, `${parsed.links.length} links ready to review.`, 'success');
        return;
      }

      const csvRows = parseCsv(text);
      if (csvRows.length < 2) throw new Error('CSV must include a header row and at least one data row.');
      const headers = csvRows[0].map((header) => String(header || '').trim());
      const rows = csvRows.slice(1)
        .map((row, index) => ({ row, rowNumber: index + 2 }))
        .filter(({ row }) => row.some((value) => String(value || '').trim() !== ''))
        .map(({ row, rowNumber }) => {
          const values = Object.fromEntries(headers.map((header, index) => [header, row[index] || '']));
          return { ...values, __zer0RowNumber: rowNumber };
        });
      if (rows.length === 0) throw new Error('CSV has no importable data rows.');
      state.import = {
        ...emptyImportState(),
        mode,
        headers,
        rows,
        sourceCount: rows.length,
      };
      renderMappingFields();
      setStatus(elements.importStatus, `${rows.length} CSV rows ready to map.`, 'success');
    } catch (error) {
      state.import = emptyImportState();
      setStatus(elements.importStatus, error.message || 'Failed to read import file.', 'error');
    }
  }

  function advanceImport() {
    if (!state.import.sourceCount) {
      setStatus(elements.importStatus, 'Choose a valid file before continuing.', 'error');
      elements.importFile.focus();
      return;
    }

    if (state.import.step === 'select') {
      if (state.import.mode === 'custom') {
        setImportStep('map');
      } else {
        renderImportReview();
        setImportStep('review');
      }
      return;
    }

    if (state.import.step === 'map') {
      const records = buildCustomImportRecords();
      if (!records) return;
      state.import.records = records;
      state.import.payload = { mode: 'custom', records };
      renderImportReview();
      setImportStep('review');
    }
  }

  function retreatImport() {
    if (state.import.step === 'map') {
      setImportStep('select');
    } else if (state.import.step === 'review') {
      setImportStep(state.import.mode === 'custom' ? 'map' : 'select');
    }
  }

  function setImportStep(step) {
    state.import.step = step;
    for (const panel of elements.importDialog.querySelectorAll('[data-import-step]')) {
      panel.hidden = panel.dataset.importStep !== step;
    }
    for (const indicator of elements.importDialog.querySelectorAll('[data-step-indicator]')) {
      if (indicator.dataset.stepIndicator === step) {
        indicator.setAttribute('aria-current', 'step');
      } else {
        indicator.removeAttribute('aria-current');
      }
    }
    elements.importBack.hidden = !['map', 'review'].includes(step);
    elements.importNext.hidden = !['select', 'map'].includes(step);
    elements.importSubmit.hidden = step !== 'review';
    elements.importFinish.hidden = step !== 'result';
    setStatus(elements.importStatus, '');
  }

  function renderMappingFields() {
    elements.mappingFields.innerHTML = importFields.map((field) => {
      const selected = defaultHeaderFor(field);
      const options = [
        `<option value="">${field.required ? 'Choose source column' : 'Use manual/default value'}</option>`,
        ...state.import.headers.map((header) => `<option value="${escapeAttribute(header)}"${header === selected ? ' selected' : ''}>${escapeHtml(header)}</option>`),
      ].join('');
      const manualField = field.required ? '' : `
        <div class="field">
          <label for="manual-${escapeAttribute(field.key)}">Manual value</label>
          <input id="manual-${escapeAttribute(field.key)}" data-import-manual="${escapeAttribute(field.key)}" placeholder="${escapeAttribute(field.manualPlaceholder)}" autocomplete="off">
        </div>
      `;
      return `
        <div class="mapping-field">
          <div class="field">
            <label for="map-${escapeAttribute(field.key)}">${escapeHtml(field.label)}${field.required ? ' *' : ''}</label>
            <select id="map-${escapeAttribute(field.key)}" data-import-field="${escapeAttribute(field.key)}">${options}</select>
          </div>
          ${manualField}
        </div>
      `;
    }).join('');
  }

  function defaultHeaderFor(field) {
    return state.import.headers.find((header) => field.aliases.includes(normalizeHeader(header))) || '';
  }

  function buildCustomImportRecords() {
    const mapping = {};
    const manualValues = {};
    for (const field of importFields) {
      const selected = elements.mappingFields.querySelector(`[data-import-field="${field.key}"]`)?.value || '';
      if (field.required && !selected) {
        setStatus(elements.importStatus, `${field.label} must be mapped before continuing.`, 'error');
        elements.mappingFields.querySelector(`[data-import-field="${field.key}"]`)?.focus();
        return null;
      }
      mapping[field.key] = selected;
      manualValues[field.key] = elements.mappingFields.querySelector(`[data-import-manual="${field.key}"]`)?.value || '';
    }

    return state.import.rows.map((row) => {
      const record = { row: row.__zer0RowNumber };
      for (const field of importFields) {
        const header = mapping[field.key];
        const value = header && row[header] !== undefined && row[header] !== ''
          ? row[header]
          : manualValues[field.key];
        if (value !== undefined && value !== '') record[field.key] = value;
      }
      return record;
    });
  }

  function renderImportReview() {
    const records = state.import.mode === 'custom'
      ? state.import.records
      : state.import.payload.export.links.map((link, index) => ({
          row: index + 1,
          code: link.code,
          targetUrl: link.targetUrl,
          validityDays: link.validityDays,
          totalClicks: link.stats?.totalClicks,
        }));
    elements.importReviewCopy.textContent = `${records.length} links will be imported. Existing slugs will be skipped.`;
    const rows = records.slice(0, 8).map((record) => `
      <tr>
        <td>${Number(record.row || 0)}</td>
        <td>${escapeHtml(record.code || 'Generated')}</td>
        <td>${escapeHtml(record.targetUrl || '')}</td>
        <td>${escapeHtml(record.validityDays === undefined || record.validityDays === '' ? 'Default' : record.validityDays)}</td>
        <td>${Number(record.totalClicks || 0).toLocaleString()}</td>
      </tr>
    `).join('');
    elements.importPreview.innerHTML = `
      <table class="preview-table">
        <thead><tr><th>Row</th><th>Slug</th><th>Destination</th><th>Validity</th><th>Clicks</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  async function submitImport(event) {
    event.preventDefault();
    if (state.import.step !== 'review' || !state.import.payload) return;
    elements.importSubmit.disabled = true;
    setStatus(elements.importStatus, 'Importing links...');
    try {
      const response = await fetch('/api/admin/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Admin-Token': state.token },
        body: JSON.stringify(state.import.payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) logout();
        setStatus(elements.importStatus, data.error || 'Import failed.', 'error');
        return;
      }
      renderImportResult(data);
      setImportStep('result');
      if (data.imported > 0) {
        await loadLinks(state.token, { persistToken: false, resetPage: false });
      }
    } catch {
      setStatus(elements.importStatus, 'Could not reach the server. Try again.', 'error');
    } finally {
      elements.importSubmit.disabled = false;
    }
  }

  function renderImportResult(data) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const notableRows = rows.filter((row) => row.status !== 'imported');
    const resultRows = notableRows.map((row) => `
      <tr>
        <td>${Number(row.row || 0)}</td>
        <td>${escapeHtml(row.code || '')}</td>
        <td>${escapeHtml(row.status || '')}</td>
        <td>${escapeHtml(row.reason || '')}</td>
      </tr>
    `).join('');
    elements.importResult.innerHTML = `
      <div class="section-heading">
        <h3>Import complete</h3>
        <p>${notableRows.length ? 'Review the rows that need attention.' : 'Every row imported successfully.'}</p>
      </div>
      <div class="import-summary">
        ${importSummaryItem('Imported', data.imported)}
        ${importSummaryItem('Skipped', data.skipped)}
        ${importSummaryItem('Expired', data.expired)}
        ${importSummaryItem('Failed', data.failed)}
      </div>
      ${notableRows.length ? `
        <div class="table-scroll">
          <table class="result-table">
            <thead><tr><th>Row</th><th>Slug</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>${resultRows}</tbody>
          </table>
        </div>
      ` : ''}
    `;
  }

  function importSummaryItem(label, value) {
    return `<div class="import-summary-item"><span>${escapeHtml(label)}</span><strong>${Number(value || 0)}</strong></div>`;
  }

  function importMode() {
    return elements.importForm.elements.importMode.value;
  }

  function emptyImportState() {
    return {
      step: 'select',
      mode: 'zer0',
      payload: null,
      headers: [],
      rows: [],
      records: [],
      sourceCount: 0,
    };
  }

  function openDialog(dialog, focusTarget) {
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => focusTarget?.focus());
  }

  function closeDialog(dialog) {
    if (dialog.open) dialog.close();
  }

  function emptyState(title, copy) {
    return `<div class="empty-state"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p></div>`;
  }

  function validityData(link) {
    const expiresAt = link.expiresAt ? new Date(link.expiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.valueOf())) {
      return { label: 'Indefinite', detail: 'No expiry', tone: 'success' };
    }
    const remainingDays = Number.isFinite(Number(link.expiresInDays))
      ? Math.max(0, Math.ceil(Number(link.expiresInDays)))
      : Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / millisecondsPerDay));
    return {
      label: remainingDays <= 7 ? 'Expiring soon' : 'Finite',
      detail: remainingDays === 1 ? '1 day remaining' : `${remainingDays} days remaining`,
      tone: remainingDays <= 7 ? 'warning' : '',
    };
  }

  function countryName(code) {
    const normalized = String(code || 'ZZ').trim().toUpperCase();
    if (countryNames[normalized]) return countryNames[normalized];
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' }).of(normalized) || normalized;
    } catch {
      return normalized;
    }
  }

  function normalizeDays(value) {
    if (value === undefined || value === null || value === '') return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.floor(parsed);
  }

  function normalizePageSize(value) {
    const parsed = Number(value);
    return allowedPageSizes.includes(parsed) ? parsed : 25;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const next = text[index + 1];
      if (quoted) {
        if (character === '"' && next === '"') {
          value += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          value += character;
        }
        continue;
      }
      if (character === '"') {
        quoted = true;
      } else if (character === ',') {
        row.push(value);
        value = '';
      } else if (character === '\n') {
        row.push(value);
        rows.push(row);
        row = [];
        value = '';
      } else if (character !== '\r') {
        value += character;
      }
    }
    if (quoted) throw new Error('CSV has an unterminated quoted value.');
    row.push(value);
    if (row.some((item) => item !== '') || rows.length === 0) rows.push(row);
    return rows;
  }

  function normalizeHeader(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function setStatus(element, message, tone = '') {
    element.textContent = message;
    if (tone) {
      element.dataset.tone = tone;
    } else {
      delete element.dataset.tone;
    }
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
