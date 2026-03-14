/* ==========================================================================
   Drendel Gap Scanner — Dashboard JS
   ========================================================================== */

const API = {
  alerts:  '/api/alerts',
  zones:   '/api/zones',
  status:  '/api/status',
  settings:'/api/settings',
  watchlist:'/api/watchlist',
  setup:   '/api/setup',
  reinit:  '/api/reinitialize',
};

let state = {
  activeTab: 'scanner',
  alerts: { support: [], resistance: [], untested: [] },
  zones: [],
  status: {},
  settings: {},
  refreshTimer: null,
  zoneSortCol: 'distance_pct',
  zoneSortDir: 'asc',
  zoneFilter: 'all',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ==========================================================================
   Logout & Auth (must be before init so flags are available)
   ========================================================================== */

let _isLoggingOut = false;
let _hasRedirected = false;

// Save original fetch before wrapping
const _origFetch = window.fetch;

async function doLogout() {
  _isLoggingOut = true;
  stopAutoRefresh();

  // Show logout overlay
  showLogoutOverlay();

  // Call logout API in background
  try {
    await _origFetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}

  // Let the animation play for a smooth feel
  await sleep(1200);

  // Navigate to login page
  window.location.replace('/login');
}

function showLogoutOverlay() {
  // Create a full-screen overlay for logout
  const overlay = document.createElement('div');
  overlay.id = 'logout-overlay';
  overlay.innerHTML = `
    <div style="text-align:center;max-width:360px;padding:20px;">
      <div style="width:48px;height:48px;font-size:22px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--support-accent),var(--accent));color:white;font-weight:700;margin:0 auto 20px;">G</div>
      <div style="font-size:15px;font-weight:500;color:var(--text-primary);margin-bottom:20px;">Logging out...</div>
      <div style="width:240px;height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;margin:0 auto;">
        <div id="logout-bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--support-accent),var(--accent));border-radius:2px;transition:width 1.1s cubic-bezier(0.4,0,0.2,1);"></div>
      </div>
    </div>
  `;
  overlay.style.cssText = 'position:fixed;inset:0;z-index:600;background:var(--bg-primary);display:flex;align-items:center;justify-content:center;';
  document.body.appendChild(overlay);

  // Trigger the bar animation on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const bar = document.getElementById('logout-bar');
      if (bar) bar.style.width = '100%';
    });
  });
}

// Global fetch wrapper that redirects to login on 401
window.fetch = async function(...args) {
  if (_isLoggingOut || _hasRedirected) {
    return new Response('{}', { status: 0 });
  }
  const resp = await _origFetch.apply(this, args);
  if (resp.status === 401 && !_hasRedirected && args[0] && typeof args[0] === 'string' && args[0].startsWith('/api/') && !args[0].includes('/auth/')) {
    _hasRedirected = true;
    _isLoggingOut = true;
    stopAutoRefresh();
    showLogoutOverlay();
    await sleep(800);
    window.location.replace('/login');
  }
  return resp;
};

/* ==========================================================================
   Init
   ========================================================================== */

document.addEventListener('DOMContentLoaded', async () => {
  // Auth gate: verify session FIRST before doing anything.
  // This prevents 401 spam if the browser loaded a cached dashboard page.
  try {
    const authResp = await _origFetch('/api/auth/status');
    const authData = await authResp.json();
    if (!authData.authenticated) {
      window.location.replace('/login');
      return;
    }
  } catch (e) {
    // Server unreachable, let it proceed and the polling will handle it
  }

  setupTabs();
  await initWithLoadingScreen();
});

async function initWithLoadingScreen() {
  const overlay = document.getElementById('init-overlay');
  const statusText = document.getElementById('init-status-text');
  const detail = document.getElementById('init-detail');
  const progressBar = document.getElementById('init-progress-bar');

  if (!overlay) {
    // No overlay (shouldn't happen), just init normally
    await normalInit();
    return;
  }

  // Start indeterminate progress
  progressBar.classList.add('indeterminate');

  // Poll status until initialized
  let attempts = 0;
  const maxAttempts = 120; // 2 minutes max wait

  while (attempts < maxAttempts) {
    if (_isLoggingOut || _hasRedirected) return;

    try {
      const resp = await _origFetch(API.status);
      if (resp.status === 401) {
        // Not authenticated — go to login page and stop
        _hasRedirected = true;
        window.location.replace('/login');
        return;
      }
      state.status = await resp.json();

      const s = state.status;

      if (s.initialized && s.zone_count > 0) {
        // Fully loaded
        progressBar.classList.remove('indeterminate');
        progressBar.style.width = '100%';
        statusText.textContent = 'Ready!';
        detail.textContent = `${s.symbol_count} symbols · ${s.zone_count} zones`;

        // Brief pause so user sees "Ready!"
        await sleep(400);

        // Load data and reveal dashboard
        await loadSettings();
        await loadAlerts();
        renderStatus();
        startAutoRefresh();

        // Fade out overlay
        overlay.classList.add('hidden');
        return;

      } else if (s.initialized && s.symbol_count > 0 && s.zone_count === 0) {
        // Initialized but no zones yet (still fetching bars)
        progressBar.classList.remove('indeterminate');
        progressBar.style.width = '70%';
        statusText.textContent = 'Building gap zones...';
        detail.textContent = `${s.symbol_count} symbols loaded`;

      } else if (s.initialized && !s.symbol_count) {
        // Initialized but no watchlist
        progressBar.classList.remove('indeterminate');
        progressBar.style.width = '100%';
        statusText.textContent = 'Ready — add your watchlist to start scanning.';
        detail.textContent = '';

        await loadSettings();
        renderStatus();
        switchTab('setup');
        overlay.classList.add('hidden');
        return;

      } else if (s.error) {
        // Error state — still show dashboard so user can fix settings
        statusText.textContent = 'Scanner needs setup';
        detail.textContent = s.error;

        await sleep(800);
        await loadSettings();
        renderStatus();
        switchTab('setup');
        overlay.classList.add('hidden');
        return;

      } else {
        // Still initializing
        statusText.textContent = 'Loading market data...';
        if (s.symbol_count) {
          detail.textContent = `Fetching data for ${s.symbol_count} symbols...`;
          progressBar.classList.remove('indeterminate');
          progressBar.style.width = '40%';
        } else {
          detail.textContent = 'Connecting to Alpaca...';
        }
      }

    } catch (e) {
      statusText.textContent = 'Connecting to server...';
      detail.textContent = '';
    }

    attempts++;
    await sleep(1500);
  }

  // Timed out — show dashboard anyway
  statusText.textContent = 'Taking longer than expected...';
  await sleep(500);
  await normalInit();
  overlay.classList.add('hidden');
}

async function normalInit() {
  await loadStatus();
  await loadSettings();

  if (!state.status.initialized && !state.settings.alpaca_api_key_display) {
    switchTab('setup');
  } else {
    switchTab('scanner');
    await loadAlerts();
    startAutoRefresh();
  }
}

/* ==========================================================================
   Tabs
   ========================================================================== */

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabId}`));

  if (tabId === 'zones') loadZones();
  if (tabId === 'settings') renderSettings();
}

/* ==========================================================================
   Data Loading
   ========================================================================== */

async function loadAlerts() {
  try {
    const resp = await fetch(API.alerts);
    state.alerts = await resp.json();
    renderAlerts();
    updateAlertCounts();
  } catch (e) {
    console.error('Failed to load alerts:', e);
  }
}

async function loadZones() {
  try {
    const resp = await fetch(API.zones);
    state.zones = await resp.json();
    renderZoneTable();
  } catch (e) {
    console.error('Failed to load zones:', e);
  }
}

async function loadStatus() {
  try {
    const resp = await fetch(API.status);
    state.status = await resp.json();
    renderStatus();
  } catch (e) {
    console.error('Failed to load status:', e);
  }
}

async function loadSettings() {
  try {
    const resp = await fetch(API.settings);
    state.settings = await resp.json();
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

/* ==========================================================================
   Auto-Refresh
   ========================================================================== */

function startAutoRefresh() {
  stopAutoRefresh();
  const intervalSec = state.settings.scan_interval_seconds || 300;
  // UI refreshes at the scan interval, minimum 10s
  const uiInterval = Math.max(intervalSec * 1000, 10000);
  state.refreshTimer = setInterval(async () => {
    await loadAlerts();
    await loadStatus();
    if (state.activeTab === 'zones') await loadZones();
  }, uiInterval);
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

/* ==========================================================================
   Render: Status
   ========================================================================== */

function renderStatus() {
  const s = state.status;
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  if (!dot || !text) return;

  if (s.error) {
    dot.className = 'status-dot error';
    text.textContent = 'Error';
  } else if (s.running) {
    dot.className = 'status-dot active';
    text.textContent = s.last_scan ? `Last scan: ${s.last_scan}` : 'Running...';
  } else if (s.initialized) {
    dot.className = 'status-dot';
    text.textContent = 'Idle (market closed)';
  } else {
    dot.className = 'status-dot';
    text.textContent = 'Not configured';
  }

  const symbolCount = document.getElementById('symbol-count');
  const zoneCount = document.getElementById('zone-count');
  if (symbolCount) symbolCount.textContent = s.symbol_count || 0;
  if (zoneCount) zoneCount.textContent = s.zone_count || 0;
}

function updateAlertCounts() {
  const a = state.alerts;
  const total = (a.support?.length || 0) + (a.resistance?.length || 0) + (a.untested?.length || 0);
  const scannerCount = document.querySelector('[data-tab="scanner"] .tab-count');
  if (scannerCount) scannerCount.textContent = total;
}

/* ==========================================================================
   Render: Alerts
   ========================================================================== */

function renderAlerts() {
  renderAlertSection('support', state.alerts.support || [], 'S', 'Support Gap Alerts');
  renderAlertSection('resistance', state.alerts.resistance || [], 'R', 'Resistance Gap Alerts');
  renderAlertSection('untested', state.alerts.untested || [], 'U', 'Untested Gap Alerts');
}

function renderAlertSection(type, alerts, icon, title) {
  const container = document.getElementById(`alerts-${type}`);
  if (!container) return;

  const headerHtml = `
    <div class="section-header ${type}">
      <div class="section-icon ${type}">${icon}</div>
      <div class="section-title">${title}</div>
      <div class="section-count">${alerts.length} alert${alerts.length !== 1 ? 's' : ''}</div>
    </div>
  `;

  if (alerts.length === 0) {
    container.innerHTML = headerHtml + `
      <div class="empty-state">
        <div class="empty-state-icon">${type === 'support' ? '🟢' : type === 'resistance' ? '🔴' : '🔵'}</div>
        <div class="empty-state-text">No ${type} gap alerts right now.<br>Alerts appear when price enters gap zones.</div>
      </div>
    `;
    return;
  }

  const cardsHtml = alerts.map(a => renderAlertCard(a, type)).join('');
  container.innerHTML = headerHtml + `<div class="alert-grid">${cardsHtml}</div>`;
}

function renderAlertCard(alert, type) {
  const z = alert.zone;
  const badges = [];

  if (alert.is_first_test) badges.push('<span class="badge first-test">First Test</span>');
  if (alert.distance_pct > 0) badges.push(`<span class="badge proximity">${alert.distance_pct.toFixed(1)}% away</span>`);
  if (z.status === 'reduced') badges.push(`<span class="badge reduced">Reduced ${z.reduction_count}x</span>`);

  const penetration = Math.min(alert.penetration_pct, 100);

  return `
    <div class="alert-card ${type}">
      <div class="card-top">
        <span class="card-symbol">${alert.symbol}</span>
        <span class="card-price">$${alert.current_price.toFixed(2)}</span>
      </div>
      ${badges.length ? `<div class="card-badges">${badges.join('')}</div>` : ''}
      <div class="card-zone">
        <div class="zone-field">
          <span class="zone-label">Zone Top</span>
          <span class="zone-value">$${z.zone_top.toFixed(2)}</span>
        </div>
        <div class="zone-field">
          <span class="zone-label">Zone Bottom</span>
          <span class="zone-value">$${z.zone_bottom.toFixed(2)}</span>
        </div>
        <div class="zone-field">
          <span class="zone-label">Zone Size</span>
          <span class="zone-value">${z.zone_size_pct.toFixed(2)}%</span>
        </div>
        <div class="zone-field">
          <span class="zone-label">Age</span>
          <span class="zone-value">${z.age_days}d</span>
        </div>
      </div>
      <div class="card-penetration">
        <div class="penetration-bar-bg">
          <div class="penetration-bar" style="width: ${penetration}%"></div>
        </div>
        <div class="penetration-label">${penetration.toFixed(1)}% into zone</div>
      </div>
    </div>
  `;
}

/* ==========================================================================
   Render: Zone Explorer
   ========================================================================== */

function renderZoneTable() {
  const container = document.getElementById('zone-explorer-content');
  if (!container) return;

  let zones = [...state.zones];

  // Filter
  if (state.zoneFilter !== 'all') {
    zones = zones.filter(z => {
      if (state.zoneFilter === 'support') return z.base_type === 'support' && !z.is_untested;
      if (state.zoneFilter === 'resistance') return z.base_type === 'resistance' && !z.is_untested;
      if (state.zoneFilter === 'untested') return z.is_untested;
      return true;
    });
  }

  // Sort
  const col = state.zoneSortCol;
  const dir = state.zoneSortDir === 'asc' ? 1 : -1;
  zones.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return ((va || 0) - (vb || 0)) * dir;
  });

  // Filter buttons
  const filtersHtml = `
    <div class="table-filters">
      <button class="filter-btn ${state.zoneFilter === 'all' ? 'active' : ''}" onclick="setZoneFilter('all')">All (${state.zones.length})</button>
      <button class="filter-btn ${state.zoneFilter === 'support' ? 'active' : ''}" onclick="setZoneFilter('support')">Support</button>
      <button class="filter-btn ${state.zoneFilter === 'resistance' ? 'active' : ''}" onclick="setZoneFilter('resistance')">Resistance</button>
      <button class="filter-btn ${state.zoneFilter === 'untested' ? 'active' : ''}" onclick="setZoneFilter('untested')">Untested</button>
    </div>
  `;

  const cols = [
    { key: 'symbol', label: 'Symbol' },
    { key: 'gap_type', label: 'Type' },
    { key: 'zone_top', label: 'Zone Top' },
    { key: 'zone_bottom', label: 'Zone Bottom' },
    { key: 'zone_size_pct', label: 'Size %' },
    { key: 'created_date', label: 'Created' },
    { key: 'age_days', label: 'Age' },
    { key: 'test_count', label: 'Tests' },
    { key: 'reduction_count', label: 'Reductions' },
    { key: 'distance_pct', label: 'Distance %' },
  ];

  const thHtml = cols.map(c => {
    let cls = '';
    if (state.zoneSortCol === c.key) cls = state.zoneSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc';
    return `<th class="${cls}" onclick="sortZoneTable('${c.key}')">${c.label}</th>`;
  }).join('');

  const rowsHtml = zones.map(z => {
    const typeClass = z.is_untested ? 'untested' : z.base_type;
    const typeLabel = z.is_untested ? `untested ${z.base_type}` : z.gap_type;
    return `
      <tr>
        <td class="mono" style="font-weight:600;color:var(--text-primary)">${z.symbol}</td>
        <td><span class="zone-type-pill ${typeClass}">${typeLabel}</span></td>
        <td class="mono">$${z.zone_top.toFixed(2)}</td>
        <td class="mono">$${z.zone_bottom.toFixed(2)}</td>
        <td class="mono">${z.zone_size_pct.toFixed(2)}%</td>
        <td class="mono">${z.created_date}</td>
        <td class="mono">${z.age_days}d</td>
        <td class="mono">${z.test_count}</td>
        <td class="mono">${z.reduction_count}</td>
        <td class="mono" style="color:${(z.distance_pct || 0) <= 1 ? 'var(--warning)' : 'inherit'}">${(z.distance_pct || 0).toFixed(2)}%</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = filtersHtml + `
    <div class="zone-table-wrap">
      <table class="zone-table">
        <thead><tr>${thHtml}</tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="10" style="text-align:center;padding:30px;color:var(--text-muted)">No zones found.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function sortZoneTable(col) {
  if (state.zoneSortCol === col) {
    state.zoneSortDir = state.zoneSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.zoneSortCol = col;
    state.zoneSortDir = 'asc';
  }
  renderZoneTable();
}

function setZoneFilter(filter) {
  state.zoneFilter = filter;
  renderZoneTable();
}

/* ==========================================================================
   Render: Settings
   ========================================================================== */

function renderSettings() {
  // Settings are rendered via static HTML, just populate values
  const s = state.settings;

  setVal('setting-interval', s.scan_interval_seconds);
  setVal('setting-lookback', s.lookback_days);
  setVal('setting-max-gaps', s.max_gaps_per_symbol);
  setVal('setting-support-prox', s.alert_sensitivity?.support_proximity_pct);
  setVal('setting-resistance-prox', s.alert_sensitivity?.resistance_proximity_pct);
  setChecked('setting-first-test-only', s.alert_sensitivity?.alert_on_first_test_only);
  setChecked('setting-show-untested', s.display?.show_untested);
  setChecked('setting-show-age', s.display?.show_age);
  setChecked('setting-compact', s.display?.compact_view);

  // Load watchlist
  loadWatchlistEditor();
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined) el.value = val;
}

function setChecked(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

async function loadWatchlistEditor() {
  try {
    const resp = await fetch(API.watchlist);
    const data = await resp.json();
    const textarea = document.getElementById('watchlist-editor');
    if (textarea) textarea.value = (data.watchlist || []).join('\n');
  } catch (e) {
    console.error('Failed to load watchlist:', e);
  }
}

async function saveSettings() {
  const updates = {
    scan_interval_seconds: parseInt(document.getElementById('setting-interval')?.value) || 300,
    lookback_days: parseInt(document.getElementById('setting-lookback')?.value) || 252,
    max_gaps_per_symbol: parseInt(document.getElementById('setting-max-gaps')?.value) || 50,
    alert_sensitivity: {
      support_proximity_pct: parseFloat(document.getElementById('setting-support-prox')?.value) || 0,
      resistance_proximity_pct: parseFloat(document.getElementById('setting-resistance-prox')?.value) || 0,
      alert_on_first_test_only: document.getElementById('setting-first-test-only')?.checked || false,
    },
    display: {
      show_untested: document.getElementById('setting-show-untested')?.checked ?? true,
      show_age: document.getElementById('setting-show-age')?.checked ?? true,
      compact_view: document.getElementById('setting-compact')?.checked || false,
    },
  };

  try {
    const resp = await fetch(API.settings, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Settings saved.', 'success');
      await loadSettings();
      startAutoRefresh(); // restart with new interval
    } else {
      showToast(data.message || 'Failed to save.', 'error');
    }
  } catch (e) {
    showToast('Error saving settings.', 'error');
  }
}

async function saveWatchlist() {
  const raw = document.getElementById('watchlist-editor')?.value || '';
  // Parse: split by newline, comma, or space
  const symbols = raw
    .split(/[\n,\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(s => s && /^[A-Z.]+$/.test(s));

  const unique = [...new Set(symbols)];

  const btn = document.querySelector('#tab-settings .btn-primary[onclick="saveWatchlist()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="loading-spinner"></span> Saving & Loading Data...'; }

  try {
    const resp = await fetch(API.watchlist, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchlist: unique }),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast(data.message || `Watchlist saved: ${unique.length} symbols.`, 'success');
      document.getElementById('watchlist-editor').value = unique.join('\n');
      await loadStatus();
      await loadAlerts();
      if (state.activeTab === 'zones') await loadZones();
      startAutoRefresh();
    } else {
      showToast('Failed to save watchlist.', 'error');
    }
  } catch (e) {
    showToast('Error saving watchlist.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Watchlist & Reinitialize'; }
  }
}

/* ==========================================================================
   Setup
   ========================================================================== */

async function submitSetup() {
  const apiKey = document.getElementById('setup-api-key')?.value?.trim();
  const secretKey = document.getElementById('setup-secret-key')?.value?.trim();
  const baseUrl = document.getElementById('setup-base-url')?.value?.trim() || 'https://paper-api.alpaca.markets';
  const btn = document.getElementById('setup-submit-btn');

  if (!apiKey || !secretKey) {
    showToast('Both API key and secret are required.', 'error');
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Validating...'; }

  try {
    const resp = await fetch(API.setup, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alpaca_api_key: apiKey, alpaca_secret_key: secretKey, alpaca_base_url: baseUrl }),
    });
    const data = await resp.json();

    if (data.ok) {
      showToast('API keys validated! Setting up scanner...', 'success');
      await loadSettings();
      await loadStatus();
      switchTab('settings'); // Go to settings to add watchlist
      showToast('Now add your watchlist symbols in Settings.', 'success');
    } else {
      showToast(data.message || 'Validation failed.', 'error');
    }
  } catch (e) {
    showToast('Connection error. Check your setup.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Validate & Save'; }
  }
}

/* ==========================================================================
   Toast Notifications
   ========================================================================== */

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.remove(), 3500);
}

/* ==========================================================================
   Force Refresh
   ========================================================================== */

async function forceRefresh() {
  showToast('Refreshing...', 'info');
  await loadAlerts();
  await loadStatus();
  if (state.activeTab === 'zones') await loadZones();
}
