/** Govind Browser — bootstrap, event wiring and keyboard shortcuts. */

import { $, $$, toast } from './lib/dom.js';
import * as api from './services/ipc.js';
import {
  store, initStore, createTab, createPrivateTab, closeTab, activateTab, togglePinTab, reorderTab,
  navigate, openInternalPage, goHome, goBack, goForward, reloadTab, createWorkspace,
  switchWorkspace, deleteWorkspace, toggleBookmarkCurrent, refreshBookmarks, syncNativeViews,
  refreshTabs, applyTabMeta, internalNavStep, setTabGroup, reopenClosedTab, toggleReaderMode,
  rememberMutedSite, mutedSiteKey,
} from './state/store.js';
import {
  renderAll, renderView, renderToolbar, renderTabs, renderSidebarFavorites,
  startLoading, stopLoading, focusOmnibar, toggleSidebar, updateThemeToggleIcon,
} from './views/shell.js';
import { renderHome, wireHome } from './views/home.js';
import { openPanel, closePanels, isAnyPanelOpen, wirePanels } from './views/panels.js';
import { applyTheme } from './views/settings.js';
import { initPalette, openPalette, closePalette, isPaletteOpen } from './views/palette.js';
import { reloadWebView, historyWebView } from './views/browser.js';
import { initOmnibar } from './views/omnibar.js';
import { isNative } from './services/ipc.js';
import { displayUrl, HOME_URL, schemeOf, hostOf } from './lib/url.js';

const pendingTranslations = new Map();
const pendingSnapshots = new Map();

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

async function openMediaControls() {
  const existing = store.tabs.find((tab) => tab.url === 'govind://media-controls');
  if (existing) {
    await activateTab(existing.id);
  } else {
    await createTab('govind://media-controls');
  }
  await renderAll();
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
  'new-private-tab': async () => {
    if (!isNative()) { toast('Private tabs are available in the installed app, where browsing data can be isolated.'); return; }
    await createPrivateTab();
    await renderAll();
    focusOmnibar();
  },
  'recently-closed': async () => { await openInternal('recently-closed'); },
  'undo-close': async () => {
    const closed = store.closedTabs[0];
    if (!closed) { toast('No recently closed tabs.'); return; }
    const tab = await reopenClosedTab(closed.id);
    if (tab) { await renderAll(); focusOmnibar(); }
  },
  'close-tab': async () => { if (store.activeTabId) { await closeTab(store.activeTabId); await renderAll(); } },
  'palette': async () => { isPaletteOpen() ? closePalette() : await openPalette(); },
  'focus-omnibar': async () => { focusOmnibar(); },
  'reload': async () => {
    store.readerModeTabs.delete(store.activeTabId);
    renderToolbar();
    startLoading();
    reloadWebView();
    await reloadTab();
    setTimeout(stopLoading, 350);
  },
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
  'zoom-reset': async () => { await changeZoomTo(1); },
  'find': async () => { openFindBar(); },
  'reader-mode': async () => {
    if (!isNative()) { toast('Reader mode is available in the installed app.'); return; }
    const enabled = await toggleReaderMode();
    renderToolbar();
    if (enabled) toast('Reader mode on. Toggle it again to return to the page.');
  },
  'read-aloud': async () => {
    const tab = store.activeTab();
    if (!tab || store.isInternalTab(tab)) { toast('Open a website to read aloud.'); return; }
    if (!isNative()) { toast('Read Aloud is available in the installed app.'); return; }
    try {
      await api.readAloudTab(tab.id);
      toast('Read Aloud toggled. Press Alt+Shift+R to stop.');
    } catch (err) {
      toast(`Could not start Read Aloud: ${err?.message ?? err}`);
    }
  },
  'fullscreen': async () => { await toggleFullscreen(); },
  'mute-tab': async () => { await toggleTabMute(store.activeTabId); },
  'force-dark-websites': async () => {
    if (!isNative()) { toast('Website dark mode is available in the installed app.'); return; }
    const enabled = store.settings.force_dark_websites !== 'true';
    store.settings.force_dark_websites = enabled ? 'true' : 'false';
    await api.setSetting('force_dark_websites', store.settings.force_dark_websites);
    await api.setForceDarkWebsites(enabled);
    toast(enabled ? 'Forced dark mode enabled for websites.' : 'Forced dark mode disabled.');
  },
  'translate-page': async () => { await translateActivePage(); },
  'inspect': async () => {
    const tab = store.activeTab();
    if (tab && !store.isInternalTab(tab)) api.inspectTab(tab.id).catch(() => {});
  },
  'print': async () => {
    if (isNative()) api.printTab(store.activeTabId);
    else window.print();
  },
  'tab-search': async () => { await openPalette({ tabsOnly: true }); },
  'task-manager': async () => { await openInternal('task-manager'); },
  'media-controls': async () => { await openMediaControls(); },
  'reading-list': async () => { await openInternal('reading-list'); },
  'save-for-later': async () => { await savePageForLater(); },
  'guest-mode': async () => {
    store.guestMode = !store.guestMode;
    document.body.classList.toggle('guest-mode', store.guestMode);
    toast(store.guestMode
      ? 'Guest mode on — new tabs are private and nothing is saved.'
      : 'Guest mode off.');
  },
  'clear-site-data': async () => {
    const tab = store.activeTab();
    if (!tab || store.isInternalTab(tab)) { toast('Open a website first.'); return; }
    if (!window.confirm(`Forget cookies and site data for ${hostOf(tab.url) ?? 'this site'}? You will be signed out on this site.`)) return;
    try {
      await api.clearSiteData(tab.id);
      toast('Clearing site data…');
    } catch (err) {
      toast(`Could not forget site data: ${err?.message ?? err}`);
    }
  },
  'toggle-sidebar': async () => {
    toggleSidebar();
    await syncNativeViews();
  },
  'toggle-theme': async () => {
    const next = (store.settings.theme === 'zen-dark') ? 'zen-light' : 'zen-dark';
    store.settings.theme = next;
    applyTheme(next);
    await api.setSetting('theme', next);
    updateThemeToggleIcon(next);
    const select = $('#setting-theme');
    if (select) select.value = next;
    toast(next === 'zen-dark' ? 'Dark theme enabled.' : 'Zen paper theme enabled.');
  },
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
  await changeZoomTo(zoomFactor);
}

/** Zoom the active tab and remember the level for the site's domain. */
async function changeZoomTo(factor) {
  zoomFactor = factor;
  const tab = store.activeTab();
  await api.zoomTab(store.activeTabId, zoomFactor).catch(() => {});
  const key = tab && !store.isInternalTab(tab) ? `zoom:${hostOf(tab.url) ?? ''}` : null;
  if (key && hostOf(tab.url)) {
    store.settings[key] = String(zoomFactor);
    api.setSetting(key, String(zoomFactor)).catch(() => {});
  }
  if (factor !== 1) toast(`Zoom: ${Math.round(factor * 100)}%`);
}

/** Re-apply the saved zoom of a site when one of its pages loads. */
function applySavedZoom(tabId, url) {
  if (!url || url.startsWith('govind://')) return;
  const saved = parseFloat(store.settings[`zoom:${hostOf(url)}`] ?? '');
  if (!Number.isNaN(saved) && saved !== 1) api.zoomTab(tabId, saved).catch(() => {});
}

// ── Find in page (Ctrl+F) ─────────────────────────────────────────────
function openFindBar() {
  const bar = $('#find-bar');
  if (!bar) return;
  bar.classList.remove('hidden');
  setFindCount(0, 0);
  // The native webview would cover the bar, so the web region shrinks while
  // the bar is open (webRegion() measures it — see state/store.js).
  syncNativeViews();
  $('#find-input')?.focus();
  $('#find-input').select();
}

function closeFindBar() {
  const bar = $('#find-bar');
  if (!bar || bar.classList.contains('hidden')) return;
  bar.classList.add('hidden');
  setFindCount(0, 0);
  api.findInTab(store.activeTabId, '', true).catch(() => {});
  syncNativeViews();
}

/**
 * Match readout for the find bar. The page script reports `index`/`total` over
 * WebView2's message channel, so this stays empty on engines without it
 * instead of showing a wrong number.
 */
function setFindCount(index, total) {
  const label = $('#find-count');
  if (!label) return;
  label.textContent = total ? `${index} / ${total}` : '';
}

function wireFindBar() {
  const input = $('#find-input');
  if (!input) return;
  const run = (forward) => api.findInTab(store.activeTabId, input.value, forward).catch(() => {});
  $('#find-next')?.addEventListener('click', () => run(true));
  $('#find-prev')?.addEventListener('click', () => run(false));
  $('#find-close')?.addEventListener('click', closeFindBar);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(!e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
  });
  input.addEventListener('input', () => {
    if (!input.value) setFindCount(0, 0);
  });
}

// ── Fullscreen (F11): window fullscreen + immersive chrome ────────────
async function toggleFullscreen() {
  const on = !(await api.isFullscreen());
  await api.setFullscreen(on).catch(() => {});
  document.body.classList.toggle('immersive', on);
  await syncNativeViews();
  if (on) toast('Press F11 or Esc to leave fullscreen.');
}

async function toggleTabMute(tabId) {
  const tab = store.tabs.find((item) => item.id === tabId);
  if (!tab || store.isInternalTab(tab)) return;
  if (!isNative()) { toast('Tab audio controls are available in the installed app.'); return; }
  const muted = !store.mutedTabs.has(tabId);
  await api.setTabMuted(tabId, muted);
  if (muted) store.mutedTabs.add(tabId);
  else store.mutedTabs.delete(tabId);
  const state = store.audioStates.get(tabId) ?? { playing: false, muted };
  store.audioStates.set(tabId, { ...state, muted });
  // Remember the choice per site so the next visit starts muted too.
  await rememberMutedSite(hostOf(tab.url), muted);
  renderTabs();
}

async function translateActivePage() {
  const tab = store.activeTab();
  if (!tab || store.isInternalTab(tab)) { toast('Open a website to translate.'); return; }
  if (!isNative()) { toast('Page translation is available in the installed app.'); return; }
  if (store.readerModeTabs.has(tab.id)) { toast('Turn off Reader mode before translating.'); return; }

  if (store.translatedTabs.has(tab.id)) {
    await api.restoreTranslatedPage(tab.id);
    store.translatedTabs.delete(tab.id);
    return;
  }

  const endpoint = String(store.settings.translation_endpoint ?? '').trim().replace(/\/+$/, '');
  if (!endpoint) {
    toast('Set a LibreTranslate server in Settings → Translation first.');
    await openInternal('settings:translation');
    return;
  }
  const target = window.prompt('Translate to language code (for example, en or fr):', 'en')?.trim();
  if (!target) return;
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(target)) {
    toast('Enter a language code such as en, fr, or pt-BR.');
    return;
  }
  const endpointUrl = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpointUrl.hostname);
  if (!local && !window.confirm(`Send this page's text to ${endpointUrl.origin} for translation?`)) return;

  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  pendingTranslations.set(requestId, { tabId: tab.id, target, endpoint, url: tab.url });
  try {
    await api.requestPageTranslation(tab.id, requestId);
    toast('Requesting page text for translation…');
  } catch (err) {
    pendingTranslations.delete(requestId);
    toast(`Could not read this page: ${err?.message ?? err}`);
  }
}

/** Save the active page to the reading list, with an offline text snapshot. */
async function savePageForLater() {
  const tab = store.activeTab();
  if (!tab || store.isInternalTab(tab) || tab.url === 'govind://home') {
    toast('Open a web page to save it for later.');
    return;
  }
  if (!isNative()) {
    await api.saveReadingItem({ url: tab.url, title: tab.title });
    toast('Saved to your reading list.');
    return;
  }
  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  pendingSnapshots.set(requestId, { tabId: tab.id, url: tab.url, title: tab.title });
  try {
    await api.requestPageSnapshot(tab.id, requestId);
    toast('Capturing page for your reading list…');
  } catch {
    // Snapshot unavailable — save without the offline copy.
    pendingSnapshots.delete(requestId);
    await api.saveReadingItem({ url: tab.url, title: tab.title }).catch(() => {});
    toast('Saved to your reading list (no offline copy).');
  }
}

async function handleSnapshotData(payload) {
  let page;
  try {
    page = JSON.parse(decodeURIComponent(payload?.data ?? ''));
  } catch { return; }
  const pending = pendingSnapshots.get(page.requestId);
  if (!pending || pending.tabId !== payload?.tabId) return;
  pendingSnapshots.delete(page.requestId);
  await api.saveReadingItem({
    url: page.url || pending.url,
    title: page.title || pending.title,
    snapshotText: page.text,
  }).catch((err) => toast(`Could not save: ${err?.message ?? err}`));
  toast('Saved to your reading list, with an offline copy.');
}

async function handleTranslationData(payload) {
  let page;
  try {
    page = JSON.parse(decodeURIComponent(payload?.data ?? ''));
  } catch {
    return;
  }
  const request = pendingTranslations.get(page.requestId);
  if (!request || request.tabId !== payload?.tabId) return;
  pendingTranslations.delete(page.requestId);
  if (page.url !== request.url || typeof page.text !== 'string' || !page.text.trim()) {
    if (store.activeTabId === request.tabId) toast('Could not read text from this page.');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${request.endpoint}/translate`, {
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: page.text, source: 'auto', target: request.target, format: 'text' }),
    });
    if (!response.ok) throw new Error(`translation server returned HTTP ${response.status}`);
    const result = await response.json();
    if (typeof result.translatedText !== 'string' || !result.translatedText.trim()) {
      throw new Error('translation server returned no translated text');
    }
    await api.showTranslatedPage(request.tabId, page.url, page.title, result.translatedText);
    store.translatedTabs.add(request.tabId);
    if (store.activeTabId === request.tabId) toast('Page translated. Use Translate / show original to restore it.');
  } catch (err) {
    console.error('Page translation failed:', err);
    if (store.activeTabId === request.tabId) toast(`Translation failed: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ── Tab context menu (right-click) ────────────────────────────────────
function wireTabContextMenu() {
  const menu = $('#tab-menu');
  const list = $('#tab-list');
  if (!menu || !list) return;
  let ctxTabId = null;

  list.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('[data-tab]');
    if (!item) return;
    e.preventDefault();
    ctxTabId = item.getAttribute('data-tab');
    const muteItem = $('#tab-menu-mute');
    if (muteItem) muteItem.firstChild.textContent = `${store.mutedTabs.has(ctxTabId) ? 'Unmute' : 'Mute'} tab `;
    menu.classList.remove('hidden');
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - 240)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
  });

  menu.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-tab-action]')?.getAttribute('data-tab-action');
    if (!action || !ctxTabId) return;
    menu.classList.add('hidden');
    const tab = store.tabs.find((t) => t.id === ctxTabId);
    try {
      if (action === 'reload') {
        if (tab && !store.isInternalTab(tab)) api.reloadTab(tab.id);
      } else if (action === 'duplicate') {
        const dup = tab?.is_private
          ? await createPrivateTab(tab.url)
          : await api.duplicateTab(ctxTabId);
        await activateTab(dup.id);
        await renderAll();
      } else if (action === 'open-private') {
        if (!isNative()) {
          toast('Private tabs are available in the installed app, where browsing data can be isolated.');
          return;
        }
        const privateTab = await createPrivateTab(tab?.url ?? HOME_URL);
        if (privateTab) {
          await activateTab(privateTab.id);
          await renderAll();
        }
      } else if (action === 'pin') {
        await togglePinTab(ctxTabId);
        await renderAll();
      } else if (action === 'mute') {
        await toggleTabMute(ctxTabId);
      } else if (action === 'group') {
        const name = window.prompt('Tab group name', tab?.group_name ?? '');
        if (name?.trim()) {
          await setTabGroup(ctxTabId, name);
          await renderAll();
        }
      } else if (action === 'ungroup') {
        await setTabGroup(ctxTabId, null);
        await renderAll();
      } else if (action === 'close') {
        await closeTab(ctxTabId);
        await renderAll();
      } else if (action === 'close-unpinned') {
        await closeUnpinnedTabs(ctxTabId);
        await renderAll();
      } else if (action === 'close-others') {
        await closeTabsAround(ctxTabId, 'others');
        store.activeTabId = ctxTabId;
        await syncNativeViews();
        await renderAll();
      } else if (action === 'close-right') {
        await closeTabsAround(ctxTabId, 'right');
        await renderAll();
      } else if (action === 'inspect') {
        actions.inspect();
      }
    } catch (err) {
      toast(`Couldn't ${action}: ${err?.message ?? err}`);
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#tab-menu')) menu.classList.add('hidden');
  });
}

async function closeTabsAround(tabId, scope) {
  const workspaceId = store.tabs.find((tab) => tab.id === tabId)?.workspace_id;
  const ordered = store.tabs
    .filter((tab) => tab.workspace_id === workspaceId)
    .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || a.sort_order - b.sort_order);
  const index = ordered.findIndex((tab) => tab.id === tabId);
  const targets = scope === 'right'
    ? ordered.slice(index + 1)
    : ordered.filter((tab) => tab.id !== tabId);
  for (const tab of targets) await closeTab(tab.id);
  await refreshTabs();
  store.activeTabId = tabId;
  await syncNativeViews();
}

async function closeUnpinnedTabs(tabId) {
  const contextTab = store.tabs.find((tab) => tab.id === tabId);
  if (!contextTab) return;
  const pinned = store.tabs.filter((tab) => tab.is_pinned);
  const keepId = pinned[0]?.id ?? tabId;
  const targets = store.tabs.filter((tab) => !tab.is_pinned && tab.id !== keepId);
  for (const tab of targets) await closeTab(tab.id);
  await refreshTabs();
  if (store.tabs.some((tab) => tab.id === keepId)) await activateTab(keepId);
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
  if (isNative()) {
    await api.setForceDarkWebsites(store.settings.force_dark_websites === 'true');
    // Push saved page-feature settings into the engine (applies to all tabs).
    api.setSpellcheck(store.settings.spellcheck !== 'false').catch(() => {});
    api.setDoNotTrack(store.settings.do_not_track === 'true').catch(() => {});
    api.setContentBlocking(store.settings.content_blocking === 'true' ? (store.settings.cosmetic_filters ?? '') : '').catch(() => {});
    api.setAutofillProfiles(store.settings.autofill_profiles ?? '[]').catch(() => {});
  }

  // Wire everything before first paint of dynamic regions
  wireTitlebar();
  wireToolbar();
  wireSidebar();
  wireHome({ onNavigate: doNavigate, onOpenPanel: openPanelWithNav });
  wirePanels();
  wireMenuAndPopover();
  wireFindBar();
  wireTabContextMenu();
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
  $('#btn-sidebar-toggle')?.addEventListener('click', async () => {
    toggleSidebar();
    await syncNativeViews();
  });
  $('#sidebar-backdrop')?.addEventListener('click', async () => {
    $('#sidebar')?.classList.remove('mobile-open');
    $('#sidebar-backdrop')?.classList.add('hidden');
    $('#btn-sidebar-toggle')?.setAttribute('aria-expanded', 'false');
    await syncNativeViews();
  });
  $('#btn-back')?.addEventListener('click', () => actions.back());
  $('#btn-forward')?.addEventListener('click', () => actions.forward());
  $('#btn-reload')?.addEventListener('click', () => actions.reload());
  $('#btn-home')?.addEventListener('click', () => actions.home());
  $('#btn-reader-mode')?.addEventListener('click', () => actions['reader-mode']());
  $('#btn-read-aloud')?.addEventListener('click', () => actions['read-aloud']());
  $('#btn-media-controls')?.addEventListener('click', () => actions['media-controls']());

  initOmnibar({ onNavigate: doNavigate });

  $('#bookmark-toggle')?.addEventListener('click', openActiveBookmarkToggle);

  $('#security-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSecurityPopover();
  });

  $('#btn-theme-toggle')?.addEventListener('click', () => actions['toggle-theme']());
  $('#btn-more')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!api.isNative()) return toggleMenu();
    const rect = e.currentTarget.getBoundingClientRect();
    api.showMoreMenu(rect.right, rect.bottom).catch((error) => {
      console.error('could not open browser menu', error);
      toast('Could not open browser menu.');
    });
  });
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
  $('#menu-new-private-tab')?.addEventListener('click', () => { toggleMenu(false); actions['new-private-tab'](); });
  $('#menu-recently-closed')?.addEventListener('click', () => { toggleMenu(false); actions['recently-closed'](); });
  $('#menu-history')?.addEventListener('click', () => { toggleMenu(false); actions.history(); });
  $('#menu-downloads')?.addEventListener('click', () => { toggleMenu(false); actions.downloads(); });
  $('#menu-bookmarks')?.addEventListener('click', () => { toggleMenu(false); actions.bookmarks(); });
  $('#menu-reading-list')?.addEventListener('click', () => { toggleMenu(false); actions['reading-list'](); });
  $('#menu-save-for-later')?.addEventListener('click', () => { toggleMenu(false); actions['save-for-later'](); });
  $('#menu-task-manager')?.addEventListener('click', () => { toggleMenu(false); actions['task-manager'](); });
  $('#menu-guest-mode')?.addEventListener('click', () => { toggleMenu(false); actions['guest-mode'](); });
  $('#menu-clear-site-data')?.addEventListener('click', () => { toggleMenu(false); actions['clear-site-data'](); });
  $('#security-clear-data')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#security-popover')?.classList.add('hidden');
    actions['clear-site-data']();
  });
  $('#menu-zoom-in')?.addEventListener('click', () => { toggleMenu(false); actions['zoom-in'](); });
  $('#menu-zoom-out')?.addEventListener('click', () => { toggleMenu(false); actions['zoom-out'](); });
  $('#menu-zoom-reset')?.addEventListener('click', () => { toggleMenu(false); actions['zoom-reset'](); });
  $('#menu-mute-active-tab')?.addEventListener('click', () => { toggleMenu(false); actions['mute-tab'](); });
  $('#menu-force-dark-websites')?.addEventListener('click', () => { toggleMenu(false); actions['force-dark-websites'](); });
  $('#menu-translate-page')?.addEventListener('click', () => { toggleMenu(false); actions['translate-page'](); });
  $('#menu-read-aloud')?.addEventListener('click', () => { toggleMenu(false); actions['read-aloud'](); });
  $('#menu-fullscreen')?.addEventListener('click', () => { toggleMenu(false); actions.fullscreen(); });
  $('#menu-print')?.addEventListener('click', () => { toggleMenu(false); actions.print(); });
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
  $('#sidebar')?.addEventListener('click', async (e) => {
    if (!window.matchMedia('(max-width: 700px)').matches || !e.target.closest('button')) return;
    $('#sidebar')?.classList.remove('mobile-open');
    $('#sidebar-backdrop')?.classList.add('hidden');
    $('#btn-sidebar-toggle')?.setAttribute('aria-expanded', 'false');
    await syncNativeViews();
  });
  $('#btn-new-tab')?.addEventListener('click', () => actions['new-tab']());
  $('#btn-new-private-tab')?.addEventListener('click', () => actions['new-private-tab']());
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
    const groupKey = e.target.closest('[data-toggle-tab-group]')?.getAttribute('data-toggle-tab-group');
    if (groupKey) {
      e.stopPropagation();
      if (store.collapsedTabGroups.has(groupKey)) store.collapsedTabGroups.delete(groupKey);
      else store.collapsedTabGroups.add(groupKey);
      renderTabs();
      return;
    }
    const muteId = e.target.closest('[data-mute-tab]')?.getAttribute('data-mute-tab');
    if (muteId) { e.stopPropagation(); await toggleTabMute(muteId); return; }
    const closeId = e.target.closest('[data-close-tab]')?.getAttribute('data-close-tab');
    if (closeId) { e.stopPropagation(); await closeTab(closeId); await renderAll(); return; }
    const pinId = e.target.closest('[data-pin-tab]')?.getAttribute('data-pin-tab');
    if (pinId) { e.stopPropagation(); await togglePinTab(pinId); await renderAll(); return; }
    const tabId = e.target.closest('[data-tab]')?.getAttribute('data-tab');
    if (tabId && tabId !== store.activeTabId) { await activateTab(tabId); await renderAll(); }
  });
  $('#tab-list')?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' && e.key !== 'Delete') return;
    if (e.target.closest('[data-mute-tab]')) return;
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
  document.addEventListener('govind:browser-data-restored', async () => {
    store.workspaces = await api.listWorkspaces();
    store.settings = await api.getSettings();
    if (!store.workspaces.some((workspace) => workspace.id === store.activeWorkspaceId)) {
      store.activeWorkspaceId =
        store.workspaces.find((workspace) => workspace.id === store.settings.active_workspace_id)?.id
        ?? store.workspaces[0]?.id
        ?? null;
    }
    applyTheme(store.settings.theme);
    updateThemeToggleIcon(store.settings.theme);
    if (isNative()) {
      await api.setForceDarkWebsites(store.settings.force_dark_websites === 'true');
      api.setSpellcheck(store.settings.spellcheck !== 'false').catch(() => {});
      api.setDoNotTrack(store.settings.do_not_track === 'true').catch(() => {});
      api.setContentBlocking(store.settings.content_blocking === 'true' ? (store.settings.cosmetic_filters ?? '') : '').catch(() => {});
      api.setAutofillProfiles(store.settings.autofill_profiles ?? '[]').catch(() => {});
    }
    await refreshTabs();
    await refreshBookmarks();
    if (!store.tabs.some((tab) => tab.id === store.activeTabId)) {
      store.activeTabId = store.tabs[0]?.id ?? null;
    }
    if (store.activeTabId) await activateTab(store.activeTabId);
    await renderAll();
    await syncNativeViews();
  });
  document.addEventListener('govind:mute-tab', (e) => toggleTabMute(e.detail));
  document.addEventListener('govind:close-tab', async (e) => { await closeTab(e.detail); await renderAll(); });
  document.addEventListener('govind:render', async () => { await renderAll(); });
  document.addEventListener('govind:history-changed', async () => {
    if (!$('#view-home')?.classList.contains('hidden')) await renderHome();
  });
  // Broken favicon images (site changed its icon): drop them silently.
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (el instanceof HTMLImageElement && el.classList.contains('tab-favicon-img')) el.remove();
  }, true);

  // Keep native webviews aligned with the layout
  const sidebar = $('#sidebar');
  sidebar?.addEventListener('transitionend', (event) => {
    if (event.target === sidebar && event.propertyName === 'width') syncNativeViews();
  });
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
  api.listen('more-menu-action', (event) => {
    const item = document.getElementById(String(event.payload ?? ''));
    if (item?.parentElement?.id === 'more-menu') item.click();
  });

  // The page navigated (link click, redirect, …).
  api.listen('tab-url-changed', async (event) => {
    const { tabId, url } = event.payload ?? {};
    if (!tabId || !url) return;
    const isPrivate = store.privateTabs.some((tab) => tab.id === tabId);
    store.readerModeTabs.delete(tabId);
    store.translatedTabs.delete(tabId);
    store.audioStates.set(tabId, { playing: false, muted: store.mutedTabs.has(tabId) });
    for (const [requestId, request] of pendingTranslations) {
      if (request.tabId === tabId) pendingTranslations.delete(requestId);
    }
    applyTabMeta(tabId, { url, favicon_url: null });
    applySavedZoom(tabId, url);
    // A site muted in an earlier session stays muted on its next visit.
    const host = mutedSiteKey(hostOf(url));
    if (!isPrivate && host && store.mutedSites.has(host) && !store.mutedTabs.has(tabId)) {
      api.setTabMuted(tabId, true).catch(() => {});
      store.mutedTabs.add(tabId);
      const audio = store.audioStates.get(tabId) ?? { playing: false };
      store.audioStates.set(tabId, { ...audio, muted: true });
      renderTabs();
    }
    if (!isPrivate) await api.updateTabMeta(tabId, { url, faviconUrl: '' }).catch(() => {});
    if (tabId === store.activeTabId) {
      renderToolbar();
      if (!isPrivate) {
        const title = store.tabs.find((t) => t.id === tabId)?.title;
        api.addHistoryEntry(url, title || url).catch(() => {});
      }
    }
    renderTabs();
  });

  // The page reported its real title.
  api.listen('tab-title-changed', async (event) => {
    const { tabId, title } = event.payload ?? {};
    if (!tabId || !title) return;
    const isPrivate = store.privateTabs.some((tab) => tab.id === tabId);
    applyTabMeta(tabId, { title });
    if (!isPrivate) await api.updateTabMeta(tabId, { title }).catch(() => {});
    renderTabs();
    if (tabId === store.activeTabId) renderToolbar();
    if (store.view === 'internal' && store.internalPage === 'media-controls') renderAll();
  });

  // The page's favicon (probed by the engine after each page load).
  api.listen('tab-favicon-changed', async (event) => {
    const { tabId, faviconUrl } = event.payload ?? {};
    // Only real icons: sites like example.com ship `href="data:,"` placeholders.
    const ok = /^https?:\/\//i.test(faviconUrl ?? '') || /^data:image\//i.test(faviconUrl ?? '');
    if (!tabId || !ok) return;
    const isPrivate = store.privateTabs.some((tab) => tab.id === tabId);
    applyTabMeta(tabId, { favicon_url: faviconUrl });
    if (!isPrivate) await api.updateTabMeta(tabId, { faviconUrl }).catch(() => {});
    renderTabs();
  });

  api.listen('tab-load-started', (event) => {
    if (event.payload?.tabId === store.activeTabId) startLoading();
  });
  api.listen('tab-load-finished', (event) => {
    if (event.payload?.tabId === store.activeTabId) stopLoading();
  });

  api.listen('tab-audio-state', (event) => {
    const { tabId, playing, muted, hasMedia, mediaPlaying } = event.payload ?? {};
    if (!tabId) return;
    store.audioStates.set(tabId, {
      playing: !!playing,
      muted: !!muted,
      hasMedia: !!hasMedia,
      mediaPlaying: !!mediaPlaying,
    });
    if (muted) store.mutedTabs.add(tabId);
    else store.mutedTabs.delete(tabId);
    renderTabs();
    if (store.view === 'internal' && store.internalPage === 'media-controls') renderAll();
  });
  api.listen('tab-find-count', (event) => {
    const { tabId, index, total } = event.payload ?? {};
    if (tabId && tabId !== store.activeTabId) return;
    if ($('#find-bar')?.classList.contains('hidden')) return;
    setFindCount(Number(index) || 0, Number(total) || 0);
  });
  api.listen('tab-translation-data', (event) => handleTranslationData(event.payload));
  api.listen('tab-snapshot-data', (event) => handleSnapshotData(event.payload));
  api.listen('tab-feature-notice', (event) => {
    if (event.payload?.tabId === store.activeTabId ||
      String(event.payload?.message ?? '').startsWith('This site blocked playback.')) {
      toast(event.payload.message);
    }
  });

  // Safe browsing: the engine blocked a navigation to a listed site.
  api.listen('tab-unsafe-navigation', async (event) => {
    const { tabId, url, reason } = event.payload ?? {};
    if (!tabId || !url || tabId !== store.activeTabId) return;
    store.pendingUnsafeUrl = url;
    store.pendingUnsafeReason = reason ?? '';
    await openInternal('unsafe');
  });

  // Native download interception — the file is saved by the engine.
  api.listen('download-started', async (event) => {
    const { url, filename, isPrivate } = event.payload ?? {};
    if (!url || isPrivate) return;
    await api.recordDownload({ url, filename: filename || 'download' }).catch(() => {});
    toast('Download started — see the Downloads page.');
  });

  api.listen('download-finished', async (event) => {
    const { url, path, success, isPrivate } = event.payload ?? {};
    if (!url || isPrivate) return;
    await api.recordDownload({ url, filename: fileNameOf(path) || 'download', destination: path }).catch(() => {});
    if (success) toast('Download finished.');
  });

  // A page asked for a new window: open it as a tab instead.
  api.listen('tab-new-window', async (event) => {
    const { url, isPrivate } = event.payload ?? {};
    if (!url) return;
    if (isPrivate) await createPrivateTab(url);
    else await createTab(url);
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
    if (mod && key === 'b') { e.preventDefault(); actions['toggle-sidebar'](); return; }
    if (mod && e.shiftKey && key === 't') { e.preventDefault(); actions['undo-close'](); return; }
    if (mod && key === 't') { e.preventDefault(); actions['new-tab'](); return; }
    if (mod && e.shiftKey && key === 'n') { e.preventDefault(); actions['new-private-tab'](); return; }
    if (mod && key === 'w') { e.preventDefault(); actions['close-tab'](); return; }
    if (mod && key === 'l') { e.preventDefault(); actions['focus-omnibar'](); return; }
    if (mod && key === 'r') { e.preventDefault(); actions.reload(); return; }
    if (mod && key === 'd') { e.preventDefault(); actions.bookmark(); return; }
    if (mod && key === ',') { e.preventDefault(); actions.settings(); return; }
    if (mod && key === 'j') { e.preventDefault(); actions.downloads(); return; }
    if (mod && key === 'h') { e.preventDefault(); actions.history(); return; }
    if (mod && key === 'f') { e.preventDefault(); actions.find(); return; }
    if (mod && key === 'p') { e.preventDefault(); actions.print(); return; }
    if (mod && e.shiftKey && key === 'a') { e.preventDefault(); actions['tab-search'](); return; }
    if (e.altKey && e.shiftKey && key === 'm') { e.preventDefault(); actions['mute-tab'](); return; }
    if (e.altKey && e.shiftKey && key === 'd') { e.preventDefault(); actions['force-dark-websites'](); return; }
    if (e.altKey && e.shiftKey && key === 't') { e.preventDefault(); actions['translate-page'](); return; }
    if (e.altKey && e.shiftKey && key === 'r') { e.preventDefault(); actions['read-aloud'](); return; }
    if (e.altKey && e.shiftKey && key === 'p') {
      e.preventDefault();
      toast('Hover a video and click PiP, or press Alt+Shift+P while the page is focused.');
      return;
    }
    if (key === 'f11') { e.preventDefault(); actions.fullscreen(); return; }

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
      if (!$('#find-bar')?.classList.contains('hidden')) return closeFindBar();
      if (document.body.classList.contains('immersive')) { actions.fullscreen(); return; }
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
    { title: 'New Private Tab', hint: 'Ctrl Shift N', keywords: ['incognito', 'private'], run: run(actions['new-private-tab']) },
    { title: 'Recently Closed Tabs', hint: 'History', keywords: ['undo', 'reopen'], run: run(actions['recently-closed']) },
    { title: 'Reopen Closed Tab', hint: 'Ctrl Shift T', keywords: ['undo', 'restore'], run: run(actions['undo-close']) },
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
    { title: 'Duplicate Current Tab', hint: 'Tabs', keywords: ['copy', 'clone'], run: run(async () => { if (store.activeTabId) { const dup = await api.duplicateTab(store.activeTabId); await activateTab(dup.id); await renderAll(); } }) },
    { title: 'Find in Page', hint: 'Ctrl F', keywords: ['search text', 'locate'], run: run(actions.find) },
    { title: 'Toggle Reader Mode', hint: 'Reading', keywords: ['article', 'readability'], run: run(actions['reader-mode']) },
    { title: 'Read Aloud / Stop', hint: 'Alt Shift R', keywords: ['speech', 'text to speech', 'accessibility'], run: run(actions['read-aloud']) },
    { title: 'Mute / unmute active tab', hint: 'Alt Shift M', keywords: ['audio', 'sound'], run: run(actions['mute-tab']) },
    { title: 'Toggle forced dark websites', hint: 'Alt Shift D', keywords: ['dark mode', 'appearance'], run: run(actions['force-dark-websites']) },
    { title: 'Translate / show original page', hint: 'Alt Shift T', keywords: ['language', 'LibreTranslate'], run: run(actions['translate-page']) },
    { title: 'Picture-in-Picture on video', hint: 'Alt Shift P', keywords: ['pip', 'floating video'], run: run(async () => toast('Hover a video and click PiP, or press Alt+Shift+P while the page is focused.')) },
    { title: 'Toggle Fullscreen', hint: 'F11', keywords: ['immersive', 'maximize'], run: run(actions.fullscreen) },
    { title: 'Inspect Page (DevTools)', hint: 'Engine', keywords: ['developer', 'console', 'debug'], run: run(actions.inspect) },
    { title: 'Search Tabs', hint: 'Ctrl Shift A', keywords: ['switch', 'tab search', 'quick'], run: run(actions['tab-search']) },
    { title: 'Print / Save as PDF', hint: 'Ctrl P', keywords: ['print', 'pdf', 'paper'], run: run(actions.print) },
    { title: 'Save Page for Later', hint: 'Reading list', keywords: ['read later', 'offline', 'article'], run: run(actions['save-for-later']) },
    { title: 'Open Reading List', hint: 'govind://reading-list', keywords: ['read later', 'articles'], run: run(actions['reading-list']) },
    { title: 'Task Manager', hint: 'govind://task-manager', keywords: ['tabs', 'memory', 'audio'], run: run(actions['task-manager']) },
    { title: 'Toggle Guest Mode', hint: 'Private', keywords: ['guest', 'private', 'incognito'], run: run(actions['guest-mode']) },
    { title: 'Forget This Site…', hint: 'Cookies & storage', keywords: ['shred', 'forgetful browsing', 'cookies', 'storage', 'sign out'], run: run(actions['clear-site-data']) },
  ];
}

boot().catch((err) => {
  console.error('Boot failed:', err);
  toast('Something went wrong while starting Govind. See console for details.');
});
