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
import {
  DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, parseShortcut, shortcutFromEvent,
} from '../lib/shortcuts.js';
import { DEFAULT_NVIDIA_MODEL, nvidiaModelOptions } from '../lib/nvidia.js';

const CATEGORIES = [
  { id: 'general', label: 'General', hint: 'Startup, search engine, HTTPS' },
  { id: 'ai', label: 'AI generation', hint: 'NVIDIA API key' },
  { id: 'data', label: 'Data transfer', hint: 'Encrypted browser backup' },
  { id: 'appearance', label: 'Appearance', hint: 'Theme and web pages' },
  { id: 'downloads', label: 'Downloads', hint: 'Folders, file names, scanning' },
  { id: 'newtab', label: 'New tab', hint: 'Widgets and website shortcuts' },
  { id: 'keys', label: 'Keyboard', hint: 'Custom shortcuts' },
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
      <div class="internal-nav-brand"><img class="logo-dot" src="assets/ritam-icon.png" alt="" aria-hidden="true"/> Settings</div>
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
        <h1>Settings</h1>
        <div class="internal-search">
          <svg class="icon sm" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
          <input id="settings-search" type="search" spellcheck="false" placeholder="Search settings" aria-label="Search settings" />
        </div>
      </header>
      <div class="internal-body">
        <div class="settings-cards" id="settings-cards"></div>
      </div>
    </div>`;

  await renderAllSections();
  wireSettingsPage(container);
  // Deep links (govind://settings:privacy) scroll to their section.
  if (category && category !== 'general') scrollToSection(category);
}

/** Every category renders on one page; the rail becomes a jump list. */
async function renderAllSections() {
  const host = $('#settings-cards');
  if (!host) return;
  host.innerHTML = '';
  for (const category of CATEGORIES) {
    const section = document.createElement('section');
    section.className = 'settings-section';
    section.id = `settings-${category.id}`;
    section.dataset.section = category.id;
    const title = document.createElement('h2');
    title.className = 'settings-section-title';
    title.textContent = category.label;
    const body = document.createElement('div');
    section.append(title, body);
    host.appendChild(section);
    await renderCategory(category.id, body);
  }
}

function scrollToSection(id) {
  const section = document.getElementById(`settings-${id}`);
  if (!section) return;
  section.scrollIntoView({ block: 'start' });
  document.querySelectorAll('[data-settings-category]').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-settings-category') === id);
  });
}

async function renderCategory(category, host = $('#settings-cards')) {
  if (!host) return;
  const s = await api.getSettings();

  if (category === 'general') {
    host.innerHTML = `
      <section class="settings-card">
        <div class="setting-row">
          <div><div class="s-title">Restore previous session</div>
            <div class="s-desc">Reopen the tabs and workspace you had open when you last closed Ritam.</div></div>
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
        <div class="setting-row">
          <div><div class="s-title">Sleep inactive tabs</div>
            <div class="s-desc">Suspend tabs you have not used for this many minutes to free memory. A sleeping tab reloads when you switch to it. 0 keeps every tab loaded.</div></div>
          <input id="setting-tab-sleep" type="number" min="0" max="240" step="5" value="${escapeHtml(s.tab_sleep_minutes ?? '0')}" aria-label="Minutes before a tab sleeps"/>
        </div>
      </section>`;
    return;
  }

  if (category === 'downloads') {
    host.innerHTML = `
      <section class="settings-card">
        <h4>Download rules</h4>
        <p class="s-desc">Files still go to the engine's download folder; these rules only pick a subfolder and the file name. They apply before the transfer starts.</p>
        <div class="setting-row">
          <div><div class="s-title">Sort downloads into folders</div>
            <div class="s-desc">Images, video, audio, archives, documents and installers go into a matching subfolder. Other file types stay where the engine saved them.</div></div>
          <label class="switch"><input type="checkbox" id="setting-download-organize" ${s.download_organize === 'true' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Rename downloaded files</div>
            <div class="s-desc">Placeholders: <code>{name}</code>, <code>{ext}</code>, <code>{host}</code> and <code>{date}</code> (YYYY-MM-DD). Leave empty to keep the site's file name. Existing files are never overwritten.</div></div>
          <input id="setting-download-pattern" type="text" maxlength="120" spellcheck="false" placeholder="{name}" value="${escapeHtml(s.download_name_pattern ?? '')}" aria-label="Download file name pattern"/>
        </div>
      </section>
      <section class="settings-card">
        <h4>Safety</h4>
        <div class="setting-row">
          <div><div class="s-title">Scan finished downloads</div>
            <div class="s-desc">Checks each new file with Microsoft Defender on Windows, on this device — files are never uploaded. Other systems report scanning as unavailable, and a threat verdict only warns you: nothing is deleted.</div></div>
          <label class="switch"><input type="checkbox" id="setting-download-scan" ${s.download_scan === 'true' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
      </section>`;
    return;
  }

  if (category === 'newtab') {
    const widgets = new Set(parseSettingJson(s.dashboard_widgets, ['clock', 'shortcuts', 'time']));
    const shortcuts = parseSettingJson(s.website_shortcuts, []);
    const widgetRow = (id, title, description) => `
      <div class="setting-row">
        <div><div class="s-title">${title}</div><div class="s-desc">${description}</div></div>
        <label class="switch"><input type="checkbox" data-widget="${id}" ${widgets.has(id) ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
      </div>`;
    host.innerHTML = `
      <section class="settings-card">
        <h4>New-tab widgets</h4>
        ${widgetRow('clock', 'Clock', 'Shows the local time above the search box.')}
        ${widgetRow('time', 'Time today', 'Total time spent on websites today, counted locally.')}
        ${widgetRow('shortcuts', 'Website shortcuts', 'Your pinned website buttons.')}
      </section>
      <section class="settings-card">
        <h4>Website shortcuts</h4>
        <p class="s-desc">Up to 12 quick buttons shown on the new-tab page.</p>
        <div id="shortcut-list">${Array.isArray(shortcuts) && shortcuts.length
          ? shortcuts.map((shortcut) => shortcutRow(shortcut)).join('')
          : '<p class="fav-empty">No shortcuts yet.</p>'}</div>
        <div class="setting-row">
          <input id="shortcut-title" type="text" maxlength="40" placeholder="Title" aria-label="Shortcut title"/>
          <input id="shortcut-url" type="text" maxlength="500" spellcheck="false" placeholder="https://example.com" aria-label="Shortcut URL"/>
          <button class="btn-secondary" id="shortcut-add" type="button">Add</button>
        </div>
      </section>`;
    return;
  }

  if (category === 'ai') {
    const info = await api.generationInfo().catch(() => null);
    const configured = s.nvidia_api_key_set === 'true';
    const model = s.nvidia_model || info?.model || DEFAULT_NVIDIA_MODEL;
    host.innerHTML = `
      <section class="settings-card">
        <h4>NVIDIA NIM</h4>
        <p class="s-desc">WorkAny generates slides, documents, spreadsheets and websites through NVIDIA's OpenAI-compatible API. The key is checked with NVIDIA before it is saved, stays on this device, and is never included in browser backups.</p>
        <div class="setting-row">
          <div>
            <div class="s-title">API key</div>
            <div class="s-desc" id="nvidia-key-status" role="status">${configured ? 'A verified key is saved for this profile.' : 'No key saved yet. Create one on build.nvidia.com.'}</div>
          </div>
          <div class="engine-controls nvidia-key-controls">
            <input id="setting-nvidia-key" type="password" maxlength="512" autocomplete="off" spellcheck="false" placeholder="nvapi-..." aria-label="NVIDIA API key"/>
            <button class="btn-secondary" id="save-nvidia-key" type="button">Save &amp; verify</button>
          </div>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Model</div><div class="s-desc">Pick the NVIDIA NIM model WorkAny should use. Keys can differ in model access; test on the AI Workspace tab if unsure.</div></div>
          <select id="setting-nvidia-model" aria-label="NVIDIA model">${nvidiaModelOptions(info?.models, model)}</select>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Remove credentials</div><div class="s-desc">Deletes the saved key. The selected model stays.</div></div>
          <button class="btn-secondary" id="clear-nvidia-key" type="button" ${configured ? '' : 'hidden'}>Remove key</button>
        </div>
      </section>`;
    return;
  }

  if (category === 'keys') {
    const custom = parseSettingJson(s.custom_shortcuts, {});
    host.innerHTML = `
      <section class="settings-card">
        <h4>Custom shortcuts</h4>
        <p class="s-desc">Click a field and press a combo (hold <code>Ctrl</code>, <code>Alt</code> or <code>Meta</code>). Backspace clears it and restores the built-in key, shown as a placeholder. A custom combo replaces the built-in one for that action.</p>
        ${SHORTCUT_ACTIONS.map((action) => `
          <div class="setting-row">
            <div class="s-title">${escapeHtml(action.label)}</div>
            <input data-shortcut-action="${action.id}" type="text" maxlength="40" spellcheck="false" readonly placeholder="${DEFAULT_SHORTCUTS[action.id] ? `Default: ${DEFAULT_SHORTCUTS[action.id]}` : 'Press a combo'}" value="${escapeHtml(custom?.[action.id] ?? '')}" aria-label="Shortcut for ${escapeHtml(action.label)}"/>
          </div>`).join('')}
      </section>`;
    return;
  }

  if (category === 'data') {
    host.innerHTML = `
      <section class="settings-card">
        <h4>Encrypted browser backup</h4>
        <p class="s-desc">Export or merge bookmarks, workspaces, tabs, history, notes, download records, reading list, site permissions, and settings. Private tabs and downloaded files are never included. The archive is encrypted on this device with your passphrase; Ritam cannot recover a forgotten passphrase.</p>
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
        <h4>Auto-fill has its own page</h4>
        <p class="s-desc">Names, emails, phone numbers and addresses are saved per profile and
          filled only when you press <strong>Ctrl+Shift+L</strong> on a page. The file sits in the
          profile folder without encryption; passwords and card details are never stored.</p>
        <div class="setting-row">
          <button class="btn-secondary" data-internal-page="autofill" type="button">Open auto-fill settings</button>
        </div>
      </section>
      <section class="settings-card">
        <h4>Import from another browser</h4>
        <p class="s-desc">Bookmarks and history from Chrome, Edge, Brave, Firefox or Safari.
          The source is read from a temp copy and never written to.</p>
        <div class="setting-row">
          <button class="btn-secondary" data-internal-page="profiles" type="button">Open profiles &amp; import</button>
        </div>
      </section>`;
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
            <div class="s-desc">Disabled. Ritam sends no analytics anywhere. There is nothing to turn on yet.</div></div>
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
            <div class="s-desc">Ask sites not to track you. Ritam marks pages so scripts see the signal; note the engine cannot add the DNT HTTP header itself.</div></div>
          <label class="switch"><input type="checkbox" id="setting-do-not-track" ${s.do_not_track === 'true' ? 'checked' : ''}/><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="setting-row">
          <div><div class="s-title">Safe browsing</div>
            <div class="s-desc">Warn before opening sites on Ritam's blocklist. The built-in list is minimal — add your own domains below (one per line).</div></div>
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
      <div class="about-name">Ritam Browser</div>
      <div class="about-ver">v${info?.version ?? '0.1.0'} · ${info?.milestone ?? 'Milestone 1'}</div>
      <p class="about-desc">${escapeHtml(info?.description ?? 'A fast, privacy-first desktop browser.')}</p>
    </section>
    <section class="settings-card">
      <h4>Technology Stack</h4>
      <table class="about-table">
        <tbody>
          <tr><td>Engine</td><td>${escapeHtml(info?.engine ?? 'WebView2 via Tauri 2')}</td></tr>
          <tr><td>Details</td><td>${escapeHtml(info?.engine_detail ?? 'Window-embedded child webviews')}</td></tr>
          <tr><td>UI Framework</td><td>${escapeHtml(info?.ui ?? 'Vanilla HTML/CSS/JS')}</td></tr>
          <tr><td>Database</td><td>${escapeHtml(info?.storage ?? 'SQLite')}</td></tr>
        </tbody>
      </table>
    </section>
    <section class="settings-card">
      <h4>Privacy & Data</h4>
      <p class="s-desc">${escapeHtml(info?.privacy ?? 'All data stored locally. No telemetry.')}</p>
      <table class="about-table">
        <tbody>
          <tr><td>Telemetry</td><td>${escapeHtml(info?.telemetry ?? 'Disabled')}</td></tr>
          <tr><td>Data Storage</td><td>${escapeHtml(info?.storage ?? 'Local SQLite')}</td></tr>
          <tr><td>Private Tabs</td><td>WebView2 InPrivate profile (isolated)</td></tr>
        </tbody>
      </table>
    </section>
    <section class="settings-card">
      <h4>Platforms & License</h4>
      <table class="about-table">
        <tbody>
          <tr><td>Supported</td><td>${escapeHtml(info?.platforms ?? 'Windows, Linux')}</td></tr>
          <tr><td>License</td><td>${escapeHtml(info?.license ?? 'MIT')}</td></tr>
          <tr><td>Repository</td><td><a href="${escapeHtml(info?.repository ?? '#')}" target="_blank" rel="noopener">${escapeHtml(info?.repository ?? 'Open Source')}</a></td></tr>
        </tbody>
      </table>
    </section>
    <section class="settings-card">
      <h4>Features</h4>
      <ul class="about-features">
        <li>Ad & Tracker Blocking (EasyList, EasyPrivacy, uBlock Origin)</li>
        <li>Tab Groups & Workspaces</li>
        <li>Bookmarks, History, Downloads</li>
        <li>Reading List with Offline Snapshots</li>
        <li>Reader Mode & Read Aloud</li>
        <li>Picture-in-Picture</li>
        <li>Forced Dark Mode</li>
        <li>Page Translation (LibreTranslate)</li>
        <li>Form Autofill & Password Generator</li>
        <li>Encrypted Backup (.gbak)</li>
        <li>Guest Mode & Private Tabs</li>
        <li>Command Palette (Ctrl+K)</li>
      </ul>
    </section>
    <section class="settings-card">
      <h4>Limitations</h4>
      <ul class="about-limitations">
        <li>No Chrome extensions (requires Chromium engine)</li>
        <li>No cloud sync (manual encrypted backup only)</li>
        <li>No per-tab cookie isolation (regular tabs share profile)</li>
        <li>No certificate inspection (URL-scheme based security)</li>
        <li>Network blocking Windows-only (WebView2 hook)</li>
      </ul>
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

// Reject two custom combos for one action, and a combo that is already the
// built-in accelerator of a different action (which would never fire).
function shortcutConflict(map) {
  const entries = Object.entries(map);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i][1].toLowerCase() === entries[j][1].toLowerCase()) {
        return `${entries[i][1]} is assigned to two actions.`;
      }
    }
  }
  for (const [action, combo] of entries) {
    for (const [other, otherCombo] of Object.entries(DEFAULT_SHORTCUTS)) {
      if (other !== action && !map[other] && combo.toLowerCase() === otherCombo.toLowerCase()) {
        const label = SHORTCUT_ACTIONS.find((item) => item.id === other)?.label ?? other;
        return `${combo} is already the built-in shortcut for ${label}.`;
      }
    }
  }
  return '';
}

function parseSettingJson(raw, fallback) {
  try {
    const parsed = JSON.parse(raw ?? '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function shortcutRow(shortcut) {
  return `<div class="setting-row" data-shortcut data-title="${escapeHtml(shortcut.title)}" data-url="${escapeHtml(shortcut.url)}">
    <div><div class="s-title">${escapeHtml(shortcut.title)}</div><div class="s-desc">${escapeHtml(shortcut.url)}</div></div>
    <button class="row-action" data-remove-shortcut="${escapeHtml(shortcut.url)}" title="Remove shortcut" aria-label="Remove ${escapeHtml(shortcut.title)}">×</button>
  </div>`;
}

function readShortcutRows(container) {
  return [...container.querySelectorAll('[data-shortcut]')].map((row) => ({
    title: row.getAttribute('data-title') ?? '',
    url: row.getAttribute('data-url') ?? '',
  }));
}

async function saveShortcuts(container, shortcuts) {
  const value = JSON.stringify(shortcuts);
  store.settings.website_shortcuts = value;
  await api.setSetting('website_shortcuts', value);
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
        link.download = 'ritam-browser-backup.gbak';
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

  on('#setting-tab-sleep', 'change', async (e) => {
    const minutes = Math.max(0, Math.min(240, Number(e.target.value) || 0));
    e.target.value = String(minutes);
    store.settings.tab_sleep_minutes = String(minutes);
    await api.setSetting('tab_sleep_minutes', String(minutes));
    toast(minutes ? `Inactive tabs sleep after ${minutes} minutes.` : 'Tab sleeping turned off.');
  });

  on('#setting-download-organize', 'change', async (e) => {
    const value = e.target.checked ? 'true' : 'false';
    store.settings.download_organize = value;
    await api.setSetting('download_organize', value);
    toast(e.target.checked ? 'Downloads are sorted into folders.' : 'Download sorting off.');
  });

  on('#setting-download-pattern', 'change', async (e) => {
    const value = e.target.value.trim();
    if (/[\\/]/.test(value)) {
      toast('Rename patterns cannot contain / or \\.');
      return;
    }
    store.settings.download_name_pattern = value;
    await api.setSetting('download_name_pattern', value);
    toast(value ? 'Download rename pattern saved.' : 'Download renaming off.');
  });

  on('#setting-download-scan', 'change', async (e) => {
    const value = e.target.checked ? 'true' : 'false';
    store.settings.download_scan = value;
    await api.setSetting('download_scan', value);
    toast(e.target.checked ? 'Finished downloads will be scanned.' : 'Download scanning off.');
  });

  container.querySelectorAll('[data-widget]').forEach((input) => {
    input.addEventListener('change', async () => {
      const enabled = [...container.querySelectorAll('[data-widget]')]
        .filter((item) => item.checked)
        .map((item) => item.getAttribute('data-widget'));
      const value = JSON.stringify(enabled);
      store.settings.dashboard_widgets = value;
      await api.setSetting('dashboard_widgets', value);
      toast('New-tab widgets updated.');
    });
  });

  on('#shortcut-add', 'click', async () => {
    const titleInput = container.querySelector('#shortcut-title');
    const urlInput = container.querySelector('#shortcut-url');
    const title = titleInput?.value.trim() ?? '';
    const url = urlInput?.value.trim() ?? '';
    if (!title || !/^https?:\/\//i.test(url)) {
      toast('A shortcut needs a title and an http(s) URL.');
      return;
    }
    const shortcuts = readShortcutRows(container);
    if (shortcuts.length >= 12) {
      toast('Up to 12 shortcuts.');
      return;
    }
    if (shortcuts.some((shortcut) => shortcut.url === url)) {
      toast('That shortcut already exists.');
      return;
    }
    shortcuts.push({ title, url });
    await saveShortcuts(container, shortcuts);
    const list = container.querySelector('#shortcut-list');
    list?.querySelector('.fav-empty')?.remove();
    list?.insertAdjacentHTML('beforeend', shortcutRow({ title, url }));
    list?.lastElementChild?.querySelector('[data-remove-shortcut]')?.addEventListener('click', handleRemoveShortcut);
    if (titleInput) titleInput.value = '';
    if (urlInput) urlInput.value = '';
    toast('Shortcut added.');
  });

  async function handleRemoveShortcut(event) {
    const row = event.currentTarget.closest('[data-shortcut]');
    row?.remove();
    await saveShortcuts(container, readShortcutRows(container));
    const list = container.querySelector('#shortcut-list');
    if (list && !list.querySelector('[data-shortcut]')) {
      list.innerHTML = '<p class="fav-empty">No shortcuts yet.</p>';
    }
    toast('Shortcut removed.');
  }

  container.querySelectorAll('[data-remove-shortcut]').forEach((button) => {
    button.addEventListener('click', handleRemoveShortcut);
  });

  container.querySelectorAll('[data-shortcut-action]').forEach((input) => {
    // Record the combo instead of asking the user to type it. Tab still moves
    // focus, and Backspace/Delete clears the override.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') return;
      event.preventDefault();
      if (event.key === 'Backspace' || event.key === 'Delete') {
        input.value = '';
        input.dispatchEvent(new Event('change'));
        return;
      }
      if (event.key === 'Escape') return;
      const combo = shortcutFromEvent(event);
      if (!combo) {
        toast('Hold Ctrl, Alt or Meta together with another key.');
        return;
      }
      input.value = combo;
      input.dispatchEvent(new Event('change'));
    });
    input.addEventListener('change', async () => {
      if (input.value.trim() && !parseShortcut(input.value)) {
        toast('Use a combo like Ctrl+Alt+K.');
        input.value = '';
      }
      const map = {};
      container.querySelectorAll('[data-shortcut-action]').forEach((field) => {
        const combo = field.value.trim();
        if (combo) map[field.getAttribute('data-shortcut-action')] = combo;
      });
      const conflict = shortcutConflict(map);
      if (conflict) {
        toast(conflict);
        input.value = '';
        return;
      }
      const value = JSON.stringify(map);
      try {
        await api.setSetting('custom_shortcuts', value);
        store.settings.custom_shortcuts = value;
        toast('Keyboard shortcuts saved.');
      } catch {
        toast('That shortcut could not be saved.');
      }
    });
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

  const nvidiaInput = container.querySelector('#setting-nvidia-key');
  const nvidiaModel = container.querySelector('#setting-nvidia-model');
  const nvidiaButton = container.querySelector('#save-nvidia-key');
  const nvidiaStatus = container.querySelector('#nvidia-key-status');
  const nvidiaClear = container.querySelector('#clear-nvidia-key');

  nvidiaInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    nvidiaButton?.click();
  });

  nvidiaButton?.addEventListener('click', async () => {
    const key = nvidiaInput?.value.trim() ?? '';
    const configured = store.settings.nvidia_api_key_set === 'true';
    if (!key && !configured) {
      toast('Paste an NVIDIA API key first.');
      nvidiaInput?.focus();
      return;
    }
    if (key && !/^nvapi-[A-Za-z0-9_-]{10,}$/.test(key)) {
      toast('Paste a complete NVIDIA API key starting with nvapi-.');
      nvidiaInput?.focus();
      return;
    }
    const model = nvidiaModel?.value || DEFAULT_NVIDIA_MODEL;
    const previous = nvidiaButton.textContent;
    nvidiaButton.disabled = true;
    nvidiaButton.textContent = 'Verifying…';
    try {
      const result = await api.saveNvidiaKey(key, model);
      if (nvidiaInput) nvidiaInput.value = '';
      store.settings.nvidia_api_key_set = 'true';
      if (nvidiaStatus) nvidiaStatus.textContent = result?.detail ?? 'A verified key is saved for this profile.';
      if (nvidiaClear) nvidiaClear.hidden = false;
      toast('NVIDIA key verified and saved.');
    } catch (error) {
      toast(`NVIDIA key not saved: ${error?.message ?? error}`);
    } finally {
      nvidiaButton.disabled = false;
      nvidiaButton.textContent = previous;
    }
  });

  nvidiaClear?.addEventListener('click', async () => {
    try {
      await api.setSetting('nvidia_api_key', '');
      store.settings.nvidia_api_key_set = 'false';
      if (nvidiaStatus) nvidiaStatus.textContent = 'No key saved yet. Create one on build.nvidia.com.';
      if (nvidiaClear) nvidiaClear.hidden = true;
      toast('NVIDIA key removed.');
    } catch (error) {
      toast(`Could not remove the NVIDIA key: ${error?.message ?? error}`);
    }
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

  // Category rail: jump within the single settings page.
  container.querySelectorAll('[data-settings-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-settings-category');
      if (id === 'history' || id === 'downloads') {
        document.dispatchEvent(new CustomEvent('govind:open-internal', { detail: id }));
        return;
      }
      selectSettingsCategory(id);
      scrollToSection(id);
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
    await renderAllSections();
    toast(`Reset ${n} permission ${n === 1 ? 'entry' : 'entries'}.`);
  });

  // Settings search filters the visible sections (the rail still jumps).
  on('#settings-search', 'input', (e) => {
    const query = e.target.value.trim().toLowerCase();
    container.querySelectorAll('.settings-section').forEach((section) => {
      const text = section.textContent.toLowerCase();
      section.classList.toggle('hidden', !!query && !text.includes(query));
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
