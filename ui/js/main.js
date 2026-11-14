/** Govind Browser — bootstrap, event wiring and keyboard shortcuts. */

import { $, $$, toast } from './lib/dom.js';
import * as api from './services/ipc.js';
import {
  store, initStore, createTab, closeTab, activateTab, togglePinTab, reorderTab,
  navigate, goHome, goBack, goForward, reloadTab, createWorkspace, switchWorkspace,
  deleteWorkspace, toggleBookmarkCurrent, refreshBookmarks, syncNativeViews,
} from './state/store.js';
import {
  renderAll, renderView, renderToolbar, renderTabs, renderSidebarFavorites,
  startLoading, stopLoading, focusOmnibar, toggleSidebar,
} from './views/shell.js';
import { renderHome, wireHome } from './views/home.js';
import { openPanel, closePanels, isAnyPanelOpen, wirePanels } from './views/panels.js';
import { openSettings, closeSettings, isSettingsOpen, wireSettings, applyTheme } from './views/settings.js';
import { initPalette, openPalette, closePalette, isPaletteOpen } from './views/palette.js';
import { reloadWebView, historyWebView } from './views/browser.js';
import { isNative } from './services/ipc.js';
import { displayUrl, HOME_URL, schemeOf } from './lib/url.js';

// ── Core actions ──────────────────────────────────────────────────────
async function doNavigate(raw) {
  startLoading();
  try {
    const result = await navigate(raw);
    if (result) await renderAll();
    stopLoading();
    return result;
  } catch (err) {
    stopLoading();
    toast(`Couldn't navigate: ${err?.message ?? err}`);
  }
}

const openPanelWithNav = (name) =>
  openPanel(name, { onNavigate: (url) => doNavigate(url) });

async function openActiveBookmarkToggle() {
  const result = await toggleBookmarkCurrent();
  if (!result) { toast('Nothing to bookmark on this page.'); return; }
  renderToolbar();
  renderSidebarFavorites();
  const homeVisible = !$('#view-home')?.classList.contains('hidden');
  if (homeVisible) await renderHome();
  toast(result.bookmarked ? 'Bookmarked.' : 'Bookmark removed.');
}

async function copyCurrentUrl() {
  const tab = store.activeTab();
  if (!tab) return;
  const ok = await api.copyText(tab.url);
  toast(ok ? 'URL copied to clipboard.' : 'Could not access the clipboard.');
}

// ── Bootstrap ─────────────────────────────────────────────────────────
async function boot() {
  api.onPreviewNotice((msg) => toast(msg));

  await initStore();
  applyTheme(store.settings.theme);

  // Wire everything before first paint of dynamic regions
  wireTitlebar();
  wireToolbar();
  wireSidebar();
  wireHome({ onNavigate: doNavigate, onOpenPanel: openPanelWithNav });
  wirePanels({ onNavigate: doNavigate });
  wireSettings();
  wireMenuAndPopover();
  wireGlobalEvents();

  initPalette(buildPaletteCommands());
  wireShortcuts();

  await renderAll();
  await syncNativeViews();

  if (!isNative() && !sessionStorage.getItem('govind.preview.notified')) {
    sessionStorage.setItem('govind.preview.notified', '1');
    setTimeout(() => toast('Preview mode: web pages load in an embedded frame where sites allow it. Install the app for full native browsing.'), 600);
  }
}

// ── Titlebar & window chrome ──────────────────────────────────────────
function wireTitlebar() {
  $('#win-minimize')?.addEventListener('click', () => api.minimizeWindow());
  $('#win-maximize')?.addEventListener('click', () => api.toggleMaximizeWindow());
  $('#win-close')?.addEventListener('click', () => api.closeWindow());
}

// ── Toolbar ───────────────────────────────────────────────────────────
function wireToolbar() {
  $('#btn-back')?.addEventListener('click', async () => { historyWebView('back'); goBack(); });
  $('#btn-forward')?.addEventListener('click', async () => { historyWebView('forward'); goForward(); });
  $('#btn-reload')?.addEventListener('click', async () => {
    startLoading();
    reloadWebView();
    await reloadTab();
    setTimeout(stopLoading, 350);
  });
  $('#btn-home')?.addEventListener('click', async () => { await goHome(); await renderAll(); });

  const input = $('#omnibar-input');
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doNavigate(input.value); input.blur(); }
    else if (e.key === 'Escape') { input.blur(); renderToolbar(); }
  });
  input?.addEventListener('focus', () => input.select());

  $('#bookmark-toggle')?.addEventListener('click', openActiveBookmarkToggle);

  $('#security-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSecurityPopover();
  });

  $('#btn-more')?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
}

function toggleMenu(force) {
  const menu = $('#more-menu');
  if (!menu) return;
  const shouldOpen = force ?? menu.classList.contains('hidden');
  $('#security-popover')?.classList.add('hidden');
  menu.classList.toggle('hidden', !shouldOpen);
}

function toggleSecurityPopover(force) {
  const pop = $('#security-popover');
  if (!pop) return;
  const shouldOpen = force ?? pop.classList.contains('hidden');
  $('#more-menu')?.classList.add('hidden');
  pop.classList.toggle('hidden', !shouldOpen);
  if (shouldOpen) {
    const tab = store.activeTab();
    const scheme = tab ? schemeOf(tab.url) : null;
    const title = $('#security-title');
    const body = $('#security-body');
    if (title && body) {
      if (tab?.url === HOME_URL) {
        title.textContent = 'Internal page';
        body.innerHTML = 'This is Govind\u2019s built-in start page. It never makes network requests and cannot run remote code.';
      } else if (scheme === 'https') {
        title.textContent = 'Encrypted connection (HTTPS)';
        body.innerHTML = `Traffic to <code>${escapeForPopover(displayUrl(tab.url))}</code> is encrypted in transit. This only reflects the URL scheme — Govind does not yet inspect the actual server certificate.`;
      } else if (scheme === 'http') {
        title.textContent = 'Not encrypted (HTTP)';
        body.innerHTML = `Traffic to <code>${escapeForPopover(displayUrl(tab.url))}</code> is sent in cleartext. Avoid entering passwords or other sensitive data on this site.`;
      } else {
        title.textContent = 'Site information';
        body.textContent = 'No connection security information is available for this page.';
      }
    }
  }
}
const escapeForPopover = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wireMenuAndPopover() {
  $('#menu-bookmark')?.addEventListener('click', () => { toggleMenu(false); openActiveBookmarkToggle(); });
  $('#menu-copy-url')?.addEventListener('click', () => { toggleMenu(false); copyCurrentUrl(); });
  $('#menu-print')?.addEventListener('click', () => { toggleMenu(false); window.print(); });
  $('#menu-clear-data')?.addEventListener('click', () => { toggleMenu(false); openSettings('privacy'); });
  $('#menu-settings')?.addEventListener('click', () => { toggleMenu(false); openSettings('general'); });
  $('#menu-about')?.addEventListener('click', () => { toggleMenu(false); openSettings('about'); });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#more-menu') && !e.target.closest('#btn-more')) $('#more-menu')?.classList.add('hidden');
    if (!e.target.closest('#security-popover') && !e.target.closest('#security-btn')) $('#security-popover')?.classList.add('hidden');
  });
}

// ── Sidebar, workspaces, tabs ─────────────────────────────────────────
function wireSidebar() {
  $('#btn-new-tab')?.addEventListener('click', async () => { await createTab(); await renderAll(); focusOmnibar(); });
  $('#btn-palette')?.addEventListener('click', openPalette);

  // Footer buttons toggle their panels
  $('#btn-bookmarks-panel')?.addEventListener('click', () => openPanelWithNav('bookmarks'));
  $('#btn-history-panel')?.addEventListener('click', () => openPanelWithNav('history'));
  $('#btn-scratchpad')?.addEventListener('click', () => openPanelWithNav('scratchpad'));
  $('#btn-downloads-panel')?.addEventListener('click', () => openPanelWithNav('downloads'));
  $('#btn-settings')?.addEventListener('click', () => openSettings('general'));

  // Workspace creation flow
  const addRow = $('#workspace-add-row');
  const nameInput = $('#workspace-name-input');
  $('#btn-add-workspace')?.addEventListener('click', () => {
    addRow?.classList.remove('hidden');
    nameInput?.focus();
  });
  const cancelAdd = () => { addRow?.classList.add('hidden'); if (nameInput) nameInput.value = ''; };
  $('#workspace-add-cancel')?.addEventListener('click', cancelAdd);
  const confirmAdd = async () => {
    const name = nameInput?.value.trim();
    if (!name) { cancelAdd(); return; }
    await createWorkspace(name);
    cancelAdd();
    await renderAll();
    toast(`Workspace “${name}” created.`);
  };
  $('#workspace-add-confirm')?.addEventListener('click', confirmAdd);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmAdd();
    else if (e.key === 'Escape') cancelAdd();
  });

  // Workspace switch / delete (delegated)
  $('#workspace-list')?.addEventListener('click', async (e) => {
    const deleteId = e.target.closest('[data-delete-workspace]')?.getAttribute('data-delete-workspace');
    if (deleteId) {
      e.stopPropagation();
      try {
        await deleteWorkspace(deleteId);
        await renderAll();
        toast('Workspace deleted.');
      } catch (err) {
        toast(err?.message ?? 'Could not delete workspace.');
      }
      return;
    }
    const wsId = e.target.closest('[data-workspace]')?.getAttribute('data-workspace');
    if (wsId && wsId !== store.activeWorkspaceId) {
      await switchWorkspace(wsId);
      await renderAll();
    }
  });

  // Tabs (delegated): activate / close / pin
  $('#tab-list')?.addEventListener('click', async (e) => {
    const closeId = e.target.closest('[data-close-tab]')?.getAttribute('data-close-tab');
    if (closeId) { e.stopPropagation(); await closeTab(closeId); await renderAll(); return; }
    const pinId = e.target.closest('[data-pin-tab]')?.getAttribute('data-pin-tab');
    if (pinId) { e.stopPropagation(); await togglePinTab(pinId); await renderAll(); return; }
    const tabId = e.target.closest('[data-tab]')?.getAttribute('data-tab');
    if (tabId && tabId !== store.activeTabId) { await activateTab(tabId); await renderAll(); }
  });
  $('#tab-list')?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' && e.key !== 'Delete') return;
    const tabId = e.target.closest('[data-tab]')?.getAttribute('data-tab');
    if (!tabId) return;
    if (e.key === 'Enter') { await activateTab(tabId); await renderAll(); }
    else { await closeTab(tabId); await renderAll(); }
  });

  // Sidebar favorites navigate
  $('#favorites-list')?.addEventListener('click', (e) => {
    const url = e.target.closest('[data-url]')?.getAttribute('data-url');
    if (url) doNavigate(url);
  });
}

// ── Global events (document-level custom events + window) ─────────────
function wireGlobalEvents() {
  document.addEventListener('govind:activate-tab', async (e) => {
    await activateTab(e.detail);
    await renderAll();
  });
  document.addEventListener('govind:navigate', (e) => doNavigate(e.detail));
  document.addEventListener('govind:bookmarks-changed', async () => { await renderAll(); });
  document.addEventListener('govind:history-changed', async () => {
    if (!$('#view-home')?.classList.contains('hidden')) await renderHome();
  });

  // Keep native webview bounds in sync with the layout
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => syncNativeViews(), 80);
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────
function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'k') { e.preventDefault(); isPaletteOpen() ? closePalette() : openPalette(); return; }
    if (mod && key === 't') { e.preventDefault(); createTab().then(renderAll).then(focusOmnibar); return; }
    if (mod && key === 'w') {
      e.preventDefault();
      if (store.activeTabId) closeTab(store.activeTabId).then(renderAll);
      return;
    }
    if (mod && key === 'l') { e.preventDefault(); focusOmnibar(); return; }
    if (mod && key === 'r') { e.preventDefault(); $('#btn-reload')?.click(); return; }
    if (mod && key === 'd') { e.preventDefault(); openActiveBookmarkToggle(); return; }
    if (mod && key === ',') { e.preventDefault(); isSettingsOpen() ? closeSettings() : openSettings('general'); return; }

    // Ctrl/Cmd+1…9 — jump to tab N (9 = last)
    if (mod && /^[1-9]$/.test(key)) {
      e.preventDefault();
      const idx = key === '9' ? store.tabs.length - 1 : Number(key) - 1;
      const tab = store.tabs[idx];
      if (tab) activateTab(tab.id).then(renderAll);
      return;
    }
    // Ctrl+Tab / Ctrl+Shift+Tab — cycle
    if (mod && key === 'tab') {
      e.preventDefault();
      if (store.tabs.length < 2) return;
      const idx = store.tabs.findIndex((t) => t.id === store.activeTabId);
      const delta = e.shiftKey ? -1 : 1;
      const next = store.tabs[(idx + delta + store.tabs.length) % store.tabs.length];
      activateTab(next.id).then(renderAll);
      return;
    }

    if (e.altKey && key === 'arrowleft') { e.preventDefault(); historyWebView('back'); goBack(); return; }
    if (e.altKey && key === 'arrowright') { e.preventDefault(); historyWebView('forward'); goForward(); return; }

    if (e.key === 'Escape') {
      if (isPaletteOpen()) return closePalette();
      if (isSettingsOpen()) return closeSettings();
      if (isAnyPanelOpen()) return closePanels();
      $('#more-menu')?.classList.add('hidden');
      $('#security-popover')?.classList.add('hidden');
    }
  });
}

// ── Command palette commands ──────────────────────────────────────────
function buildPaletteCommands() {
  const run = (fn) => async () => { await fn(); };
  return [
    { title: 'New Tab', hint: 'Ctrl T', keywords: ['open', 'create'], run: run(async () => { await createTab(); await renderAll(); focusOmnibar(); }) },
    { title: 'Close Current Tab', hint: 'Ctrl W', keywords: ['remove'], run: run(async () => { if (store.activeTabId) { await closeTab(store.activeTabId); await renderAll(); } }) },
    { title: 'Reload Page', hint: 'Ctrl R', keywords: ['refresh'], run: run(async () => { reloadWebView(); await reloadTab(); }) },
    { title: 'Go Home', hint: 'Home', keywords: ['start page'], run: run(async () => { await goHome(); await renderAll(); }) },
    { title: 'Focus Address Bar', hint: 'Ctrl L', keywords: ['omnibar', 'url'], run: run(focusOmnibar) },
    { title: 'Toggle Bookmark on This Page', hint: 'Ctrl D', keywords: ['star', 'save'], run: run(openActiveBookmarkToggle) },
    { title: 'Open Bookmarks', hint: 'Panel', keywords: ['favorites list'], run: run(async () => openPanelWithNav('bookmarks')) },
    { title: 'Open History', hint: 'Panel', keywords: ['recent', 'visited'], run: run(async () => openPanelWithNav('history')) },
    { title: 'Open Scratchpad', hint: 'Panel', keywords: ['note', 'notes'], run: run(async () => openPanelWithNav('scratchpad')) },
    { title: 'Open Downloads', hint: 'Panel', keywords: ['files'], run: run(async () => openPanelWithNav('downloads')) },
    { title: 'Clear Browsing Data…', hint: 'Privacy', keywords: ['delete', 'privacy', 'erase'], run: run(async () => openSettings('privacy')) },
    { title: 'Toggle Dark / Light Theme', hint: 'Appearance', keywords: ['appearance', 'zen dark', 'color'], run: run(async () => {
        const next = (store.settings.theme === 'zen-dark') ? 'zen-light' : 'zen-dark';
        store.settings.theme = next;
        applyTheme(next);
        await api.setSetting({ key: 'theme', value: next });
      }) },
    { title: 'Open Settings', hint: 'Ctrl ,', keywords: ['preferences', 'options'], run: run(async () => openSettings('general')) },
    { title: 'Toggle Sidebar', hint: 'View', keywords: ['collapse', 'hide'], run: run(toggleSidebar) },
    { title: 'Move Tab Up', hint: 'Reorder', keywords: ['reorder'], run: run(async () => { if (store.activeTabId) { await reorderTab(store.activeTabId, 'up'); await renderAll(); } }) },
    { title: 'Move Tab Down', hint: 'Reorder', keywords: ['reorder'], run: run(async () => { if (store.activeTabId) { await reorderTab(store.activeTabId, 'down'); await renderAll(); } }) },
    { title: 'Pin / Unpin Current Tab', hint: 'Tabs', keywords: ['pin'], run: run(async () => { if (store.activeTabId) { await togglePinTab(store.activeTabId); await renderAll(); } }) },
  ];
}

boot().catch((err) => {
  console.error('Boot failed:', err);
  toast('Something went wrong while starting Govind. See console for details.');
});
