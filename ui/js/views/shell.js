/** Shell rendering: sidebar (workspaces, favorites, tabs), toolbar, view switching. */

import { $, $$, escapeHtml } from '../lib/dom.js';
import { displayUrl, monogram, schemeOf } from '../lib/url.js';
import { store, bookmarkForUrl } from '../state/store.js';
import { renderWebView } from './browser.js';
import { renderHome } from './home.js';
import { renderInternalPage } from './internal.js';

const WORKSPACE_COLORS = ['#4A6B5D', '#E3655B', '#B45309', '#3B6EA5', '#7C5CA8', '#0F766E'];
export { WORKSPACE_COLORS };

export async function renderAll() {
  renderWorkspaces();
  renderSidebarFavorites();
  renderTabs();
  renderToolbar();
  renderView();
}

// ── Workspaces ────────────────────────────────────────────────────────
export function renderWorkspaces() {
  const wrap = $('#workspace-list');
  if (!wrap) return;
  wrap.innerHTML = store.workspaces.map((ws) => {
    const isActive = ws.id === store.activeWorkspaceId;
    const count = store.tabs.filter((t) => t.workspace_id === ws.id).length;
    // Count reflects only loaded (active-workspace) tabs; others show as ·
    const countLabel = isActive ? String(count) : '·';
    const deletable = store.workspaces.length > 1;
    return `
      <button class="workspace-item ${isActive ? 'active' : ''}" data-workspace="${escapeHtml(ws.id)}" role="listitem" aria-current="${isActive}" title="${escapeHtml(ws.name)}">
        <span class="dot" style="background:${escapeHtml(ws.color)}"></span>
        <span class="ws-name">${escapeHtml(ws.name)}</span>
        <span class="ws-count">${countLabel}</span>
        ${deletable ? `<span class="ws-delete" data-delete-workspace="${escapeHtml(ws.id)}" role="button" tabindex="0" title="Delete workspace" aria-label="Delete workspace ${escapeHtml(ws.name)}">
          <svg class="icon sm" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
        </span>` : ''}
      </button>`;
  }).join('');
}

// ── Favorites (sidebar) ───────────────────────────────────────────────
export function renderSidebarFavorites() {
  const wrap = $('#favorites-list');
  const empty = $('#favorites-empty');
  if (!wrap) return;
  const favorites = store.bookmarks.filter((b) => b.is_favorite).slice(0, 8);
  if (empty) empty.classList.toggle('hidden', favorites.length > 0);
  wrap.innerHTML = favorites.map((b) => `
    <button class="fav-item" data-url="${escapeHtml(b.url)}" title="${escapeHtml(b.title)}">
      <span class="fav-icon">${escapeHtml(monogram(b.url))}</span>
      <span class="fav-name">${escapeHtml(b.title.slice(0, 14))}</span>
    </button>`).join('');
}

// ── Tabs ──────────────────────────────────────────────────────────────
export function renderTabs() {
  const wrap = $('#tab-list');
  const counter = $('#tab-count');
  if (!wrap) return;
  const pinned = store.tabs.filter((t) => t.is_pinned);
  const normal = store.tabs.filter((t) => !t.is_pinned);
  const ordered = [...pinned, ...normal];
  if (counter) counter.textContent = `${ordered.length}`;

  wrap.innerHTML = ordered.map((tab) => {
    const isActive = tab.id === store.activeTabId;
    const title = tab.title || 'New Tab';
    return `
      <div class="tab-item ${isActive ? 'active' : ''} ${tab.is_pinned ? 'pinned' : ''}" role="tab" aria-selected="${isActive}" tabindex="0" data-tab="${escapeHtml(tab.id)}" title="${escapeHtml(tab.url)}">
        <span class="tab-favicon">${escapeHtml(monogram(tab.url))}</span>
        <span class="tab-title">${escapeHtml(title)}</span>
        <button class="tab-pin ${tab.is_pinned ? 'active' : ''}" data-pin-tab="${escapeHtml(tab.id)}" title="${tab.is_pinned ? 'Unpin tab' : 'Pin tab'}" aria-pressed="${tab.is_pinned ? 'true' : 'false'}" aria-label="Pin or unpin tab">
          <svg class="icon sm" viewBox="0 0 24 24" ${tab.is_pinned ? 'fill="currentColor"' : ''}><path d="M12 17v5M9 3h6l1 7 3 3v2H5v-2l3-3z"/></svg>
        </button>
        <button class="tab-close" data-close-tab="${escapeHtml(tab.id)}" title="Close tab (Ctrl+W)" aria-label="Close tab">
          <svg class="icon sm" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>`;
  }).join('');
}

// ── Toolbar / omnibar / views ─────────────────────────────────────────
export function renderToolbar() {
  const tab = store.activeTab();
  const input = $('#omnibar-input');
  if (input && document.activeElement !== input) {
    input.value = tab ? displayUrl(tab.url) : '';
  }

  // Lock icon + bookmark star state
  const scheme = tab ? schemeOf(tab.url) : null;
  const lockBtn = $('#security-btn');
  lockBtn?.classList.toggle('insecure', scheme === 'http');

  const star = $('#bookmark-toggle');
  const bookmarked = tab && tab.url !== 'govind://home' ? bookmarkForUrl(tab.url) : null;
  if (star) {
    star.classList.toggle('active', !!bookmarked);
    star.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
  }

  // Home button active state is cosmetic only
}

export function renderView() {
  const home = $('#view-home');
  const web = $('#view-web');
  const internal = $('#view-internal');
  if (!home || !web) return;
  const showWeb = store.view === 'web';
  const showInternal = store.view === 'internal';
  home.classList.toggle('hidden', showWeb || showInternal);
  web.classList.toggle('hidden', !showWeb);
  internal?.classList.toggle('hidden', !showInternal);
  if (showWeb) {
    renderWebView();
  } else if (showInternal) {
    renderInternalPage();
  } else {
    renderHome();
  }
}

// ── Loading bar ───────────────────────────────────────────────────────
let loadingTimer = null;
export function startLoading() {
  const bar = $('#loading-bar');
  if (!bar) return;
  bar.classList.add('active');
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => stopLoading(), 4000); // safety net
}
export function stopLoading() {
  $('#loading-bar')?.classList.remove('active');
  clearTimeout(loadingTimer);
}

// ── Omnibar focus ─────────────────────────────────────────────────────
export function focusOmnibar() {
  const input = $('#omnibar-input');
  if (!input) return;
  input.focus();
  input.select();
}

export function toggleSidebar() {
  $('#sidebar')?.classList.toggle('collapsed');
}
