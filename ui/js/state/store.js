/**
 * Govind Browser — central application state & actions (no framework).
 * Views import { store } and read state; every mutating action returns
 * updated data and the caller re-renders (see views/shell.js#renderAll).
 */

import * as api from '../services/ipc.js';
import { normalizeInput, HOME_URL } from '../lib/url.js';

export const store = {
  ready: false,
  workspaces: [],
  activeWorkspaceId: null,
  tabs: [],            // tabs of the active workspace
  activeTabId: null,
  bookmarks: [],
  settings: {},

  /** Which view is visible: 'home' | 'web' | 'internal' */
  view: 'home',

  /** Internal page shown when view === 'internal' (history, downloads, …). */
  internalPage: null,

  /** Settings category shown on the settings page. */
  settingsCategory: 'general',

  activeTab() {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  },
  activeWorkspace() {
    return this.workspaces.find((w) => w.id === this.activeWorkspaceId) ?? null;
  },
  isHomeTab(tab) {
    return !tab || tab.url === HOME_URL;
  },
  isInternalTab(tab) {
    return !!tab && tab.url.startsWith('govind://');
  },
};

/** Which shell view a tab URL belongs to. */
export function viewForUrl(url) {
  if (!url || url === HOME_URL) return 'home';
  if (url.startsWith('govind://')) return 'internal';
  return 'web';
}

/** The internal page a URL points at (null for the start page / web pages). */
export function internalPageForUrl(url) {
  if (!url || !url.startsWith('govind://')) return null;
  const route = url.slice('govind://'.length).replace(/\/+$/, '').toLowerCase();
  return route === 'home' || route === '' ? null : route;
}

/** Point the shell at the tab's current URL. */
function applyViewForTab(tab) {
  store.view = viewForUrl(tab?.url);
  const page = internalPageForUrl(tab?.url);
  if (page) store.internalPage = page;
  return store.view;
}

// ── Per-tab navigation history for internal pages ─────────────────────
const internalNav = new Map(); // tabId → { stack: string[], index: number }

function pushInternalNav(tabId, url) {
  const nav = internalNav.get(tabId) ?? { stack: [], index: -1 };
  nav.stack = nav.stack.slice(0, nav.index + 1);
  nav.stack.push(url);
  nav.index = nav.stack.length - 1;
  internalNav.set(tabId, nav);
}

export function internalNavStep(tabId, delta) {
  const nav = internalNav.get(tabId);
  if (!nav) return null;
  const next = nav.index + delta;
  if (next < 0 || next >= nav.stack.length) return null;
  nav.index = next;
  return nav.stack[next];
}

// ── Bootstrap ─────────────────────────────────────────────────────────
export async function initStore() {
  store.settings = await api.getSettings();
  store.workspaces = await api.listWorkspaces();

  // Active workspace comes from persisted settings; fall back to first.
  const persisted = store.settings.active_workspace_id;
  store.activeWorkspaceId =
    store.workspaces.find((w) => w.id === persisted)?.id ?? store.workspaces[0]?.id ?? null;

  await refreshTabs();
  // Milestone behavior: never destructively wipe tabs on launch. If no tabs
  // exist (first run), open a home tab. (restore_session governs intent;
  // see README notes on the non-destructive interpretation.)
  if (store.tabs.length === 0 && store.activeWorkspaceId) {
    const tab = await api.createTab({ workspaceId: store.activeWorkspaceId, url: HOME_URL });
    store.tabs = [tab];
    store.activeTabId = tab.id;
  }
  store.activeTabId =
    store.tabs.find((t) => t.id === store.activeTabId)?.id ??
    [...store.tabs].sort((a, b) => b.last_active_at - a.last_active_at)[0]?.id ??
    null;

  if (store.activeTabId) await api.activateTab(store.activeTabId);
  await refreshBookmarks();
  applyViewForTab(store.activeTab());
  store.ready = true;
}

export async function refreshTabs() {
  if (!store.activeWorkspaceId) { store.tabs = []; return; }
  store.tabs = await api.listTabs({ workspaceId: store.activeWorkspaceId });
}

export async function refreshBookmarks() {
  store.bookmarks = await api.listBookmarks();
}

// ── Tabs ──────────────────────────────────────────────────────────────
export async function createTab(url = HOME_URL) {
  const tab = await api.createTab({ workspaceId: store.activeWorkspaceId, url });
  await refreshTabs();
  store.activeTabId = tab.id;
  if (tab.url.startsWith('govind://')) pushInternalNav(tab.id, tab.url);
  applyViewForTab(tab);
  await syncNativeViews();
  return tab;
}

export async function closeTab(tabId) {
  const result = await api.closeTab(tabId);
  internalNav.delete(tabId);
  await refreshTabs();
  store.activeTabId = result.active_tab_id ?? store.tabs[0]?.id ?? null;
  applyViewForTab(store.activeTab());
  await syncNativeViews();
  return result;
}

export async function activateTab(tabId) {
  await api.activateTab(tabId);
  store.activeTabId = tabId;
  await refreshTabs();
  applyViewForTab(store.activeTab());
  await syncNativeViews();
  return store.activeTab();
}

export async function togglePinTab(tabId) {
  const tab = await api.togglePinTab(tabId);
  await refreshTabs();
  return tab;
}

export async function reorderTab(tabId, direction) {
  store.tabs = await api.reorderTab(tabId, direction);
  return store.tabs;
}

/**
 * Navigate the active tab from raw omnibar/home input.
 * Returns { tab, nav } where nav is the normalizeInput result.
 */
export async function navigate(rawInput) {
  const nav = normalizeInput(rawInput, {
    searchEngine: store.settings.search_engine,
    httpsFirst: store.settings.https_first !== 'false',
  });
  if (!nav) return null;

  const tabId = store.activeTabId;
  if (!tabId) return null;

  const tab = await api.navigateTab(tabId, nav.url);

  if (nav.url.startsWith('govind://')) {
    pushInternalNav(tabId, nav.url);
  } else if (nav.url !== HOME_URL && !nav.url.startsWith('about:')) {
    api.addHistoryEntry(nav.url, nav.url).catch(() => {});
  }

  await refreshTabs();
  applyViewForTab(store.activeTab());
  await syncNativeViews();
  return { tab: store.activeTab(), nav };
}

/** Open one of the internal pages (history, downloads, settings, bookmarks). */
export async function openInternalPage(page) {
  const route = String(page ?? '').split(':')[0];
  const known = ['home', 'history', 'downloads', 'bookmarks', 'settings'];
  if (!known.includes(route)) return null;
  if (route === 'settings') {
    const category = String(page).split(':')[1];
    if (category) store.settingsCategory = category;
  }
  return navigate(`govind://${route}`);
}

export async function goHome() {
  if (!store.activeTabId) return;
  await api.navigateTab(store.activeTabId, HOME_URL);
  await refreshTabs();
  applyViewForTab(store.activeTab());
  await syncNativeViews();
}

export async function goBack() { return api.goBack(store.activeTabId); }
export async function goForward() { return api.goForward(store.activeTabId); }
export async function reloadTab() { return api.reloadTab(store.activeTabId); }

// ── Workspaces ────────────────────────────────────────────────────────
export async function createWorkspace(name) {
  const ws = await api.createWorkspace(name);
  store.workspaces = await api.listWorkspaces();
  store.activeWorkspaceId = ws.id;
  await refreshTabs();
  if (store.tabs.length === 0) {
    const tab = await api.createTab({ workspaceId: ws.id, url: HOME_URL });
    store.tabs = [tab];
    store.activeTabId = tab.id;
  } else {
    store.activeTabId = store.tabs[0].id;
    await api.activateTab(store.activeTabId);
  }
  applyViewForTab(store.activeTab());
  await syncNativeViews();
  return ws;
}

export async function switchWorkspace(workspaceId) {
  await api.setActiveWorkspace(workspaceId);
  store.settings.active_workspace_id = workspaceId;
  store.activeWorkspaceId = workspaceId;
  await refreshTabs();
  if (store.tabs.length === 0) {
    const tab = await api.createTab({ workspaceId: workspaceId, url: HOME_URL });
    store.tabs = [tab];
    store.activeTabId = tab.id;
  } else {
    store.activeTabId = [...store.tabs].sort((a, b) => b.last_active_at - a.last_active_at)[0].id;
    await api.activateTab(store.activeTabId);
  }
  applyViewForTab(store.activeTab());
  await syncNativeViews();
}

export async function renameWorkspace(workspaceId, name) {
  const ws = await api.renameWorkspace(workspaceId, name);
  store.workspaces = await api.listWorkspaces();
  return ws;
}

export async function deleteWorkspace(workspaceId) {
  const result = await api.deleteWorkspace(workspaceId);
  store.workspaces = await api.listWorkspaces();
  store.settings.active_workspace_id = result.active_workspace_id;
  await switchWorkspace(result.active_workspace_id);
  return result;
}

// ── Bookmarks ─────────────────────────────────────────────────────────
export function bookmarkForUrl(url) {
  return store.bookmarks.find((b) => b.url === url) ?? null;
}

export async function toggleBookmarkCurrent() {
  const tab = store.activeTab();
  if (!tab || tab.url === HOME_URL || tab.url.startsWith('govind://')) return null;
  const existing = bookmarkForUrl(tab.url);
  if (existing) {
    await api.deleteBookmark(existing.id);
    await refreshBookmarks();
    return { bookmarked: false };
  }
  await api.saveBookmark(tab.title || tab.url, tab.url);
  await refreshBookmarks();
  return { bookmarked: true };
}

/** Apply a URL/title change reported by the native webview to the local state. */
export function applyTabMeta(tabId, meta = {}) {
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  if (meta.url && meta.url !== tab.url) tab.url = meta.url;
  if (meta.title) tab.title = meta.title;
  return tab;
}

// ── Native window/webview sync (Tauri only; no-op in preview) ────────

/**
 * Geometry of the region the native webview must occupy.
 * Child webviews are positioned relative to the *window client area*, so the
 * values are taken from the live DOM (titlebar + sidebar + toolbar are part of
 * the same client area).
 */
export function webRegion() {
  const toolbar = document.querySelector('.toolbar');
  const sidebar = document.getElementById('sidebar');
  const toolbarRect = toolbar?.getBoundingClientRect();
  const sidebarRect = sidebar?.getBoundingClientRect();
  const x = sidebarRect && sidebarRect.width > 0 ? sidebarRect.right : 0;
  const y = toolbarRect ? toolbarRect.bottom + 2 : 80; // + loading bar
  const width = Math.max(1, window.innerWidth - x);
  const height = Math.max(1, window.innerHeight - y);
  return { x, y, width, height };
}

export async function syncNativeViews(visibleOverride = null) {
  const tab = store.activeTab();
  const visible = visibleOverride ?? (store.view === 'web' && !!tab && !store.isHomeTab(tab));
  const { x, y, width, height } = webRegion();
  try {
    await api.syncTabWindows({
      activeTabId: store.activeTabId,
      visible,
      x, y, width, height,
    });
  } catch {
    /* preview mode — ignore */
  }
}

/** Update derived counts shown on the home footer. */
export function homeStats() {
  return {
    tabs: store.tabs.length,
    bookmarks: store.bookmarks.length,
    history: undefined,
  };
}
