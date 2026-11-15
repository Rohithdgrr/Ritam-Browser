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
import { decryptBrowserBackup, encryptBrowserBackup } from '../lib/encrypted-backup.js';

const CATEGORIES = [
  { id: 'general', label: 'General', hint: 'Startup, search engine, HTTPS' },
  { id: 'data', label: 'Data transfer', hint: 'Encrypted browser backup' },
  { id: 'appearance', label: 'Appearance', hint: 'Theme and web pages' },
  { id: 'autofill', label: 'Autofill', hint: 'Saved names, addresses, cards' },
  { id: 'translation', label: 'Translation', hint: 'LibreTranslate endpoint' },
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
            <div class="s-desc">Used when the address bar contains a query instead of a URL. Pick “Custom…” to use any search URL template.</div></div>
          <div class="engine-controls">
            <select id="setting-search-engine">
              ${SEARCH_ENGINES.map((e) => `<option value="${e.id}" ${s.search_engine === e.id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')}
              <option value="custom" ${s.search_engine === 'custom' ? 'selected' : ''}>Custom…</option>
            </select>
            <input id="setting-custom-search" type="text" spellcheck="false" placeholder="https://example.com/search?q={query}" value="${escapeHtml(s.custom_search_url ?? '')}" class="${s.search_engine === 'custom' ? '' : 'hidden'}" aria-label="Custom search URL template"/>
          </div>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Always use HTTPS</div>
            <div class="s-desc">Upgrade http:// navigations to https:// when possible. Pages that fail over HTTPS are left untouched (no silent downgrade).</div></div>
          <label class="switch"><input type="checkbox" id="setting-https-first" ${s.https_first !== 'false' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
      </section>`;
    return;
  }

  if (category === 'data') {
    host.innerHTML = `
      <section class="settings-card">
        <h4>Encrypted browser backup</h4>
        <p class="s-desc">Export or merge bookmarks, workspaces, tabs, history, notes, download records, reading list, site permissions, and settings. Private tabs and downloaded files are never included. The archive is encrypted on this device with your passphrase; Govind cannot recover a forgotten passphrase.</p>
        <div class="setting-row">
          <div><div class="s-title">Export backup</div>
            <div class="s-desc">Keep the encrypted .gbak file somewhere safe to move it to another device.</div></div>
          <button class="btn-secondary" id="backup-export" type="button">Export encrypted backup…</button>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Import backup</div>
            <div class="s-desc">Import merges data without deleting existing records. Existing bookmarks, tabs, notes, and settings win on conflicts.</div></div>
          <button class="btn-secondary" id="backup-import" type="button">Import encrypted backup…</button>
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
        <div class="setting-row">
          <div><div class="s-title">Force dark mode on websites</div>
            <div class="s-desc">Applies a dark rendering to light pages. Some sites may look unusual.</div></div>
          <label class="switch"><input type="checkbox" id="setting-force-dark-websites" ${s.force_dark_websites === 'true' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
      </section>`;
    return;
  }

  if (category === 'autofill') {
    host.innerHTML = `
      <section class="settings-card">
        <h4>Saved profiles</h4>
        <p class="s-desc">Govind fills recognizable form fields (name, email, phone, address, card) from these profiles. Stored only in the local database — never synced anywhere.</p>
        <div id="autofill-list"></div>
        <div id="autofill-form" class="hidden">
          <div class="setting-row"><div><div class="s-title">Label</div></div>
            <input id="af-label" type="text" spellcheck="false" placeholder="e.g. Work, Personal" maxlength="60"/></div>
          ${[['full_name','Full name'],['email','Email'],['phone','Phone'],['address_line1','Address line 1'],['address_line2','Address line 2'],['city','City'],['region','State / region'],['postal_code','Postal code'],['country','Country'],['card_name','Name on card'],['card_number','Card number'],['card_expiry','Card expiry (MM/YY)'],['card_csc','Security code']]
            .map(([k,l]) => `<div class="setting-row"><div><div class="s-title">${l}</div></div>
              <input id="af-${k}" type="text" spellcheck="false" autocomplete="off"/></div>`).join('')}
          <div class="setting-row">
            <button class="btn-primary" id="af-save" type="button">Save profile</button>
            <button class="btn-secondary" id="af-cancel" type="button">Cancel</button>
          </div>
        </div>
        <div class="setting-row" id="af-add-row">
          <button class="btn-secondary" id="af-add" type="button">Add profile…</button>
        </div>
      </section>`;
    await renderAutofillList(host);
    return;
  }

  if (category === 'translation') {
    host.innerHTML = `
      <section class="settings-card">
        <div class="setting-row">
          <div><div class="s-title">LibreTranslate server</div>
            <div class="s-desc">Page text is sent only when you choose Translate. Use a self-hosted server for local-only translation. HTTPS is required for remote servers.</div></div>
          <input id="setting-translation-endpoint" type="url" spellcheck="false" placeholder="http://localhost:5000" value="${escapeHtml(s.translation_endpoint ?? '')}" aria-label="LibreTranslate server URL"/>
        </div>
      </section>`;
    return;
  }

  if (category === 'privacy') {
    const blockerStatus = api.isNative() ? await api.getNetworkBlockerStatus() : null;
    const blockerStatusText = !blockerStatus?.available
      ? 'Network filtering is only available in the Windows app.'
      : !blockerStatus.ready || blockerStatus.loadedLists === 0
        ? 'Filter lists are loading; blocking starts when the engine is ready.'
        : !blockerStatus.enabled
          ? 'Network blocking is paused.'
          : `${blockerStatus.loadedLists} filter lists and ${blockerStatus.resourceCount} scriptlet resources loaded · ${blockerStatus.blockedRequests} requests blocked, ${blockerStatus.redirectedRequests} redirected and ${blockerStatus.rewrittenRequests ?? 0} tracking parameters removed this session.`;
    host.innerHTML = `
      <section class="settings-card">
        <div class="setting-row">
          <div><div class="s-title">Telemetry &amp; crash reporting</div>
            <div class="s-desc">Disabled. Govind sends no analytics anywhere. There is nothing to turn on yet.</div></div>
          <span class="chip selected" aria-disabled="true">Off, always</span>
        </div>
      </section>
      <section class="settings-card">
        <div class="setting-row">
          <div><div class="s-title">Spell check in web forms</div>
            <div class="s-desc">Underline misspelled words in text fields and offers corrections on right-click.</div></div>
          <label class="switch"><input type="checkbox" id="setting-spellcheck" ${s.spellcheck !== 'false' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Do Not Track</div>
            <div class="s-desc">Ask sites not to track you. Govind marks pages so scripts see the signal; note the engine cannot add the DNT HTTP header itself.</div></div>
          <label class="switch"><input type="checkbox" id="setting-do-not-track" ${s.do_not_track === 'true' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Safe browsing</div>
            <div class="s-desc">Warn before opening sites on Govind's blocklist. The built-in list is minimal — add your own domains below (one per line).</div></div>
          <label class="switch"><input type="checkbox" id="setting-safe-browsing" ${s.safe_browsing !== 'false' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Block ads and trackers</div>
            <div class="s-desc">Match network requests, remove tracking parameters, hide ad elements, and run uBlock-compatible scriptlets using bundled EasyList, EasyPrivacy, and uBlock Origin filter lists. The snapshot works offline on first launch; each cached list refreshes on the upstream schedule (uBlock quick fixes every 12 hours, EasyList every 4 days) from the list hosts only. ${escapeHtml(blockerStatusText)}</div></div>
          <label class="switch"><input type="checkbox" id="setting-network-blocking" ${s.network_blocking !== 'false' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Ad-blocking allowlist</div>
            <div class="s-desc">Sites where blocking is disabled, one hostname per line. Subdomains are included automatically. Reload open pages after changing this.</div></div>
          <textarea id="setting-adblock-allowlist" rows="3" spellcheck="false" placeholder="example.com&#10;*.news.example.org">${escapeHtml(s.adblock_allowlist ?? '')}</textarea>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Blocked sites</div>
            <div class="s-desc">Hostnames or *.suffix entries, one per line.</div></div>
          <textarea id="setting-blocklist" rows="4" spellcheck="false" placeholder="example.com&#10;*.bad.example.org">${escapeHtml(s.safebrowsing_blocklist ?? '')}</textarea>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Block page elements (cosmetic filters)</div>
            <div class="s-desc">Hide matching elements on every page — CSS selectors, one per line. This hides content; it does not block network requests.</div></div>
          <label class="switch"><input type="checkbox" id="setting-content-blocking" ${s.content_blocking === 'true' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Filter selectors</div></div>
          <textarea id="setting-cosmetic-filters" rows="4" spellcheck="false" placeholder=".ad-banner&#10;[id^=&quot;ad-&quot;]">${escapeHtml(s.cosmetic_filters ?? '')}</textarea>
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

const AF_FIELDS = ['full_name','email','phone','address_line1','address_line2','city','region','postal_code','country','card_name','card_number','card_expiry','card_csc'];
const AF_LABELS = { full_name:'Full name', email:'Email', phone:'Phone', address_line1:'Address line 1', address_line2:'Address line 2', city:'City', region:'State / region', postal_code:'Postal code', country:'Country', card_name:'Name on card', card_number:'Card number', card_expiry:'Card expiry', card_csc:'Security code' };

function readAutofillProfiles() {
  try {
    const parsed = JSON.parse(store.settings.autofill_profiles ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function saveAutofillProfiles(profiles) {
  const json = JSON.stringify(profiles.slice(0, 50));
  store.settings.autofill_profiles = json;
  await api.setSetting('autofill_profiles', json);
  if (api.isNative()) await api.setAutofillProfiles(json).catch(() => {});
}

async function renderAutofillList(host) {
  const list = host.querySelector('#autofill-list');
  const profiles = readAutofillProfiles();
  if (!list) return;
  list.innerHTML = profiles.length === 0
    ? '<p class="s-desc">No saved profiles yet.</p>'
    : profiles.map((p, i) => `
      <div class="perm-row">
        <span class="perm-origin">${escapeHtml(p.label || p.full_name || p.email || `Profile ${i + 1}`)}</span>
        <span class="perm-label">${escapeHtml([p.email, p.phone].filter(Boolean).join(' · ') || '—')}</span>
        <button class="btn-secondary" data-af-edit="${i}" type="button">Edit</button>
        <button class="btn-secondary" data-af-del="${i}" type="button">Delete</button>
      </div>`).join('');
  list.querySelectorAll('[data-af-del]').forEach((btn) => btn.addEventListener('click', async () => {
    const next = readAutofillProfiles().filter((_, i) => i !== Number(btn.dataset.afDel));
    await saveAutofillProfiles(next);
    await renderCategory('autofill');
    toast('Profile deleted.');
  }));
  list.querySelectorAll('[data-af-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const p = readAutofillProfiles()[Number(btn.dataset.afEdit)];
    if (!p) return;
    host.querySelector('#autofill-form')?.classList.remove('hidden');
    host.querySelector('#af-label').value = p.label ?? '';
    AF_FIELDS.forEach((f) => { const el = host.querySelector(`#af-${f}`); if (el) el.value = p[f] ?? ''; });
    host.querySelector('#af-save').dataset.editIndex = btn.dataset.afEdit;
    host.querySelector('#af-add-row')?.classList.add('hidden');
  }));
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

  on('#backup-export', 'click', async () => {
    const passphrase = await requestBackupPassphrase(true);
    if (passphrase === null) return;
    try {
      const snapshot = await api.exportBrowserBackupSnapshot();
      const encrypted = await encryptBrowserBackup(snapshot, passphrase);
      if (api.isNative()) {
        await api.saveEncryptedBrowserBackup(encrypted);
      } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([encrypted], { type: 'application/json' }));
        link.download = 'govind-browser-backup.gbak';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 0);
      }
      toast('Encrypted browser backup exported.');
    } catch (error) {
      toast(`Backup export failed: ${error?.message ?? error}`);
    }
  });

  on('#backup-import', 'click', async () => {
    try {
      const encrypted = api.isNative()
        ? await api.openEncryptedBrowserBackup()
        : await chooseEncryptedBackupFile();
      if (!encrypted) return;
      const passphrase = await requestBackupPassphrase(false);
      if (passphrase === null) return;
      const snapshotJson = await decryptBrowserBackup(encrypted, passphrase);
      if (!window.confirm('Merge the decrypted browser data? Existing data will not be deleted.')) return;
      const summary = await api.importBrowserBackupSnapshot(snapshotJson);
      document.dispatchEvent(new CustomEvent('govind:browser-data-restored'));
      toast(`Backup merged — ${summary.bookmarks} bookmarks, ${summary.tabs} tabs, ${summary.history} history records merged.`);
    } catch (error) {
      toast(`Backup import failed: ${error?.message ?? error}`);
    }
  });

  on('#setting-restore-session', 'change', async (e) => {
    store.settings.restore_session = e.target.checked ? 'true' : 'false';
    await api.setSetting('restore_session', store.settings.restore_session);
    toast(e.target.checked ? 'Session restore enabled.' : 'Session restore disabled.');
  });

  on('#setting-search-engine', 'change', async (e) => {
    store.settings.search_engine = e.target.value;
    await api.setSetting('search_engine', e.target.value);
    container.querySelector('#setting-custom-search')?.classList.toggle('hidden', e.target.value !== 'custom');
    toast('Search engine updated.');
  });

  on('#setting-custom-search', 'change', async (e) => {
    const value = e.target.value.trim();
    const lower = value.toLowerCase();
    if (value && !lower.startsWith('https://') && !lower.startsWith('http://')) {
      toast('Custom search URL must start with http:// or https://.');
      return;
    }

    store.settings.custom_search_url = value;
    if (value) await api.setSetting('custom_search_url', value);
    if (store.settings.search_engine !== 'custom') {
      store.settings.search_engine = 'custom';
      await api.setSetting('search_engine', 'custom');
      container.querySelector('#setting-search-engine').value = 'custom';
    }
    if (value) toast('Custom search engine saved.');
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

  on('#setting-force-dark-websites', 'change', async (e) => {
    const enabled = e.target.checked;
    store.settings.force_dark_websites = enabled ? 'true' : 'false';
    await api.setSetting('force_dark_websites', store.settings.force_dark_websites);
    if (api.isNative()) await api.setForceDarkWebsites(enabled);
    else toast('Forced website dark mode is available in the installed app.');
  });

  on('#af-add', 'click', () => {
    const form = container.querySelector('#autofill-form');
    if (!form) return;
    form.classList.remove('hidden');
    form.querySelectorAll('input').forEach((i) => { i.value = ''; });
    form.querySelector('#af-save').dataset.editIndex = '';
    container.querySelector('#af-add-row')?.classList.add('hidden');
  });
  on('#af-cancel', 'click', async () => {
    container.querySelector('#autofill-form')?.classList.add('hidden');
    container.querySelector('#af-add-row')?.classList.remove('hidden');
    await renderCategory('autofill');
  });
  on('#af-save', 'click', async (e) => {
    const profiles = readAutofillProfiles();
    const profile = { label: container.querySelector('#af-label')?.value.trim().slice(0, 60) || undefined };
    AF_FIELDS.forEach((f) => {
      const v = container.querySelector(`#af-${f}`)?.value.trim().slice(0, 200);
      if (v) profile[f] = v;
    });
    if (AF_FIELDS.every((f) => !profile[f])) { toast('Fill in at least one field.'); return; }
    const idx = e.target.dataset.editIndex;
    if (idx !== '' && idx !== undefined) profiles[Number(idx)] = profile;
    else profiles.push(profile);
    await saveAutofillProfiles(profiles);
    await renderCategory('autofill');
    toast('Profile saved.');
  });

  on('#setting-spellcheck', 'change', async (e) => {
    store.settings.spellcheck = e.target.checked ? 'true' : 'false';
    await api.setSetting('spellcheck', store.settings.spellcheck);
    if (api.isNative()) await api.setSpellcheck(e.target.checked);
  });
  on('#setting-do-not-track', 'change', async (e) => {
    store.settings.do_not_track = e.target.checked ? 'true' : 'false';
    await api.setSetting('do_not_track', store.settings.do_not_track);
    if (api.isNative()) await api.setDoNotTrack(e.target.checked);
    toast(e.target.checked ? 'Do Not Track signal enabled for pages.' : 'Do Not Track disabled.');
  });
  on('#setting-safe-browsing', 'change', async (e) => {
    store.settings.safe_browsing = e.target.checked ? 'true' : 'false';
    await api.setSetting('safe_browsing', store.settings.safe_browsing);
  });
  on('#setting-network-blocking', 'change', async (e) => {
    const enabled = e.target.checked;
    const value = enabled ? 'true' : 'false';
    try {
      if (api.isNative()) await api.setNetworkBlocking(enabled);
      await api.setSetting('network_blocking', value);
      store.settings.network_blocking = value;
      toast(enabled
        ? 'Network ad and tracker blocking enabled. Reload open pages to remove ads already loaded.'
        : 'Network ad and tracker blocking disabled.');
    } catch (error) {
      e.target.checked = !enabled;
      toast(error?.message ?? 'Could not change network blocking.');
    }
  });
  on('#setting-adblock-allowlist', 'change', async (e) => {
    const value = e.target.value.trim();
    try { await api.setSetting('adblock_allowlist', value); } catch (err) { toast(err?.message ?? 'Invalid ad-block allowlist.'); return; }
    store.settings.adblock_allowlist = value;
    if (api.isNative()) await api.setNetworkBlockingAllowlist(value);
    toast('Ad-blocking allowlist saved. Reload open pages to apply.');
  });
  on('#setting-blocklist', 'change', async (e) => {
    const value = e.target.value.trim();
    try { await api.setSetting('safebrowsing_blocklist', value); } catch (err) { toast(err?.message ?? 'Invalid blocklist.'); return; }
    store.settings.safebrowsing_blocklist = value;
    toast('Blocked sites saved.');
  });
  on('#setting-content-blocking', 'change', async (e) => {
    store.settings.content_blocking = e.target.checked ? 'true' : 'false';
    await api.setSetting('content_blocking', store.settings.content_blocking);
    if (api.isNative()) await api.setContentBlocking(e.target.checked ? (store.settings.cosmetic_filters ?? '') : '');
  });
  on('#setting-cosmetic-filters', 'change', async (e) => {
    const value = e.target.value;
    try { await api.setSetting('cosmetic_filters', value); } catch (err) { toast(err?.message ?? 'Invalid filters.'); return; }
    store.settings.cosmetic_filters = value;
    if (api.isNative() && store.settings.content_blocking === 'true') await api.setContentBlocking(value);
    toast('Filter selectors saved.');
  });

  on('#setting-translation-endpoint', 'change', async (e) => {
    const value = e.target.value.trim().replace(/\/+$/, '');
    let valid = !value;
    if (value) {
      try {
        const url = new URL(value);
        valid = !url.username && !url.password && !url.search && !url.hash
          && (url.protocol === 'https:'
            || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
      } catch {
        valid = false;
      }
    }
    if (!valid || value.length > 2048) {
      toast('Use an HTTPS endpoint, or localhost over HTTP.');
      e.target.value = store.settings.translation_endpoint ?? '';
      return;
    }
    store.settings.translation_endpoint = value;
    await api.setSetting('translation_endpoint', value);
    toast(value ? 'Translation server saved.' : 'Translation server cleared.');
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

function chooseEncryptedBackupFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gbak,.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      if (file.size > 48 * 1024 * 1024) { reject(new Error('Encrypted backup file is too large.')); return; }
      try { resolve(await file.text()); } catch (error) { reject(error); }
    }, { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

function requestBackupPassphrase(confirmPassphrase) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'backup-passphrase-dialog';
    dialog.setAttribute('aria-labelledby', 'backup-passphrase-title');
    dialog.innerHTML = `
      <form>
        <h2 id="backup-passphrase-title">${confirmPassphrase ? 'Protect your backup' : 'Unlock your backup'}</h2>
        <p>${confirmPassphrase
          ? 'Use at least 12 characters. This passphrase is never saved and cannot be recovered.'
          : 'Enter the passphrase used when this backup was created.'}</p>
        <label>Passphrase<input name="passphrase" type="password" minlength="12" autocomplete="new-password" required /></label>
        ${confirmPassphrase ? '<label>Confirm passphrase<input name="confirmation" type="password" minlength="12" autocomplete="new-password" required /></label>' : ''}
        <p class="backup-passphrase-error" role="alert" hidden></p>
        <div class="backup-passphrase-actions">
          <button class="btn-secondary" type="button" data-cancel>Cancel</button>
          <button class="btn-primary" type="submit">${confirmPassphrase ? 'Encrypt backup' : 'Unlock'}</button>
        </div>
      </form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const error = dialog.querySelector('.backup-passphrase-error');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const passphrase = form.elements.passphrase.value;
      if (confirmPassphrase && passphrase !== form.elements.confirmation.value) {
        error.textContent = 'Passphrases do not match.';
        error.hidden = false;
        form.elements.confirmation.focus();
        return;
      }
      finish(passphrase);
    });
    dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); }, { once: true });
    dialog.showModal();
    form.elements.passphrase.focus();
  });
}
