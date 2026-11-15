/** Shell rendering: sidebar (workspaces, favorites, tabs), toolbar, view switching. */

import { $, $$, escapeHtml } from '../lib/dom.js';
import { displayUrl, monogram, schemeOf, SEARCH_ENGINES } from '../lib/url.js';
import { store, bookmarkForUrl, tabGroupKey, closeTab, setTabGroup } from '../state/store.js';
import { tabGroupSuggestions, duplicateTabGroups, siteKey, isAiTab } from '../lib/tabs.js';
import { renderWebView } from './browser.js';
import { renderHome } from './home.js';
import { renderInternalPage } from './internal.js';
import { updateClearButton } from './omnibar.js';

const WORKSPACE_COLORS = ['#4A6B5D', '#E3655B', '#B45309', '#3B6EA5', '#7C5CA8', '#0F766E'];
export { WORKSPACE_COLORS };

export async function renderAll() {
  renderWorkspaces();
  renderSidebarFavorites();
  renderTabs();
  renderTabSuggestions();
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
  const normal = store.tabs.filter((t) => !t.is_pinned && !t.is_private);
  const privates = store.tabs.filter((t) => t.is_private);
  if (counter) counter.textContent = `${pinned.length + normal.length + privates.length}`;

  /**
   * Render one section of the tab list (regular or private). Tabs that share a
   * group name are pulled together and get a collapsible group header.
   */
  const renderSection = (list) => {
    const groups = new Map();
    for (const tab of list) {
      if (!tab.group_name) continue;
      const key = tabGroupKey(tab);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(tab);
    }
    const ordered = [];
    const renderedGroups = new Set();
    for (const tab of list) {
      if (!tab.group_name) {
        ordered.push(tab);
        continue;
      }
      const key = tabGroupKey(tab);
      if (!renderedGroups.has(key)) {
        ordered.push(...groups.get(key));
        renderedGroups.add(key);
      }
    }

    const headerGroups = new Set();
    return ordered.map((tab) => {
    const key = tab.group_name ? tabGroupKey(tab) : null;
    const collapsed = !!key && store.collapsedTabGroups.has(key);
    const groupHeader = key && !headerGroups.has(key)
      ? `<button class="tab-group-header" data-toggle-tab-group="${escapeHtml(key)}" aria-expanded="${!store.collapsedTabGroups.has(key)}"><span class="tab-group-chevron">${store.collapsedTabGroups.has(key) ? '&#9656;' : '&#9662;'}</span><span>${escapeHtml(tab.group_name)}</span><small>${groups.get(key).length}</small></button>`
      : '';
    if (key) headerGroups.add(key);
    if (collapsed) return groupHeader;
    const isActive = tab.id === store.activeTabId;
    const fixed = isAiTab(tab);
    const title = tab.title || (fixed ? 'AI Workspace' : 'New Tab');
    const favicon = fixed
      ? `<span class="tab-favicon ai-tab-icon" aria-label="AI Workspace"><svg viewBox="0 0 24 24"><path d="M12 2.5l1.9 6.3 6.3 1.9-6.3 1.9L12 19l-1.9-6.4L3.8 10.7l6.3-1.9z"/><path d="M19 16.5l.7 2.3 2.3.7-2.3.7L19 22.5l-.7-2.3-2.3-.7 2.3-.7z"/></svg></span>`
      : tab.is_private
      ? `<span class="tab-favicon private-tab-icon" aria-label="Private tab"><svg viewBox="0 0 24 24"><path d="M3.5 10.5c.6-3.1 3.7-5 8.5-5s7.9 1.9 8.5 5h-17Z"/><path d="M2.5 11.5h19M4 13h7v2.5a3.5 3.5 0 0 1-7 0V13ZM13 13h7v2.5a3.5 3.5 0 0 1-7 0V13ZM11 14h2"/></svg></span>`
      : tab.favicon_url
        ? `<span class="tab-favicon">${escapeHtml(monogram(tab.url))}<img class="tab-favicon-img" src="${escapeHtml(tab.favicon_url)}" alt="" width="16" height="16"/></span>`
        : `<span class="tab-favicon">${escapeHtml(monogram(tab.url))}</span>`;
    const audio = store.audioStates.get(tab.id) ?? { playing: false, muted: store.mutedTabs.has(tab.id) };
    const audioButton = audio.playing || audio.muted
      ? `<button class="tab-audio ${audio.muted ? 'muted' : 'playing'}" data-mute-tab="${escapeHtml(tab.id)}" title="${audio.muted ? 'Unmute tab' : 'Mute tab'}" aria-label="${audio.muted ? 'Unmute tab audio' : 'Mute tab audio'}">
          <svg class="icon sm" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="${audio.muted ? 'M16 9l5 6m0-6-5 6' : 'M15 9a5 5 0 0 1 0 6M18 6a9 9 0 0 1 0 12'}"/></svg>
        </button>`
      : '';
    const row = `
      <div class="tab-item ${isActive ? 'active' : ''} ${tab.is_pinned ? 'pinned' : ''} ${tab.is_private ? 'private' : ''} ${fixed ? 'fixed' : ''} ${store.sleepingTabs.has(tab.id) ? 'sleeping' : ''} ${store.splitTabId === tab.id ? 'split' : ''}" role="tab" aria-selected="${isActive}" tabindex="0" data-tab="${escapeHtml(tab.id)}" title="${tab.is_private ? 'Private tab — ' : ''}${escapeHtml(tab.url)}">
        ${favicon}
        <span class="tab-title">${escapeHtml(title)}</span>
        ${store.splitTabId === tab.id ? '<span class="tab-badge split" title="Shown in the split pane">\u25eb</span>' : ''}
        ${store.sleepingTabs.has(tab.id) ? '<span class="tab-badge sleeping" title="Sleeping \u2014 switch to this tab to reload it">z</span>' : ''}
        ${tab.group_name ? `<span class="tab-group-label">${escapeHtml(tab.group_name)}</span>` : ''}
        ${audioButton}
        ${tab.is_private || fixed ? '' : `<button class="tab-pin ${tab.is_pinned ? 'active' : ''}" data-pin-tab="${escapeHtml(tab.id)}" title="${tab.is_pinned ? 'Unpin tab' : 'Pin tab'}" aria-pressed="${tab.is_pinned ? 'true' : 'false'}" aria-label="Pin or unpin tab">
          <svg class="icon sm" viewBox="0 0 24 24" ${tab.is_pinned ? 'fill="currentColor"' : ''}><path d="M12 17v5M9 3h6l1 7 3 3v2H5v-2l3-3z"/></svg>
        </button>`}
        ${fixed ? '<span class="tab-fixed-label" title="Fixed AI Workspace tab">fixed</span>' : `<button class="tab-close" data-close-tab="${escapeHtml(tab.id)}" title="Close tab (Ctrl+W)" aria-label="Close tab">
          <svg class="icon sm" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
        </button>`}
      </div>`;
    return groupHeader + row;
    }).join('');
  };

  // Private tabs live in their own group at the bottom of the list.
  wrap.innerHTML = renderSection([...pinned, ...normal])
    + (privates.length
      ? `<div class="tab-section-label">Private</div>${renderSection(privates)}`
      : '');
}

// ── Suggestions (smart groups, duplicate tabs) ────────────────────────
export function renderTabSuggestions() {
  const host = $('#tab-suggestions');
  if (!host) return;
  const items = [];
  for (const suggestion of tabGroupSuggestions(store.tabs)) {
    const key = `group:${suggestion.site}`;
    if (store.dismissedSuggestions.has(key)) continue;
    items.push({
      key,
      label: `Group ${suggestion.count} ${suggestion.site} tabs`,
      action: 'Group',
    });
  }
  const duplicates = duplicateTabGroups(store.tabs);
  if (duplicates.length) {
    const key = `dupes:${duplicates.map((group) => group[0].url).join('|')}`;
    if (!store.dismissedSuggestions.has(key)) {
      const extra = duplicates.reduce((total, group) => total + group.length - 1, 0);
      items.push({ key, label: `Close ${extra} duplicate tab${extra === 1 ? '' : 's'}`, action: 'Close' });
    }
  }
  if (items.length === 0) {
    host.innerHTML = '';
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');
  host.innerHTML = items.map((item) => `
    <div class="tab-suggestion">
      <span class="tab-suggestion-text">${escapeHtml(item.label)}</span>
      <button class="tab-suggestion-go" data-suggestion-run="${escapeHtml(item.key)}">${item.action}</button>
      <button class="tab-suggestion-dismiss" data-suggestion-dismiss="${escapeHtml(item.key)}" title="Dismiss" aria-label="Dismiss suggestion">&times;</button>
    </div>`).join('');

  host.onclick = async (event) => {
    const dismiss = event.target.closest('[data-suggestion-dismiss]')?.getAttribute('data-suggestion-dismiss');
    if (dismiss) {
      store.dismissedSuggestions.add(dismiss);
      renderTabSuggestions();
      return;
    }
    const run = event.target.closest('[data-suggestion-run]')?.getAttribute('data-suggestion-run');
    if (!run) return;
    if (run.startsWith('group:')) {
      const site = run.slice('group:'.length);
      const loose = store.tabs.filter((tab) => !tab.is_private && !tab.is_pinned && !tab.group_name && siteKey(tab.url) === site);
      for (const tab of loose) await setTabGroup(tab.id, site);
      store.dismissedSuggestions.add(run);
    } else if (run.startsWith('dupes:')) {
      for (const group of duplicateTabGroups(store.tabs)) {
        const keep = group.find((tab) => tab.id === store.activeTabId) ?? group[0];
        for (const tab of group) {
          if (tab.id !== keep.id) await closeTab(tab.id);
        }
      }
      store.dismissedSuggestions.add(run);
    }
    await renderAll();
  };
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
  const engineSelect = $('#omnibar-search-engine');
  const hasWebIdentity = scheme === 'http' || scheme === 'https';
  lockBtn?.classList.toggle('insecure', scheme === 'http');
  lockBtn?.classList.toggle('hidden', !hasWebIdentity);
  if (engineSelect) {
    const compactEngines = window.matchMedia('(max-width: 420px)').matches;
    const optionLayout = compactEngines ? 'compact' : 'full';
    if (engineSelect.dataset.optionLayout !== optionLayout) {
      engineSelect.innerHTML = SEARCH_ENGINES.map((engine) =>
        `<option value="${engine.id}">${compactEngines && engine.id === 'duckduckgo' ? 'DDG' : engine.name}</option>`).join('')
        + '<option value="custom">Custom…</option>';
      engineSelect.dataset.optionLayout = optionLayout;
    }
    const engineId = store.settings.search_engine || 'duckduckgo';
    engineSelect.value = engineId;
    engineSelect.title = `Search engine: ${SEARCH_ENGINES.find((engine) => engine.id === engineId)?.name ?? 'Custom'}`;
    engineSelect.classList.toggle('hidden', hasWebIdentity);
  }

  const star = $('#bookmark-toggle');
  const bookmarked = tab && tab.url !== 'govind://home' ? bookmarkForUrl(tab.url) : null;
  if (star) {
    star.classList.toggle('active', !!bookmarked);
    star.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
  }

  const reader = $('#btn-reader-mode');
  if (reader) {
    const enabled = !!tab && store.readerModeTabs.has(tab.id);
    reader.classList.toggle('active', enabled);
    reader.classList.toggle('hidden', !tab || store.isInternalTab(tab));
    reader.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }

  const split = $('#btn-split-view');
  if (split) {
    const splittable = !!tab && !store.isInternalTab(tab) && !store.isHomeTab(tab);
    split.classList.toggle('hidden', !splittable && !store.splitTabId);
    split.classList.toggle('active', !!store.splitTabId);
    split.setAttribute('aria-pressed', store.splitTabId ? 'true' : 'false');
  }

  updateClearButton();
  updateThemeToggleIcon();
}

export function updateThemeToggleIcon(theme = store.settings.theme || 'zen-light') {
  const btn = $('#btn-theme-toggle');
  if (!btn) return;
  const isDark = theme === 'zen-dark';
  btn.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = isDark
    ? '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg class="icon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
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
  const sidebar = $('#sidebar');
  if (!sidebar) return;
  const mobile = window.matchMedia('(max-width: 700px)').matches;
  if (mobile) sidebar.classList.remove('collapsed');
  const open = mobile
    ? sidebar.classList.toggle('mobile-open')
    : !sidebar.classList.toggle('collapsed');
  $('#sidebar-backdrop')?.classList.toggle('hidden', !mobile || !open);
  $('#btn-sidebar-toggle')?.setAttribute('aria-expanded', String(open));
}
