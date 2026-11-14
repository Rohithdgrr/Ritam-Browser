/**
 * Settings — rendered as the internal page `govind://settings`.
 *
 * Layout follows the chrome://settings pattern: a category rail on the left,
 * the selected category's cards on the right, and a search box that filters
 * the settings categories.
 */

import { $, $$, escapeHtml, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { SEARCH_ENGINES } from '../lib/url.js';
import { store } from '../state/store.js';

const CATEGORIES = [
  { id: 'general', label: 'General', hint: 'Startup, search engine, HTTPS' },
  { id: 'appearance', label: 'Appearance', hint: 'Theme and layout' },
  { id: 'privacy', label: 'Privacy & data', hint: 'Clear browsing data, telemetry' },
  { id: 'permissions', label: 'Permissions', hint: 'Per-site decisions' },
  { id: 'about', label: 'About', hint: 'Version and engine' },
];

const PERMISSION_LABELS = {
  camera: 'Camera',
  microphone: 'Microphone',
  location: 'Location',
  notifications: 'Notifications',
  popups: 'Pop-ups',
  clipboard_read: 'Clipboard read',
};

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'zen-dark' ? 'zen-dark' : 'zen-light');
}

export function settingsCategory() {
  return store.settingsCategory ?? 'general';
}

export function selectSettingsCategory(id) {
  store.settingsCategory = CATEGORIES.some((c) => c.id === id) ? id : 'general';
}

/**
 * Render the settings page into the given container.
 * @param {HTMLElement} container
 */
export async function renderSettingsPage(container) {
  if (!container) return;
  const category = settingsCategory();
  container.innerHTML = `
    <nav class="internal-nav" aria-label="Settings categories">
      <div class="internal-nav-brand"><span class="logo-dot" aria-hidden="true">G</span> Settings</div>
      ${CATEGORIES.map((c) => `
        <button class="internal-nav-item ${c.id === category ? 'active' : ''}" data-settings-category="${c.id}">
          <span>${c.label}</span>
        </button>`).join('')}
      <div class="internal-nav-sep"></div>
      <button class="internal-nav-item" data-settings-category="history">
        <span>History</span>
      </button>
      <button class="internal-nav-item" data-settings-category="downloads">
        <span>Downloads</span>
      </button>
    </nav>
    <div class="internal-main">
      <header class="internal-header">
        <h1>${CATEGORIES.find((c) => c.id === category)?.label ?? 'General'}</h1>
        <div class="internal-search">
          <svg class="icon sm" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
          <input id="settings-search" type="search" spellcheck="false" placeholder="Search settings" aria-label="Search settings" />
        </div>
      </header>
      <div class="internal-body">
        <div class="settings-cards" id="settings-cards"></div>
      </div>
    </div>`;

  await renderCategory(category);
  wireSettingsPage(container);
}

async function renderCategory(category) {
  const host = $('#settings-cards');
  if (!host) return;
  const s = await api.getSettings();

  if (category === 'general') {
    host.innerHTML = `
      <section class="settings-card">
        <div class="setting-row">
          <div><div class="s-title">Restore previous session</div>
            <div class="s-desc">Reopen the tabs and workspace you had open when you last closed Govind.</div></div>
          <label class="switch"><input type="checkbox" id="setting-restore-session" ${s.restore_session === 'true' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Default search engine</div>
            <div class="s-desc">Used when the address bar contains a query instead of a URL.</div></div>
          <select id="setting-search-engine">
            ${SEARCH_ENGINES.map((e) => `<option value="${e.id}" ${s.search_engine === e.id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')}
          </select>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Always use HTTPS</div>
            <div class="s-desc">Upgrade http:// navigations to https:// when possible. Pages that fail over HTTPS are left untouched (no silent downgrade).</div></div>
          <label class="switch"><input type="checkbox" id="setting-https-first" ${s.https_first !== 'false' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
      </section>`;
    return;
  }

  if (category === 'appearance') {
    host.innerHTML = `
      <section class="settings-card">
        <div class="setting-row">
          <div><div class="s-title">Theme</div>
            <div class="s-desc">Warm paper (Zen Light) or a calm dark palette (Zen Dark).</div></div>
          <select id="setting-theme">
            <option value="zen-light" ${s.theme !== 'zen-dark' ? 'selected' : ''}>Zen Light (paper)</option>
            <option value="zen-dark" ${s.theme === 'zen-dark' ? 'selected' : ''}>Zen Dark</option>
          </select>
        </div>
      </section>`;
    return;
  }

  if (category === 'privacy') {
    host.innerHTML = `
      <section class="settings-card">
        <div class="setting-row">
          <div><div class="s-title">Telemetry &amp; crash reporting</div>
            <div class="s-desc">Disabled. Govind sends no analytics anywhere. There is nothing to turn on yet.</div></div>
          <span class="chip selected" aria-disabled="true">Off, always</span>
        </div>
      </section>
      <section class="settings-card danger-zone">
        <h4>Clear browsing data</h4>
        <div id="clear-data-options" class="chip-row">
          <button class="chip selected" data-clear-category="history" type="button">History</button>
          <button class="chip selected" data-clear-category="downloads" type="button">Download list</button>
          <button class="chip selected" data-clear-category="site_permissions" type="button">Site permissions</button>
        </div>
        <button class="btn-danger" id="btn-clear-browsing-data" type="button">Clear selected data</button>
        <p class="s-desc">Cookie / cache clearing requires native webview profile controls (see docs/ENGINE_SPIKE.md). Bookmarks and notes are never cleared here.</p>
      </section>`;
    return;
  }

  if (category === 'permissions') {
    host.innerHTML = '<section class="settings-card" id="permissions-card"></section>';
    await renderPermissions(host);
    return;
  }

  // About
  const info = await api.getAppInfo().catch(() => null);
  host.innerHTML = `
    <section class="settings-card about-hero">
      <div class="about-logo">G</div>
      <div class="about-name">Govind Browser</div>
      <div class="about-ver">v${info?.version ?? '0.1.0'} · ${info?.milestone ?? 'Milestone 1 — Browser shell'}</div>
    </section>
    <section class="settings-card">
      <table class="about-table">
        <tbody>
          <tr><td>Engine</td><td>${escapeHtml(info?.engine ?? 'System WebView2 via Tauri 2')}</td></tr>
          <tr><td>UI</td><td>HTML · CSS · vanilla JS (no build step)</td></tr>
          <tr><td>Data</td><td>${escapeHtml(info?.storage ?? 'SQLite at the OS app-data directory')}</td></tr>
          <tr><td>Telemetry</td><td>${escapeHtml(info?.telemetry ?? 'disabled')}</td></tr>
          <tr><td>License</td><td>MIT</td></tr>
        </tbody>
      </table>
    </section>`;
}

async function renderPermissions(host) {
  const card = host.querySelector('#permissions-card');
  if (!card) return;
  const rows = await api.listSitePermissions();
  card.innerHTML = rows.length === 0
    ? `<p class="s-desc">No site permission decisions stored yet. When a site asks for camera, microphone, location or notifications, the decision is remembered here.</p>`
    : rows.map((p) => `
      <div class="perm-row">
        <span class="perm-origin" title="${escapeHtml(p.origin)}">${escapeHtml(p.origin)}</span>
        <span class="perm-label">${escapeHtml(PERMISSION_LABELS[p.permission] ?? p.permission)}</span>
        <select class="perm-select" data-origin="${escapeHtml(p.origin)}" data-permission="${escapeHtml(p.permission)}" aria-label="Decision">
          ${['ask', 'allow', 'deny'].map((d) => `<option value="${d}" ${p.decision === d ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </div>`).join('')
    + `<div class="perm-row" style="border-bottom:none;">
         <button class="btn-secondary" id="permissions-clear-all" type="button">Reset all site permissions</button>
       </div>`;
}

function wireSettingsPage(container) {
  const on = (selector, event, handler) =>
    container.querySelector(selector)?.addEventListener(event, handler);

  on('#setting-restore-session', 'change', async (e) => {
    store.settings.restore_session = e.target.checked ? 'true' : 'false';
    await api.setSetting('restore_session', store.settings.restore_session);
    toast(e.target.checked ? 'Session restore enabled.' : 'Session restore disabled.');
  });

  on('#setting-search-engine', 'change', async (e) => {
    store.settings.search_engine = e.target.value;
    await api.setSetting('search_engine', e.target.value);
    toast('Search engine updated.');
  });

  on('#setting-https-first', 'change', async (e) => {
    store.settings.https_first = e.target.checked ? 'true' : 'false';
    await api.setSetting('https_first', store.settings.https_first);
    toast(e.target.checked ? 'HTTPS-first enabled.' : 'HTTPS-first disabled.');
  });

  on('#setting-theme', 'change', async (e) => {
    store.settings.theme = e.target.value;
    applyTheme(e.target.value);
    await api.setSetting('theme', e.target.value);
  });

  // Category rail
  container.querySelectorAll('[data-settings-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-settings-category');
      if (id === 'history' || id === 'downloads') {
        document.dispatchEvent(new CustomEvent('govind:open-internal', { detail: id }));
        return;
      }
      selectSettingsCategory(id);
      renderSettingsPage(container);
    });
  });

  // Clear-data chips
  const selected = new Set(['history', 'downloads', 'site_permissions']);
  container.querySelectorAll('#clear-data-options [data-clear-category]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cat = chip.getAttribute('data-clear-category');
      if (selected.has(cat)) selected.delete(cat); else selected.add(cat);
      chip.classList.toggle('selected', selected.has(cat));
    });
  });

  on('#btn-clear-browsing-data', 'click', async () => {
    if (selected.size === 0) { toast('Select at least one category.'); return; }
    const result = await api.clearBrowsingData([...selected]);
    document.dispatchEvent(new CustomEvent('govind:history-changed'));
    toast(`Cleared — history: ${result.history}, downloads: ${result.downloads}, permissions: ${result.site_permissions}.`);
  });

  // Permissions
  container.addEventListener('change', async (e) => {
    const select = e.target.closest('.perm-select');
    if (!select) return;
    await api.setSitePermission(
      select.getAttribute('data-origin'),
      select.getAttribute('data-permission'),
      select.value,
    );
    toast('Permission updated.');
  });

  on('#permissions-clear-all', 'click', async () => {
    const n = await api.clearSitePermissions();
    await renderCategory(settingsCategory());
    toast(`Reset ${n} permission ${n === 1 ? 'entry' : 'entries'}.`);
  });

  // Settings search filters the category rail
  on('#settings-search', 'input', (e) => {
    const query = e.target.value.trim().toLowerCase();
    container.querySelectorAll('.internal-nav-item').forEach((item) => {
      const label = item.textContent.trim().toLowerCase();
      item.classList.toggle('hidden', !!query && !label.includes(query));
    });
  });
}
