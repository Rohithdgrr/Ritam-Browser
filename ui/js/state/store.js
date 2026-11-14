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

  /** Which view is visible: 'home' | 'web' */
  view: 'home',

  activeTab() {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  },
  activeWorkspace() {
    return this.workspaces.find((w) => w.id === this.activeWorkspaceId) ?? null;
  },
  isHomeTab(tab) {
    return !tab || tab.url === HOME_URL;
  },
};

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
    const tab = await api.createTab({ workspace_id: store.activeWorkspaceId, url: HOME_URL });
    store.tabs = [tab];
    store.activeTabId = tab.id;
  }
  store.activeTabId =
    store.tabs.find((t) => t.id === store.activeTabId)?.id ??
    [...store.tabs].sort((a, b) => b.last_active_at - a.last_active_at)[0]?.id ??
    null;

  if (store.activeTabId) await api.activateTab({ tab_id: store.activeTabId });
  await refreshBookmarks();
  store.view = store.isHomeTab(store.activeTab()) ? 'home' : 'web';
  store.ready = true;
}

export async function refreshTabs() {
  if (!store.activeWorkspaceId) { store.tabs = []; return; }
  store.tabs = await api.listTabs({ workspace_id: store.activeWorkspaceId });
}

export async function refreshBookmarks() {
  store.bookmarks = await api.listBookmarks();
}

// ── Tabs ──────────────────────────────────────────────────────────────
export async function createTab(url = HOME_URL) {
  const tab = await api.createTab({ workspace_id: store.activeWorkspaceId, url });
  await refreshTabs();
  store.activeTabId = tab.id;
  store.view = store.isHomeTab(tab) ? 'home' : 'web';
  return tab;
}

export async function closeTab(tabId) {
  const result = await api.closeTab({ tab_id: tabId });
  await refreshTabs();
  store.activeTabId = result.active_tab_id ?? store.tabs[0]?.id ?? null;
  const active = store.activeTab();
  store.view = store.isHomeTab(active) ? 'home' : 'web';
  await syncNativeViews();
  return result;
}

export async function activateTab(tabId) {
  await api.activateTab({ tab_id: tabId });
  store.activeTabId = tabId;
  await refreshTabs();
  const active = store.activeTab();
  store.view = store.isHomeTab(active) ? 'home' : 'web';
  await syncNativeViews();
  return active;
}

export async function togglePinTab(tabId) {
  const tab = await api.togglePinTab({ tab_id: tabId });
  await refreshTabs();
  return tab;
}

export async function reorderTab(tabId, direction) {
  store.tabs = await api.reorderTab({ tab_id: tabId, direction });
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

  const tab = await api.navigateTab({ tab_id: tabId, url: nav.url });

  if (nav.url !== HOME_URL && !nav.url.startsWith('about:')) {
    api.addHistoryEntry({ url: nav.url, title: nav.url }).catch(() => {});
  }

  await refreshTabs();
  store.view = store.isHomeTab(store.activeTab()) ? 'home' : 'web';
  await syncNativeViews();
  return { tab: store.activeTab(), nav };
}

export async function goHome() {
  if (!store.activeTabId) return;
  await api.navigateTab({ tab_id: store.activeTabId, url: HOME_URL });
  await refreshTabs();
  store.view = 'home';
  await syncNativeViews();
}

export async function goBack() { return api.goBack(store.activeTabId); }
export async function goForward() { return api.goForward(store.activeTabId); }
export async function reloadTab() { return api.reloadTab(store.activeTabId); }

// ── Workspaces ────────────────────────────────────────────────────────
export async function createWorkspace(name) {
  const ws = await api.createWorkspace({ name });
  store.workspaces = await api.listWorkspaces();
  store.activeWorkspaceId = ws.id;
  await refreshTabs();
  if (store.tabs.length === 0) {
    const tab = await api.createTab({ workspace_id: ws.id, url: HOME_URL });
    store.tabs = [tab];
    store.activeTabId = tab.id;
  } else {
    store.activeTabId = store.tabs[0].id;
    await api.activateTab({ tab_id: store.activeTabId });
  }
  store.view = store.isHomeTab(store.activeTab()) ? 'home' : 'web';
  await syncNativeViews();
  return ws;
}

export async function switchWorkspace(workspaceId) {
  await api.setActiveWorkspace({ workspace_id: workspaceId });
  store.settings.active_workspace_id = workspaceId;
  store.activeWorkspaceId = workspaceId;
  await refreshTabs();
  if (store.tabs.length === 0) {
    const tab = await api.createTab({ workspace_id: workspaceId, url: HOME_URL });
    store.tabs = [tab];
    store.activeTabId = tab.id;
  } else {
    store.activeTabId = [...store.tabs].sort((a, b) => b.last_active_at - a.last_active_at)[0].id;
    await api.activateTab({ tab_id: store.activeTabId });
  }
  store.view = store.isHomeTab(store.activeTab()) ? 'home' : 'web';
  await syncNativeViews();
}

export async function renameWorkspace(workspaceId, name) {
  const ws = await api.renameWorkspace({ workspace_id: workspaceId, name });
  store.workspaces = await api.listWorkspaces();
  return ws;
}

export async function deleteWorkspace(workspaceId) {
  const result = await api.deleteWorkspace({ workspace_id: workspaceId });
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
  if (!tab || tab.url === HOME_URL) return null;
  const existing = bookmarkForUrl(tab.url);
  if (existing) {
    await api.deleteBookmark({ bookmark_id: existing.id });
    await refreshBookmarks();
    return { bookmarked: false };
  }
  await api.saveBookmark({ title: tab.title || tab.url, url: tab.url });
  await refreshBookmarks();
  return { bookmarked: true };
}

// ── Native window/webview sync (Tauri only; no-op in preview) ────────
export async function syncNativeViews(visibleOverride = null) {
  const visible = visibleOverride ?? store.view === 'web';
  // Layout offset of #view-web relative to the Tauri main window:
  // sidebar width (or 0 when collapsed) + 0 horizontal offset, titlebar + toolbar vertically.
  const sidebar = document.getElementById('sidebar');
  const collapsed = sidebar?.classList.contains('collapsed');
  const x = collapsed ? 0 : 264;         // web region starts after the sidebar
  const y = 46 + 2;                       // toolbar height + loading bar (titlebar is inside the window)
  const main = document.querySelector('.main');
  const mainRect = main?.getBoundingClientRect();
  const width = Math.max(1, mainRect ? mainRect.width : window.innerWidth - x);
  const height = Math.max(1, (mainRect ? mainRect.height : window.innerHeight - 34) - y);
  try {
    await api.syncTabWindows({
      active_tab_id: store.activeTabId,
      visible,
      x, y, width, height,
    });
  } catch {
    /* preview mode — ignore */
  }
}

/** Update derived counts shown in the home footer. */
export function homeStats() {
  return {
    tabs: store.tabs.length,
    bookmarks: store.bookmarks.length,
    history: undefined,
  };
}
