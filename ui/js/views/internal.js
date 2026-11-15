/**
 * Internal pages rendered by the shell — the equivalent of chrome:// pages.
 *
 *   govind://history     browsing history grouped by day
 *   govind://downloads   download history grouped by day
 *   govind://bookmarks   saved bookmarks and favourites
 *   govind://settings    settings (see views/settings.js)
 *
 * They are ordinary shell views: the omnibar shows the `govind://…` address,
 * the tab keeps its own history entry, and no webview is created for them.
 */

import { $, $$, escapeHtml, formatBytes, formatTime, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { displayUrl, hostOf, monogram } from '../lib/url.js';
import { store, refreshBookmarks, goHome, persistClosedTabs, clearClosedTabs } from '../state/store.js';
import { renderSettingsPage } from './settings.js';
import { renderViewerPage } from './viewer.js';
import { renderProfilesPage } from './profiles.js';
import { renderAutofillPage } from './autofill.js';

const ICON = {
  history: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  downloads: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  bookmarks: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  recentlyClosed: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8M3 3v5h5M12 7v5l3 2"/></svg>',
  reading: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16M8 7h8M8 11h8M8 15h5"/></svg>',
  taskManager: '<svg class="icon sm" viewBox="0 0 24 24"><rect width="16" height="16" x="4" y="4" rx="2"/><path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>',
  media: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  shield: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/></svg>',
  settings: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M19.8 4.2l-2.1 2.1M6.3 17.7l-2.1 2.1"/></svg>',
  trash: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  folder: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  search: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
  file: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  profiles: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  autofill: '<svg class="icon sm" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h5M7 13h10M7 17h7"/></svg>',
};

const NAV_ITEMS = [
  { page: 'history', label: 'History', icon: ICON.history },
  { page: 'downloads', label: 'Downloads', icon: ICON.downloads },
  { page: 'bookmarks', label: 'Bookmarks', icon: ICON.bookmarks },
  { page: 'profiles', label: 'Profiles', icon: ICON.profiles },
  { page: 'autofill', label: 'Autofill', icon: ICON.autofill },
  { page: 'reading-list', label: 'Reading list', icon: ICON.reading },
  { page: 'task-manager', label: 'Task manager', icon: ICON.taskManager },
  { page: 'media-controls', label: 'Media controls', icon: ICON.media },
  { page: 'viewer', label: 'File viewer', icon: ICON.file },
  { page: 'recently-closed', label: 'Recently closed', icon: ICON.recentlyClosed },
  { page: 'settings', label: 'Settings', icon: ICON.settings },
];

const PAGE_TITLES = {
  history: 'History',
  downloads: 'Downloads',
  bookmarks: 'Bookmarks',
  profiles: 'Profiles',
  autofill: 'Autofill',
  'reading-list': 'Reading list',
  'task-manager': 'Task manager',
  'media-controls': 'Media controls',
  viewer: 'File viewer',
  'recently-closed': 'Recently closed tabs',
  unsafe: 'Safety check',
  settings: 'Settings',
};

/** Per-page UI state (kept between renders). */
const uiState = {
  historyQuery: '',
  downloadQuery: '',
  bookmarkQuery: '',
  readingQuery: '',
  historySelection: new Set(),
  downloadSelection: new Set(),
  bookmarkSelection: new Set(),
  groupMode: 'date',
};

export function internalPageTitle(page = store.internalPage) {
  return PAGE_TITLES[page] ?? 'History';
}

// ── Shell ─────────────────────────────────────────────────────────────
export async function renderInternalPage() {
  const host = $('#view-internal');
  if (!host) return;
  const page = store.internalPage ?? 'history';

  // The viewer keeps its DOM between shell renders; another page clears it.
  if (page !== 'viewer') delete host.dataset.viewerMount;

  if (page === 'viewer') {
    renderViewerPage();
    return;
  }

  if (page === 'settings') {
    host.innerHTML = '<div class="internal-shell" id="internal-shell"></div>';
    renderSettingsPage($('#internal-shell'));
    return;
  }

  if (page === 'unsafe') {
    host.innerHTML = '<div class="internal-shell" id="internal-shell"></div>';
    renderUnsafePage($('#internal-shell'));
    return;
  }

  host.innerHTML = `
    <div class="internal-shell">
      <nav class="internal-nav" aria-label="Internal pages">
        <div class="internal-nav-brand"><img class="logo-dot" src="assets/ritam-icon.png" alt="" aria-hidden="true"/> Ritam</div>
        ${NAV_ITEMS.map((item) => `
          <button class="internal-nav-item ${item.page === page ? 'active' : ''}" data-internal-page="${item.page}">
            ${item.icon}<span>${item.label}</span>
          </button>`).join('')}
        <div class="internal-nav-sep"></div>
        <button class="internal-nav-item" data-internal-action="clear-data">
          ${ICON.trash}<span>Delete browsing data</span>
        </button>
      </nav>
      <div class="internal-main">
        <header class="internal-header">
          <h1>${PAGE_TITLES[page] ?? 'History'}</h1>
          <div class="internal-search">
            ${ICON.search}
            <input id="internal-search" type="search" spellcheck="false"
                   placeholder="Search ${PAGE_TITLES[page]?.toLowerCase() ?? 'history'}"
                   aria-label="Search ${PAGE_TITLES[page] ?? 'history'}" />
          </div>
          <div class="internal-header-actions" id="internal-header-actions"></div>
        </header>
        <div class="internal-body" id="internal-body"></div>
      </div>
    </div>`;

  if (page === 'history') await renderHistoryPage();
  else if (page === 'downloads') await renderDownloadsPage();
  else if (page === 'bookmarks') await renderBookmarksPage();
  else if (page === 'reading-list') await renderReadingListPage();
  else if (page === 'task-manager') renderTaskManagerPage();
  else if (page === 'media-controls') await renderMediaControlsPage();
  else if (page === 'recently-closed') renderRecentlyClosedPage();
  else if (page === 'profiles') await renderProfilesPage($('#internal-body'));
  else if (page === 'autofill') await renderAutofillPage($('#internal-body'));

  wireInternal();
  if (['recently-closed', 'profiles', 'autofill'].includes(page)) $('.internal-search')?.classList.add('hidden');
}

function renderRecentlyClosedPage() {
  const groups = $('#internal-body');
  if (!groups) return;
  if (store.closedTabs.length === 0) {
    groups.innerHTML = '<div class="internal-empty"><p>Tabs you close during this session will appear here. Private tabs are never listed.</p></div>';
    updateHeaderActions();
    return;
  }
  groups.innerHTML = `<section class="internal-group"><div class="internal-card">
    ${store.closedTabs.map((tab) => `
      <div class="internal-row">
        <span class="row-fav" aria-hidden="true">${escapeHtml(monogram(tab.url))}</span>
        <span class="row-title" title="${escapeHtml(tab.url)}">${escapeHtml(tab.title || tab.url)}</span>
        <span class="row-domain">${escapeHtml(displayUrl(tab.url))}</span>
        <button class="btn-secondary" data-reopen-closed="${escapeHtml(tab.id)}">Reopen</button>
        <button class="row-action" data-dismiss-closed="${escapeHtml(tab.id)}" title="Remove from recently closed" aria-label="Remove ${escapeHtml(tab.title || tab.url)}">${ICON.trash}</button>
      </div>`).join('')}
  </div></section>`;
  updateHeaderActions();
}

// ── History ───────────────────────────────────────────────────────────
async function renderHistoryPage() {
  const body = $('#internal-body');
  if (!body) return;
  body.innerHTML = `
    <div class="internal-tabs" role="tablist">
      <button class="internal-tab ${uiState.groupMode === 'date' ? 'active' : ''}" data-group-mode="date" role="tab">By date</button>
      <button class="internal-tab ${uiState.groupMode === 'domain' ? 'active' : ''}" data-group-mode="domain" role="tab">By group</button>
    </div>
    <div id="internal-groups" class="internal-groups"></div>`;

  const query = uiState.historyQuery;
  const rows = await api.searchHistory(query, 500);
  const groups = $('#internal-groups');
  if (!groups) return;

  if (rows.length === 0) {
    groups.innerHTML = `<div class="internal-empty">
      <p>${query ? 'No history entries match your search.' : 'No history yet. Pages you visit appear here, stored only on this device.'}</p>
    </div>`;
    updateHeaderActions();
    return;
  }

  const buckets = new Map();
  for (const row of rows) {
    const key = uiState.groupMode === 'domain'
      ? (hostOf(row.url) ?? 'Unknown site')
      : dayLabel(row.visited_at);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  groups.innerHTML = [...buckets.entries()].map(([label, items]) => `
    <section class="internal-group">
      <h2>${escapeHtml(label)}</h2>
      <div class="internal-card">
        ${items.map((row) => `
          <div class="internal-row" data-id="${escapeHtml(row.id)}" data-url="${escapeHtml(row.url)}">
            <input class="row-check" type="checkbox" ${uiState.historySelection.has(row.id) ? 'checked' : ''}
                   aria-label="Select ${escapeHtml(row.title || row.url)}" />
            <span class="row-time">${escapeHtml(timeLabel(row.visited_at))}</span>
            <span class="row-fav" aria-hidden="true">${escapeHtml(monogram(row.url))}</span>
            <a class="row-title link" href="#" data-open-url="${escapeHtml(row.url)}" title="${escapeHtml(row.url)}">${escapeHtml(row.title || row.url)}</a>
            <span class="row-domain">${escapeHtml(displayUrl(row.url))}</span>
            <button class="row-action" data-remove-history="${escapeHtml(row.id)}" title="Remove from history" aria-label="Remove from history">
              ${ICON.trash}
            </button>
          </div>`).join('')}
      </div>
    </section>`).join('');

  updateHeaderActions();
}

// ── Downloads ─────────────────────────────────────────────────────────
async function renderDownloadsPage() {
  const body = $('#internal-body');
  if (!body) return;
  body.innerHTML = '<div id="internal-groups" class="internal-groups"></div>';

  const query = uiState.downloadQuery.toLowerCase();
  const all = await api.listDownloads();
  const rows = all.filter((d) =>
    !query || d.filename.toLowerCase().includes(query) || d.url.toLowerCase().includes(query));

  const groups = $('#internal-groups');
  if (!groups) return;

  if (rows.length === 0) {
    groups.innerHTML = `<div class="internal-empty">
      <p>${query ? 'No downloads match your search.' : 'No downloads yet. Files you download appear here.'}</p>
    </div>`;
    updateHeaderActions();
    return;
  }

  const buckets = new Map();
  for (const row of rows) {
    const key = dayLabel(row.created_at);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  groups.innerHTML = [...buckets.entries()].map(([label, items]) => `
    <section class="internal-group">
      <h2>${escapeHtml(label)}</h2>
      <div class="internal-card">
        ${items.map((row) => `
          <div class="internal-row" data-id="${escapeHtml(row.id)}">
            <input class="row-check" type="checkbox" ${uiState.downloadSelection.has(row.id) ? 'checked' : ''}
                   aria-label="Select ${escapeHtml(row.filename)}" />
            <span class="file-icon" aria-hidden="true">${ICON.file}</span>
            <a class="row-title link" href="#" data-open-file="${escapeHtml(row.destination ?? '')}" title="${escapeHtml(row.destination ?? row.url)}">${escapeHtml(row.filename)}</a>
            <span class="row-domain">${escapeHtml(row.status)}${row.total_bytes ? ` · ${formatBytes(row.total_bytes)}` : ''} · ${escapeHtml(formatTime(row.created_at))}</span>
            <button class="row-action" data-show-file="${escapeHtml(row.destination ?? '')}" title="Open file" aria-label="Open file" ${row.destination ? '' : 'disabled'}>
              ${ICON.folder}
            </button>
            <button class="row-action" data-remove-download="${escapeHtml(row.id)}" title="Remove from list" aria-label="Remove from list">
              ${ICON.trash}
            </button>
          </div>`).join('')}
      </div>
    </section>`).join('');

  updateHeaderActions();
}

// ── Bookmarks ─────────────────────────────────────────────────────────
async function renderBookmarksPage() {
  const body = $('#internal-body');
  if (!body) return;
  body.innerHTML = '<div id="internal-groups" class="internal-groups"></div>';
  await refreshBookmarks();

  const query = uiState.bookmarkQuery.toLowerCase();
  const rows = store.bookmarks.filter((b) =>
    !query || b.title.toLowerCase().includes(query) || b.url.toLowerCase().includes(query));

  const groups = $('#internal-groups');
  if (!groups) return;

  if (rows.length === 0) {
    groups.innerHTML = `<div class="internal-empty">
      <p>${query ? 'No bookmarks match your search.' : 'No bookmarks yet. Star a page from the address bar to save it.'}</p>
    </div>`;
    updateHeaderActions();
    return;
  }

  groups.innerHTML = `
    <section class="internal-group">
      <div class="internal-card">
        ${rows.map((b) => `
          <div class="internal-row" data-id="${escapeHtml(b.id)}">
            <input class="row-check" type="checkbox" ${uiState.bookmarkSelection.has(b.id) ? 'checked' : ''}
                   aria-label="Select ${escapeHtml(b.title)}" />
            <span class="row-fav" aria-hidden="true">${escapeHtml(monogram(b.url))}</span>
            <a class="row-title link" href="#" data-open-url="${escapeHtml(b.url)}" title="${escapeHtml(b.url)}">${escapeHtml(b.title)}</a>
            <span class="row-domain">${escapeHtml(displayUrl(b.url))}</span>
            <button class="row-action" data-fav="${escapeHtml(b.id)}" title="${b.is_favorite ? 'Remove favourite' : 'Mark as favourite'}" aria-label="Toggle favourite">
              ${ICON.bookmarks}
            </button>
            <button class="row-action" data-remove-bookmark="${escapeHtml(b.id)}" title="Delete bookmark" aria-label="Delete bookmark">
              ${ICON.trash}
            </button>
          </div>`).join('')}
      </div>
    </section>`;

  updateHeaderActions();
}

let lastReadingCount = 0;

// ── Reading list ──────────────────────────────────────────────────────
async function renderReadingListPage() {
  const body = $('#internal-body');
  if (!body) return;
  body.innerHTML = '<div id="internal-groups" class="internal-groups"></div>';

  const query = uiState.readingQuery.toLowerCase();
  const all = await api.listReadingItems();
  lastReadingCount = all.length;
  const rows = all.filter((r) =>
    !query || r.title.toLowerCase().includes(query) || r.url.toLowerCase().includes(query));

  const groups = $('#internal-groups');
  if (!groups) return;
  if (rows.length === 0) {
    groups.innerHTML = `<div class="internal-empty">
      <p>${query ? 'Nothing in your reading list matches.' : 'Your reading list is empty. Use “Save page for later” in the ⋯ menu to keep an article here — Ritam stores an offline text copy too.'}</p>
    </div>`;
    updateHeaderActions();
    return;
  }
  groups.innerHTML = `<section class="internal-group"><div class="internal-card">
    ${rows.map((r) => `
      <div class="internal-row" data-id="${escapeHtml(r.id)}">
        <span class="row-fav" aria-hidden="true">${escapeHtml(monogram(r.url))}</span>
        <a class="row-title link" href="#" data-open-url="${escapeHtml(r.url)}" title="${escapeHtml(r.url)}">${escapeHtml(r.title || r.url)}</a>
        <span class="row-domain">${escapeHtml(displayUrl(r.url))}${r.snapshot_text ? ' · offline copy' : ''} · ${escapeHtml(formatTime(r.created_at))}</span>
        <button class="row-action" data-read-item="${escapeHtml(r.id)}" title="Read offline copy" aria-label="Read offline copy">${ICON.file}</button>
        <button class="row-action" data-remove-reading="${escapeHtml(r.id)}" title="Remove" aria-label="Remove">${ICON.trash}</button>
      </div>`).join('')}
  </div></section>`;
  updateHeaderActions();
}

// ── Task manager ──────────────────────────────────────────────────────
function renderTaskManagerPage() {
  const body = $('#internal-body');
  if (!body) return;
  const rows = store.tabs;
  body.innerHTML = rows.length === 0
    ? '<div class="internal-empty"><p>No tabs open.</p></div>'
    : `<section class="internal-group"><div class="internal-card">
        ${rows.map((t) => {
          const audio = store.audioStates.get(t.id) ?? { playing: false, muted: store.mutedTabs.has(t.id) };
          const state = [
            t.is_private ? 'private' : null,
            audio.playing ? (audio.muted ? 'audio (muted)' : 'audio playing') : null,
            store.readerModeTabs.has(t.id) ? 'reader mode' : null,
            store.translatedTabs.has(t.id) ? 'translated' : null,
          ].filter(Boolean).join(' · ');
          return `
          <div class="internal-row" data-id="${escapeHtml(t.id)}">
            <span class="row-fav" aria-hidden="true">${escapeHtml(monogram(t.url))}</span>
            <span class="row-title">${escapeHtml(t.title || t.url)}</span>
            <span class="row-domain">${escapeHtml(displayUrl(t.url))}${state ? ` · ${escapeHtml(state)}` : ''}</span>
            <button class="row-action" data-switch-tab="${escapeHtml(t.id)}" title="Switch to tab" aria-label="Switch to tab">${ICON.search}</button>
            <button class="row-action" data-mute-task="${escapeHtml(t.id)}" title="Mute / unmute" aria-label="Mute or unmute tab">${ICON.downloads}</button>
            <button class="row-action" data-close-task="${escapeHtml(t.id)}" title="Close tab" aria-label="Close tab">${ICON.trash}</button>
          </div>`;
        }).join('')}
      </div></section>
      <p class="s-desc" style="padding:0 4px">Shows per-tab state Ritam can observe (audio, reader mode, private). The WebView2 engine does not expose per-tab CPU or memory figures.</p>`;
  updateHeaderActions();
}

async function renderMediaControlsPage() {
  const body = $('#internal-body');
  if (!body) return;
  const savedTabs = await api.listTabs();
  const tabs = [...savedTabs, ...store.privateTabs]
    .filter((tab) => store.audioStates.get(tab.id)?.hasMedia);
  if (!tabs.length) {
    body.innerHTML = '<div class="internal-empty"><p>No audio or video players found in the loaded tabs. Media inside cross-origin frames is not exposed to these controls.</p></div>';
    updateHeaderActions();
    return;
  }
  body.innerHTML = `
    <section class="internal-group"><div class="internal-card">
      ${tabs.map((tab) => {
        const audio = store.audioStates.get(tab.id);
        const playing = !!audio?.mediaPlaying;
        const muted = !!audio?.muted;
        return `
          <div class="internal-row" data-id="${escapeHtml(tab.id)}">
            <span class="row-fav" aria-hidden="true">${escapeHtml(monogram(tab.url))}</span>
            <span class="row-title">${escapeHtml(tab.title || tab.url)}</span>
            <span class="row-domain">${escapeHtml(displayUrl(tab.url))} · ${playing ? 'playing' : 'paused'}</span>
            <button class="btn-secondary" data-media-toggle="${escapeHtml(tab.id)}" type="button">${playing ? 'Pause' : 'Play'}</button>
            <button class="row-action" data-mute-task="${escapeHtml(tab.id)}" title="${muted ? 'Unmute tab' : 'Mute tab'}" aria-label="${muted ? 'Unmute tab' : 'Mute tab'}">${ICON.downloads}</button>
            <button class="row-action" data-switch-tab="${escapeHtml(tab.id)}" title="Switch to tab" aria-label="Switch to tab">${ICON.search}</button>
          </div>`;
      }).join('')}
    </div></section>
    <p class="s-desc" style="padding:0 4px">Controls audio and video elements in each page's top-level document. A site may block playback started outside its own play button.</p>`;
  updateHeaderActions();
}

// ── Unsafe-site warning (safe browsing) ───────────────────────────────
function renderUnsafePage(container) {
  const target = store.pendingUnsafeUrl ?? '';
  container.innerHTML = `
    <div class="internal-shell">
      <div class="internal-main">
        <div class="internal-body">
          <section class="settings-card" style="max-width:560px;margin:48px auto;">
            <div style="display:flex;gap:12px;align-items:flex-start;">
              <span style="color:var(--zen-danger,#c0392b);flex:none">${ICON.shield}</span>
              <div>
                <h3 style="margin:0 0 8px;">This site is on Ritam's blocklist</h3>
                <p class="s-desc" style="margin:0 0 6px;">${escapeHtml(store.pendingUnsafeReason ?? '')}</p>
                <p class="s-desc" style="margin:0 0 16px;">Ritam stopped the navigation as a safety precaution. If you are certain this site is safe, you can visit it anyway — the decision applies to this session only.</p>
                <div class="row-domain" style="margin-bottom:16px;">${escapeHtml(displayUrl(target))}</div>
                <button class="btn-primary" id="unsafe-go" type="button">Back to safety</button>
                <button class="btn-secondary" id="unsafe-anyway" type="button">Visit anyway</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>`;
  $('#unsafe-go')?.addEventListener('click', async () => {
    store.pendingUnsafeUrl = null;
    await goHome();
    document.dispatchEvent(new CustomEvent('govind:render'));
  });
  $('#unsafe-anyway')?.addEventListener('click', async () => {
    const url = store.pendingUnsafeUrl;
    store.pendingUnsafeUrl = null;
    if (url) {
      await api.bypassUnsafeUrl(url).catch(() => {});
      document.dispatchEvent(new CustomEvent('govind:navigate', { detail: url }));
    }
  });
}

// ── Header actions (Clear all / Delete selected) ──────────────────────
function updateHeaderActions() {
  const host = $('#internal-header-actions');
  if (!host) return;
  const page = store.internalPage ?? 'history';
  const selection =
    page === 'history' ? uiState.historySelection :
    page === 'downloads' ? uiState.downloadSelection :
    page === 'bookmarks' ? uiState.bookmarkSelection : new Set();

  const buttons = [];
  if (selection.size > 0) {
    buttons.push(`<button class="btn-secondary" data-action="delete-selected">Delete selected (${selection.size})</button>`);
  }
  if (page === 'history') {
    buttons.push('<button class="btn-secondary" data-action="clear-history" title="Delete all browsing history">Clear history</button>');
  }
  if (page === 'downloads') {
    buttons.push('<button class="btn-secondary" data-action="clear-downloads">Clear all</button>');
  }
  if (page === 'bookmarks') {
    buttons.push('<button class="btn-secondary" data-action="export-bookmarks">Export</button>');
    buttons.push('<button class="btn-secondary" data-action="import-bookmarks">Import…</button>');
  }
  if (page === 'recently-closed' && store.closedTabs.length > 0) {
    buttons.push('<button class="btn-secondary" data-action="clear-closed">Clear all</button>');
  }
  if (page === 'reading-list' && lastReadingCount > 0) {
    buttons.push('<button class="btn-secondary" data-action="clear-reading">Clear all</button>');
  }
  host.innerHTML = buttons.join('');
}

/** Export the bookmark list as a Netscape bookmark file (via the engine download). */
async function downloadBookmarksFile() {
  try {
    if (api.isNative()) {
      const { path, count } = await api.exportBookmarksFile();
      toast(`Exported ${count} bookmark${count === 1 ? '' : 's'} to ${path}`);
    } else {
      const html = await api.exportBookmarksHtml();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      a.download = 'govind-bookmarks.html';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('Bookmarks exported — the file was saved to your downloads.');
    }
  } catch (err) {
    if (err?.message !== 'export cancelled' && !/cancel/i.test(err?.message ?? '')) {
      toast(`Export failed: ${err?.message ?? err}`);
    }
  }
}

/** Import a bookmarks HTML file exported from any browser. */
function ensureImportInput() {
  let input = $('#import-bookmarks-input');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.accept = '.html,.htm';
  input.id = 'import-bookmarks-input';
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const html = await file.text();
      const summary = await api.importBookmarksHtml(html);
      await renderInternalPage();
      document.dispatchEvent(new CustomEvent('govind:bookmarks-changed'));
      toast(`Imported ${summary.imported} bookmark${summary.imported === 1 ? '' : 's'}${summary.duplicates ? `, updated ${summary.duplicates}` : ''}.`);
    } catch (err) {
      toast(`Import failed: ${err?.message ?? err}`);
    }
  });
  document.body.appendChild(input);
  return input;
}

/** Native import: open the OS file picker and import the chosen file. */
async function importBookmarksNative() {
  try {
    const summary = await api.importBookmarksFile();
    await renderInternalPage();
    document.dispatchEvent(new CustomEvent('govind:bookmarks-changed'));
    toast(`Imported ${summary.imported} bookmark${summary.imported === 1 ? '' : 's'}${summary.duplicates ? `, updated ${summary.duplicates}` : ''}.`);
  } catch (err) {
    if (!/cancel/i.test(err?.message ?? '')) toast(`Import failed: ${err?.message ?? err}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
function dayLabel(ts) {
  const date = new Date(Number(ts) || 0);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const days = Math.round((startOfToday - startOfDay) / 86_400_000);
  const long = date.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  if (days === 0) return `Today - ${long}`;
  if (days === 1) return `Yesterday - ${long}`;
  return long;
}

function timeLabel(ts) {
  return new Date(Number(ts) || 0).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
}

function selectionFor(page) {
  return page === 'history' ? uiState.historySelection
    : page === 'downloads' ? uiState.downloadSelection
    : uiState.bookmarkSelection;
}

// ── Events ────────────────────────────────────────────────────────────
let wired = false;

export function wireInternal() {
  const host = $('#view-internal');
  if (!host) return;

  // Delegated handlers are installed once; the content is re-rendered often.
  if (!wired) {
    wired = true;

    host.addEventListener('click', async (e) => {
      const navPage = e.target.closest('[data-internal-page]')?.getAttribute('data-internal-page');
      if (navPage) {
        document.dispatchEvent(new CustomEvent('govind:open-internal', { detail: navPage }));
        return;
      }
      if (e.target.closest('[data-internal-action="clear-data"]')) {
        document.dispatchEvent(new CustomEvent('govind:open-internal', { detail: 'settings:privacy' }));
        return;
      }

      const groupMode = e.target.closest('[data-group-mode]')?.getAttribute('data-group-mode');
      if (groupMode) {
        uiState.groupMode = groupMode;
        await renderInternalPage();
        return;
      }

      const openUrl = e.target.closest('[data-open-url]')?.getAttribute('data-open-url');
      if (openUrl) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('govind:navigate', { detail: openUrl }));
        return;
      }

      const openFile = e.target.closest('[data-open-file]')?.getAttribute('data-open-file');
      if (openFile) {
        e.preventDefault();
        if (openFile) await api.openExternal(openFile);
        return;
      }

      const reopenClosed = e.target.closest('[data-reopen-closed]')?.getAttribute('data-reopen-closed');
      if (reopenClosed) {
        const tab = await reopenClosedTab(reopenClosed);
        if (tab) document.dispatchEvent(new CustomEvent('govind:activate-tab', { detail: tab.id }));
        await renderInternalPage();
        return;
      }

      const dismissClosed = e.target.closest('[data-dismiss-closed]')?.getAttribute('data-dismiss-closed');
      if (dismissClosed) {
        store.closedTabs = store.closedTabs.filter((tab) => tab.id !== dismissClosed);
        await persistClosedTabs();
        await renderInternalPage();
        return;
      }

      const showFile = e.target.closest('[data-show-file]')?.getAttribute('data-show-file');
      if (showFile) {
        e.preventDefault();
        if (showFile) await api.openExternal(showFile);
        return;
      }

      const removeHistory = e.target.closest('[data-remove-history]')?.getAttribute('data-remove-history');
      if (removeHistory) {
        e.preventDefault();
        await api.deleteHistoryEntry(removeHistory);
        uiState.historySelection.delete(removeHistory);
        await renderInternalPage();
        toast('History entry removed.');
        return;
      }

      const removeDownload = e.target.closest('[data-remove-download]')?.getAttribute('data-remove-download');
      if (removeDownload) {
        e.preventDefault();
        await api.removeDownload(removeDownload);
        uiState.downloadSelection.delete(removeDownload);
        await renderInternalPage();
        toast('Removed from the download list.');
        return;
      }

      const removeBookmark = e.target.closest('[data-remove-bookmark]')?.getAttribute('data-remove-bookmark');
      if (removeBookmark) {
        e.preventDefault();
        await api.deleteBookmark(removeBookmark);
        uiState.bookmarkSelection.delete(removeBookmark);
        await renderInternalPage();
        toast('Bookmark deleted.');
        return;
      }

      const fav = e.target.closest('[data-fav]')?.getAttribute('data-fav');
      if (fav) {
        e.preventDefault();
        await api.toggleFavorite(fav);
        await renderInternalPage();
        return;
      }

      const removeReading = e.target.closest('[data-remove-reading]')?.getAttribute('data-remove-reading');
      if (removeReading) {
        e.preventDefault();
        await api.deleteReadingItem(removeReading);
        await renderInternalPage();
        toast('Removed from reading list.');
        return;
      }

      const readItem = e.target.closest('[data-read-item]')?.getAttribute('data-read-item');
      if (readItem) {
        e.preventDefault();
        const items = await api.listReadingItems();
        const item = items.find((r) => r.id === readItem);
        if (item?.snapshot_text) {
          const w = window.open('', '_blank');
          if (w) {
            w.document.write(`<pre style="white-space:pre-wrap;font:16px/1.7 Georgia,serif;max-width:720px;margin:40px auto;padding:0 20px;">${escapeHtml(item.snapshot_text)}</pre>`);
            w.document.close();
          } else toast('Popup blocked — allow popups to read the offline copy.');
        } else toast('No offline copy saved for this page.');
        return;
      }

      const switchTab = e.target.closest('[data-switch-tab]')?.getAttribute('data-switch-tab');
      if (switchTab) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('govind:activate-tab', { detail: switchTab }));
        return;
      }
      const mediaToggle = e.target.closest('[data-media-toggle]')?.getAttribute('data-media-toggle');
      if (mediaToggle) {
        e.preventDefault();
        if (!api.isNative()) {
          toast('Media controls are available in the installed app.');
          return;
        }
        try {
          await api.controlTabMedia(mediaToggle);
        } catch (err) {
          toast(`Could not control media: ${err?.message ?? err}`);
        }
        return;
      }
      const muteTask = e.target.closest('[data-mute-task]')?.getAttribute('data-mute-task');
      if (muteTask) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('govind:mute-tab', { detail: muteTask }));
        return;
      }
      const closeTask = e.target.closest('[data-close-task]')?.getAttribute('data-close-task');
      if (closeTask) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('govind:close-tab', { detail: closeTask }));
        await renderInternalPage();
        return;
      }

      const action = e.target.closest('[data-action]')?.getAttribute('data-action');
      if (action === 'clear-history') {
        await api.clearBrowsingData(['history']);
        clearTimeout(uiState.timer);
        uiState.historyQuery = '';
        uiState.historySelection.clear();
        await renderInternalPage();
        toast('Browsing history cleared.');
        return;
      }
      if (action === 'export-bookmarks') {
        downloadBookmarksFile();
        return;
      }
      if (action === 'import-bookmarks') {
        if (api.isNative()) await importBookmarksNative();
        else ensureImportInput().click();
        return;
      }
      if (action === 'clear-downloads') {
        await api.clearDownloads();
        uiState.downloadSelection.clear();
        await renderInternalPage();
        toast('Download list cleared.');
        return;
      }
      if (action === 'clear-closed') {
        clearClosedTabs();
        await renderInternalPage();
        return;
      }
      if (action === 'clear-reading') {
        await api.clearReadingList();
        lastReadingCount = 0;
        await renderInternalPage();
        toast('Reading list cleared.');
        return;
      }
      if (action === 'delete-selected') {
        const page = store.internalPage ?? 'history';
        const selection = selectionFor(page);
        if (page === 'history') {
          for (const id of [...selection]) await api.deleteHistoryEntry(id);
        } else if (page === 'downloads') {
          for (const id of [...selection]) await api.removeDownload(id);
        } else {
          for (const id of [...selection]) await api.deleteBookmark(id);
        }
        selection.clear();
        await renderInternalPage();
        toast('Selection deleted.');
      }
    });

    host.addEventListener('change', (e) => {
      const check = e.target.closest('.row-check');
      if (!check) return;
      const row = check.closest('.internal-row');
      const id = row?.getAttribute('data-id');
      if (!id) return;
      const page = store.internalPage ?? 'history';
      const selection = selectionFor(page);
      if (check.checked) selection.add(id);
      else selection.delete(id);
      updateHeaderActions();
    });

    host.addEventListener('input', (e) => {
      if (e.target.id !== 'internal-search') return;
      const page = store.internalPage ?? 'history';
      if (page === 'history') uiState.historyQuery = e.target.value;
      else if (page === 'downloads') uiState.downloadQuery = e.target.value;
      else if (page === 'bookmarks') uiState.bookmarkQuery = e.target.value;
      else if (page === 'reading-list') uiState.readingQuery = e.target.value;
      clearTimeout(uiState.timer);
      uiState.timer = setTimeout(() => renderInternalPage(), 120);
    });
  }

  // Restore the search box value after every re-render.
  const search = $('#internal-search');
  if (search) {
    const page = store.internalPage ?? 'history';
    const value = page === 'history' ? uiState.historyQuery
      : page === 'downloads' ? uiState.downloadQuery
      : uiState.bookmarkQuery;
    if (search.value !== value) search.value = value;
  }
}
