/** Govind Browser — bootstrap, event wiring and keyboard shortcuts. */

import { $, $$, toast } from './lib/dom.js';
import * as api from './services/ipc.js';
import {
  store, initStore, createTab, closeTab, activateTab, togglePinTab, reorderTab,
  navigate, openInternalPage, goHome, goBack, goForward, reloadTab, createWorkspace,
  switchWorkspace, deleteWorkspace, toggleBookmarkCurrent, refreshBookmarks, syncNativeViews,
  applyTabMeta, internalNavStep,
} from './state/store.js';
import {
  renderAll, renderView, renderToolbar, renderTabs, renderSidebarFavorites,
  startLoading, stopLoading, focusOmnibar, toggleSidebar,
} from './views/shell.js';
import { renderHome, wireHome } from './views/home.js';
import { openPanel, closePanels, isAnyPanelOpen, wirePanels } from './views/panels.js';
import { applyTheme } from './views/settings.js';
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

async function openInternal(page) {
  const result = await openInternalPage(page);
  if (result) await renderAll();
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

/**
 * Every user-visible action lives here so the keyboard handler, the command
 * palette and the native (global) shortcuts all run exactly the same code.
 */
const actions = {
  'new-tab': async () => { await createTab(); await renderAll(); focusOmnibar(); },
  'close-tab': async () => { if (store.activeTabId) { await closeTab(store.activeTabId); await renderAll(); } },
  'palette': async () => { isPaletteOpen() ? closePalette() : await openPalette(); },
  'focus-omnibar': async () => { focusOmnibar(); },
  'reload': async () => { startLoading(); reloadWebView(); await reloadTab(); setTimeout(stopLoading, 350); },
  'bookmark': async () => { await openActiveBookmarkToggle(); },
  'settings': async () => { await openInternal('settings'); },
  'history': async () => { await openInternal('history'); },
  'downloads': async () => { await openInternal('downloads'); },
  'bookmarks': async () => { await openInternal('bookmarks'); },
  'home': async () => { await goHome(); await renderAll(); },
  'back': async () => { await goBackInternal(); },
  'forward': async () => { await goForwardInternal(); },
  'next-tab': async () => { await cycleTab(1); },
  'prev-tab': async () => { await cycleTab(-1); },
  'zoom-in': async () => { await changeZoom(0.1); },
  'zoom-out': async () => { await changeZoom(-0.1); },
  'zoom-reset': async () => { await api.zoomTab(store.activeTabId, 1).catch(() => {}); },
};

/** Back: internal pages keep their own stack, web pages use the engine. */
async function goBackInternal() {
  const tab = store.activeTab();
  if (tab && store.isInternalTab(tab)) {
    const url = internalNavStep(tab.id, -1);
    if (url) { await doNavigate(url); return; }
  }
  historyWebView('back');
  goBack();
}

async function goForwardInternal() {
  const tab = store.activeTab();
  if (tab && store.isInternalTab(tab)) {
    const url = internalNavStep(tab.id, 1);
    if (url) { await doNavigate(url); return; }
  }
  historyWebView('forward');
  goForward();
}

let zoomFactor = 1;
async function changeZoom(delta) {
  zoomFactor = Math.min(3, Math.max(0.25, Math.round((zoomFactor + delta) * 100) / 100));
  await api.zoomTab(store.activeTabId, zoomFactor).catch(() => {});
  toast(`Zoom: ${Math.round(zoomFactor * 100)}%`);
}

async function cycleTab(delta) {
  if (store.tabs.length < 2) return;
  const idx = store.tabs.findIndex((t) => t.id === store.activeTabId);
  const next = store.tabs[(idx + delta + store.tabs.length) % store.tabs.length];
  await activateTab(next.id);
  await renderAll();
}

async function jumpToTab(position) {
  const idx = position === 9 ? store.tabs.length - 1 : position - 1;
  const tab = store.tabs[idx];
  if (!tab) return;
  await activateTab(tab.id);
  await renderAll();
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
  wirePanels();
  wireMenuAndPopover();
  wireGlobalEvents();

  initPalette(buildPaletteCommands());
  wireShortcuts();
  await wireNativeEvents();

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
  $('#btn-back')?.addEventListener('click', () => actions.back());
  $('#btn-forward')?.addEventListener('click', () => actions.forward());
  $('#btn-reload')?.addEventListener('click', () => actions.reload());
  $('#btn-home')?.addEventListener('click', () => actions.home());

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
        body.innerHTML = 'This is Govind’s built-in start page. It never makes network requests and cannot run remote code.';
      } else if (tab?.url.startsWith('govind://')) {
        title.textContent = 'Govind page';
        body.innerHTML = `This is a local Govind page (<code>${escapeForPopover(tab.url)}</code>). It is rendered by the app itself and makes no network requests.`;
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
  $('#menu-new-tab')?.addEventListener('click', () => { toggleMenu(false); actions['new-tab'](); });
  $('#menu-history')?.addEventListener('click', () => { toggleMenu(false); actions.history(); });
  $('#menu-downloads')?.addEventListener('click', () => { toggleMenu(false); actions.downloads(); });
  $('#menu-bookmarks')?.addEventListener('click', () => { toggleMenu(false); actions.bookmarks(); });
  $('#menu-zoom-in')?.addEventListener('click', () => { toggleMenu(false); actions['zoom-in'](); });
  $('#menu-zoom-out')?.addEventListener('click', () => { toggleMenu(false); actions['zoom-out'](); });
  $('#menu-zoom-reset')?.addEventListener('click', () => { toggleMenu(false); actions['zoom-reset'](); });
  $('#menu-print')?.addEventListener('click', () => {
    toggleMenu(false);
    if (isNative()) api.printTab(store.activeTabId);
    else window.print();
  });
  $('#menu-clear-data')?.addEventListener('click', () => { toggleMenu(false); openInternal('settings:privacy'); });
  $('#menu-settings')?.addEventListener('click', () => { toggleMenu(false); actions.settings(); });
  $('#menu-about')?.addEventListener('click', () => { toggleMenu(false); openInternal('settings:about'); });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#more-menu') && !e.target.closest('#btn-more')) $('#more-menu')?.classList.add('hidden');
    if (!e.target.closest('#security-popover') && !e.target.closest('#security-btn')) $('#security-popover')?.classList.add('hidden');
  });
}

// ── Sidebar, workspaces, tabs ─────────────────────────────────────────
function wireSidebar() {
  $('#btn-new-tab')?.addEventListener('click', () => actions['new-tab']());
  $('#btn-palette')?.addEventListener('click', () => actions.palette());

  // Footer buttons open the internal pages
  $('#btn-bookmarks-panel')?.addEventListener('click', () => actions.bookmarks());
  $('#btn-history-panel')?.addEventListener('click', () => actions.history());
  $('#btn-scratchpad')?.addEventListener('click', () => openPanelWithNav('scratchpad'));
  $('#btn-downloads-panel')?.addEventListener('click', () => actions.downloads());
  $('#btn-settings')?.addEventListener('click', () => actions.settings());

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
  document.addEventListener('govind:open-internal', async (e) => {
    await openInternal(String(e.detail ?? ''));
  });
  document.addEventListener('govind:bookmarks-changed', async () => { await renderAll(); });
  document.addEventListener('govind:history-changed', async () => {
    if (!$('#view-home')?.classList.contains('hidden')) await renderHome();
  });

  // Keep native webviews aligned with the layout
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => syncNativeViews(), 80);
  });
}

// ── Native events (Tauri → shell) ─────────────────────────────────────
async function wireNativeEvents() {
  // Global shortcuts (they also fire while a page has the keyboard focus).
  api.listen('shortcut', (event) => {
    const action = event.payload;
    const run = actions[action] ?? (action?.startsWith('tab-') ? () => jumpToTab(Number(action.slice(4))) : null);
    if (run) run().catch((err) => console.error('shortcut failed', err));
  });

  // The page navigated (link click, redirect, …).
  api.listen('tab-url-changed', async (event) => {
    const { tabId, url } = event.payload ?? {};
    if (!tabId || !url) return;
    applyTabMeta(tabId, { url });
    await api.updateTabMeta(tabId, { url }).catch(() => {});
    if (tabId === store.activeTabId) {
      renderToolbar();
      const title = store.tabs.find((t) => t.id === tabId)?.title;
      api.addHistoryEntry(url, title || url).catch(() => {});
    }
    renderTabs();
  });

  // The page reported its real title.
  api.listen('tab-title-changed', async (event) => {
    const { tabId, title } = event.payload ?? {};
    if (!tabId || !title) return;
    applyTabMeta(tabId, { title });
    await api.updateTabMeta(tabId, { title }).catch(() => {});
    renderTabs();
    if (tabId === store.activeTabId) renderToolbar();
  });

  api.listen('tab-load-started', (event) => {
    if (event.payload?.tabId === store.activeTabId) startLoading();
  });
  api.listen('tab-load-finished', (event) => {
    if (event.payload?.tabId === store.activeTabId) stopLoading();
  });

  // Native download interception — the file is saved by the engine.
  api.listen('download-started', async (event) => {
    const { url, filename } = event.payload ?? {};
    if (!url) return;
    await api.recordDownload({ url, filename: filename || 'download' }).catch(() => {});
    toast('Download started — see the Downloads page.');
  });

  api.listen('download-finished', async (event) => {
    const { url, path, success } = event.payload ?? {};
    if (!url) return;
    await api.recordDownload({ url, filename: fileNameOf(path) || 'download', destination: path }).catch(() => {});
    if (success) toast('Download finished.');
  });

  // A page asked for a new window: open it as a tab instead.
  api.listen('tab-new-window', async (event) => {
    const url = event.payload?.url;
    if (!url) return;
    await createTab(url);
    await renderAll();
  });
}

function fileNameOf(path) {
  if (!path) return null;
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

// ── Keyboard shortcuts ────────────────────────────────────────────────
function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'k') { e.preventDefault(); actions.palette(); return; }
    if (mod && key === 't') { e.preventDefault(); actions['new-tab'](); return; }
    if (mod && key === 'w') { e.preventDefault(); actions['close-tab'](); return; }
    if (mod && key === 'l') { e.preventDefault(); actions['focus-omnibar'](); return; }
    if (mod && key === 'r') { e.preventDefault(); actions.reload(); return; }
    if (mod && key === 'd') { e.preventDefault(); actions.bookmark(); return; }
    if (mod && key === ',') { e.preventDefault(); actions.settings(); return; }
    if (mod && key === 'j') { e.preventDefault(); actions.downloads(); return; }
    if (mod && key === 'h') { e.preventDefault(); actions.history(); return; }

    // Ctrl/Cmd+1…9 — jump to tab N (9 = last)
    if (mod && /^[1-9]$/.test(key)) {
      e.preventDefault();
      jumpToTab(Number(key));
      return;
    }
    // Ctrl+Tab / Ctrl+Shift+Tab — cycle
    if (mod && key === 'tab') {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }

    if (e.altKey && key === 'arrowleft') { e.preventDefault(); actions.back(); return; }
    if (e.altKey && key === 'arrowright') { e.preventDefault(); actions.forward(); return; }

    if (e.key === 'Escape') {
      if (isPaletteOpen()) return closePalette();
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
    { title: 'New Tab', hint: 'Ctrl T', keywords: ['open', 'create'], run: run(actions['new-tab']) },
    { title: 'Close Current Tab', hint: 'Ctrl W', keywords: ['remove'], run: run(actions['close-tab']) },
    { title: 'Reload Page', hint: 'Ctrl R', keywords: ['refresh'], run: run(actions.reload) },
    { title: 'Go Home', hint: 'Home', keywords: ['start page'], run: run(actions.home) },
    { title: 'Focus Address Bar', hint: 'Ctrl L', keywords: ['omnibar', 'url'], run: run(actions['focus-omnibar']) },
    { title: 'Toggle Bookmark on This Page', hint: 'Ctrl D', keywords: ['star', 'save'], run: run(actions.bookmark) },
    { title: 'Open History', hint: 'govind://history', keywords: ['recent', 'visited'], run: run(actions.history) },
    { title: 'Open Downloads', hint: 'govind://downloads', keywords: ['files'], run: run(actions.downloads) },
    { title: 'Open Bookmarks', hint: 'govind://bookmarks', keywords: ['favorites list'], run: run(actions.bookmarks) },
    { title: 'Open Scratchpad', hint: 'Panel', keywords: ['note', 'notes'], run: run(async () => openPanelWithNav('scratchpad')) },
    { title: 'Open Settings', hint: 'govind://settings', keywords: ['preferences', 'options'], run: run(actions.settings) },
    { title: 'Clear Browsing Data…', hint: 'Privacy', keywords: ['delete', 'privacy', 'erase'], run: run(async () => openInternal('settings:privacy')) },
    { title: 'Toggle Dark / Light Theme', hint: 'Appearance', keywords: ['appearance', 'zen dark', 'color'], run: run(async () => {
        const next = (store.settings.theme === 'zen-dark') ? 'zen-light' : 'zen-dark';
        store.settings.theme = next;
        applyTheme(next);
        await api.setSetting('theme', next);
      }) },
    { title: 'Toggle Sidebar', hint: 'View', keywords: ['collapse', 'hide'], run: run(async () => { toggleSidebar(); await syncNativeViews(); }) },
    { title: 'Move Tab Up', hint: 'Reorder', keywords: ['reorder'], run: run(async () => { if (store.activeTabId) { await reorderTab(store.activeTabId, 'up'); await renderAll(); } }) },
    { title: 'Move Tab Down', hint: 'Reorder', keywords: ['reorder'], run: run(async () => { if (store.activeTabId) { await reorderTab(store.activeTabId, 'down'); await renderAll(); } }) },
    { title: 'Pin / Unpin Current Tab', hint: 'Tabs', keywords: ['pin'], run: run(async () => { if (store.activeTabId) { await togglePinTab(store.activeTabId); await renderAll(); } }) },
  ];
}

boot().catch((err) => {
  console.error('Boot failed:', err);
  toast('Something went wrong while starting Govind. See console for details.');
});
