/** Settings modal: general, appearance, privacy & data, permissions, about. */

import { $, $$, escapeHtml, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { SEARCH_ENGINES } from '../lib/url.js';
import { store } from '../state/store.js';

const PERMISSION_LABELS = {
  camera: 'Camera',
  microphone: 'Microphone',
  location: 'Location',
  notifications: 'Notifications',
  popups: 'Pop-ups',
  clipboard_read: 'Clipboard read',
};

export function openSettings(tab = null) {
  $('#settings-modal')?.classList.remove('hidden');
  if (tab) selectSettingsTab(tab);
  void populateSettings();
}
export function closeSettings() {
  $('#settings-modal')?.classList.add('hidden');
}
export function isSettingsOpen() {
  return !$('#settings-modal')?.classList.contains('hidden');
}

function selectSettingsTab(name) {
  $$('[data-settings-tab]').forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-settings-tab') === name));
  $$('.settings-pane').forEach((pane) => pane.classList.toggle('hidden', pane.getAttribute('data-pane') !== name));
}

export async function populateSettings() {
  const s = await api.getSettings();

  // General
  const restore = $('#setting-restore-session');
  if (restore) restore.checked = s.restore_session === 'true';

  const engineSelect = $('#setting-search-engine');
  if (engineSelect && engineSelect.options.length === 0) {
    engineSelect.innerHTML = SEARCH_ENGINES.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
  }
  if (engineSelect) engineSelect.value = s.search_engine;

  const httpsFirst = $('#setting-https-first');
  if (httpsFirst) httpsFirst.checked = s.https_first !== 'false';

  // Appearance
  const theme = $('#setting-theme');
  if (theme) theme.value = s.theme || 'zen-light';

  // About
  try {
    const info = await api.getAppInfo();
    const v = $('#about-version');
    if (v) v.textContent = `v${info.version} · ${info.milestone ?? 'milestone 1'}`;
    const engine = $('#about-engine');
    if (engine) engine.textContent = info.engine;
  } catch { /* non-critical */ }

  await renderPermissions();
}

async function renderPermissions() {
  const list = $('#permissions-list');
  if (!list) return;
  const rows = await api.listSitePermissions();
  list.innerHTML = rows.length === 0
    ? '<p style="color:var(--zen-subtle); font-size:12px; padding:12px 4px; line-height:1.6;">No site permission decisions stored yet. When a site asks for camera, microphone, location or notifications, the decision is remembered here.</p>'
    : rows.map((p) => `
      <div class="perm-row">
        <span class="perm-origin" title="${escapeHtml(p.origin)}">${escapeHtml(p.origin)}</span>
        <span style="color:var(--zen-muted); font-size:11px;">${escapeHtml(PERMISSION_LABELS[p.permission] ?? p.permission)}</span>
        <select class="perm-select" data-origin="${escapeHtml(p.origin)}" data-permission="${escapeHtml(p.permission)}" aria-label="Decision">
          ${['ask', 'allow', 'deny'].map((d) => `<option value="${d}" ${d === p.decision ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </div>`).join('');
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'zen-dark' ? 'zen-dark' : 'zen-light');
}

export function wireSettings() {
  // Nav
  $$('[data-settings-tab]').forEach((btn) =>
    btn.addEventListener('click', () => selectSettingsTab(btn.getAttribute('data-settings-tab')))
  );

  // Close: backdrop click or Escape (Escape handled globally)
  $('#settings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  // General
  $('#setting-restore-session')?.addEventListener('change', async (e) => {
    store.settings.restore_session = e.target.checked ? 'true' : 'false';
    await api.setSetting({ key: 'restore_session', value: store.settings.restore_session });
    toast(e.target.checked ? 'Session restore enabled.' : 'Session restore disabled.');
  });
  $('#setting-search-engine')?.addEventListener('change', async (e) => {
    store.settings.search_engine = e.target.value;
    await api.setSetting({ key: 'search_engine', value: e.target.value });
    toast('Search engine updated.');
  });
  $('#setting-https-first')?.addEventListener('change', async (e) => {
    store.settings.https_first = e.target.checked ? 'true' : 'false';
    await api.setSetting({ key: 'https_first', value: store.settings.https_first });
    toast(e.target.checked ? 'HTTPS-first enabled.' : 'HTTPS-first disabled.');
  });

  // Appearance
  $('#setting-theme')?.addEventListener('change', async (e) => {
    store.settings.theme = e.target.value;
    applyTheme(e.target.value);
    await api.setSetting({ key: 'theme', value: e.target.value });
  });

  // Privacy: clear-data category chips
  const selected = new Set(['history', 'downloads', 'site_permissions']);
  $$('#clear-data-options [data-clear-category]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cat = chip.getAttribute('data-clear-category');
      if (selected.has(cat)) selected.delete(cat); else selected.add(cat);
      chip.classList.toggle('selected', selected.has(cat));
    });
  });
  $('#btn-clear-browsing-data')?.addEventListener('click', async () => {
    if (selected.size === 0) { toast('Select at least one category.'); return; }
    const result = await api.clearBrowsingData({ categories: [...selected] });
    document.dispatchEvent(new CustomEvent('govind:history-changed'));
    toast(`Cleared — history: ${result.history}, downloads: ${result.downloads}, permissions: ${result.site_permissions}.`);
    await renderPermissions();
  });

  // Permissions
  $('#permissions-list')?.addEventListener('change', async (e) => {
    const select = e.target.closest('.perm-select');
    if (!select) return;
    await api.setSitePermission({
      origin: select.getAttribute('data-origin'),
      permission: select.getAttribute('data-permission'),
      decision: select.value,
    });
    toast('Permission updated.');
  });
  $('#permissions-clear-all')?.addEventListener('click', async () => {
    const n = await api.clearSitePermissions({});
    await renderPermissions();
    toast(`Reset ${n} permission ${n === 1 ? 'entry' : 'entries'}.`);
  });
}
