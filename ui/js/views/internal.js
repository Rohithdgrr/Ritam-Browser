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
import { store, refreshBookmarks } from '../state/store.js';
import { renderSettingsPage } from './settings.js';

const ICON = {
  history: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  downloads: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  bookmarks: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  settings: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M19.8 4.2l-2.1 2.1M6.3 17.7l-2.1 2.1"/></svg>',
  trash: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  folder: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  search: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
  file: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
};

const NAV_ITEMS = [
  { page: 'history', label: 'History', icon: ICON.history },
  { page: 'downloads', label: 'Downloads', icon: ICON.downloads },
  { page: 'bookmarks', label: 'Bookmarks', icon: ICON.bookmarks },
  { page: 'settings', label: 'Settings', icon: ICON.settings },
];

const PAGE_TITLES = {
  history: 'History',
  downloads: 'Downloads',
  bookmarks: 'Bookmarks',
  settings: 'Settings',
};

/** Per-page UI state (kept between renders). */
const uiState = {
  historyQuery: '',
  downloadQuery: '',
  bookmarkQuery: '',
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

  if (page === 'settings') {
    host.innerHTML = '<div class="internal-shell" id="internal-shell"></div>';
    renderSettingsPage($('#internal-shell'));
    return;
  }

  host.innerHTML = `
    <div class="internal-shell">
      <nav class="internal-nav" aria-label="Internal pages">
        <div class="internal-nav-brand"><span class="logo-dot" aria-hidden="true">G</span> Govind</div>
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

  wireInternal();
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

// ── Header actions (Clear all / Delete selected) ──────────────────────
function updateHeaderActions() {
  const host = $('#internal-header-actions');
  if (!host) return;
  const page = store.internalPage ?? 'history';
  const selection =
    page === 'history' ? uiState.historySelection :
    page === 'downloads' ? uiState.downloadSelection :
    uiState.bookmarkSelection;

  const buttons = [];
  if (selection.size > 0) {
    buttons.push(`<button class="btn-secondary" data-action="delete-selected">Delete selected (${selection.size})</button>`);
  }
  if (page === 'downloads') {
    buttons.push('<button class="btn-secondary" data-action="clear-downloads">Clear all</button>');
  }
  host.innerHTML = buttons.join('');
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

      const action = e.target.closest('[data-action]')?.getAttribute('data-action');
      if (action === 'clear-downloads') {
        await api.clearDownloads();
        uiState.downloadSelection.clear();
        await renderInternalPage();
        toast('Download list cleared.');
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
      else uiState.bookmarkQuery = e.target.value;
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
