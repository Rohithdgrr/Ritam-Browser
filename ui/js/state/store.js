/**
 * Ritam Browser — central application state & actions (no framework).
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
  privateTabs: [],      // private tabs exist only for this app session
  closedTabs: [],       // recently closed regular tabs (persisted across restarts)
  collapsedTabGroups: new Set(),
  readerModeTabs: new Set(),
  mutedTabs: new Set(),
  mutedSites: new Set(), // hosts muted by the user, restored on later visits
  audioStates: new Map(),
  translatedTabs: new Set(),
  activeTabId: null,
  bookmarks: [],
  settings: {},

  /** Which view is visible: 'home' | 'web' | 'internal' */
  view: 'home',

  /** Internal page shown when view === 'internal' (history, downloads, …). */
  internalPage: null,

  /** Settings category shown on the settings page. */
  settingsCategory: 'general',

  /** Guest mode: every new tab is private and nothing persists. */
  guestMode: false,

  /** Safe-browsing interstitial state. */
  pendingUnsafeUrl: null,
  pendingUnsafeReason: null,

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

const CLOSED_TABS_LIMIT = 20;
const MUTED_SITES_LIMIT = 200;

/** Settings values are strings; a malformed entry degrades to an empty list. */
function settingArray(raw, limit) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.slice(0, limit) : [];
  } catch {
    return [];
  }
}

export function tabGroupKey(tab) {
  return `${encodeURIComponent(tab.workspace_id)}:${Number(tab.is_pinned)}:${encodeURIComponent(tab.group_name ?? '')}`;
}

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
  store.closedTabs = settingArray(store.settings.recently_closed, CLOSED_TABS_LIMIT).filter(
    (entry) => entry && typeof entry.id === 'string' && typeof entry.url === 'string',
  );
  store.mutedSites = new Set(
    settingArray(store.settings.muted_sites, MUTED_SITES_LIMIT).filter(
      (host) => typeof host === 'string' && host,
    ),
  );

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
  const tabs = await api.listTabs({ workspaceId: store.activeWorkspaceId });
  store.tabs = [
    ...tabs,
    ...store.privateTabs.filter((tab) => tab.workspace_id === store.activeWorkspaceId),
  ].sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || a.sort_order - b.sort_order);
}

export async function refreshBookmarks() {
  store.bookmarks = await api.listBookmarks();
}

// ── Tabs ──────────────────────────────────────────────────────────────
export async function createTab(url = HOME_URL) {
  if (store.guestMode) return createPrivateTab(url);
  const tab = await api.createTab({ workspaceId: store.activeWorkspaceId, url });
  await refreshTabs();
  store.activeTabId = tab.id;
  if (tab.url.startsWith('govind://')) pushInternalNav(tab.id, tab.url);
  applyViewForTab(tab);
  await syncNativeViews();
  return tab;
}

export async function createPrivateTab(url = HOME_URL) {
  const now = Date.now();
  const id = globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`;
  const target = normalizeInput(url, {
    searchEngine: store.settings.search_engine,
    customSearchUrl: store.settings.custom_search_url,
    httpsFirst: store.settings.https_first !== 'false',
  })?.url ?? url;
  const tab = {
    id: `private-${id}`,
    workspace_id: store.activeWorkspaceId,
    url: target,
    title: target === HOME_URL ? 'New Private Tab' : target,
    favicon_url: null,
    is_pinned: 0,
    group_name: null,
    sort_order: store.tabs.length,
    created_at: now,
    last_active_at: now,
    is_private: true,
  };
  store.privateTabs.push(tab);
  await refreshTabs();
  store.activeTabId = tab.id;
  if (target.startsWith('govind://')) pushInternalNav(tab.id, target);
  applyViewForTab(tab);
  await syncNativeViews();
  return tab;
}

export async function closeTab(tabId) {
  if (store.privateTabs.some((tab) => tab.id === tabId)) {
    await api.closePrivateTab(tabId);
    internalNav.delete(tabId);
    store.readerModeTabs.delete(tabId);
    store.mutedTabs.delete(tabId);
    store.audioStates.delete(tabId);
    store.translatedTabs.delete(tabId);
    store.privateTabs = store.privateTabs.filter((tab) => tab.id !== tabId);
    await refreshTabs();
    store.activeTabId = store.tabs[0]?.id ?? null;
    applyViewForTab(store.activeTab());
    await syncNativeViews();
    return { closed_id: tabId, active_tab_id: store.activeTabId };
  }
  const closedTab = store.tabs.find((tab) => tab.id === tabId);
  const result = await api.closeTab(tabId);
  internalNav.delete(tabId);
  store.readerModeTabs.delete(tabId);
  store.mutedTabs.delete(tabId);
  store.audioStates.delete(tabId);
  store.translatedTabs.delete(tabId);
  if (closedTab && !closedTab.is_private) {
    store.closedTabs.unshift({ ...closedTab, closed_at: Date.now() });
    await persistClosedTabs();
  }
  await refreshTabs();
  store.activeTabId = result.active_tab_id ?? store.tabs[0]?.id ?? null;
  applyViewForTab(store.activeTab());
  await syncNativeViews();
  return result;
}

export async function activateTab(tabId) {
  const privateTab = store.privateTabs.some((tab) => tab.id === tabId);
  if (!privateTab) await api.activateTab(tabId);
  store.activeTabId = tabId;
  await refreshTabs();
  applyViewForTab(store.activeTab());
  await syncNativeViews();
  return store.activeTab();
}

export async function togglePinTab(tabId) {
  if (store.privateTabs.some((tab) => tab.id === tabId)) return store.privateTabs.find((tab) => tab.id === tabId);
  const tab = await api.togglePinTab(tabId);
  await refreshTabs();
  return tab;
}

export async function setTabGroup(tabId, groupName) {
  const tab = store.tabs.find((item) => item.id === tabId);
  if (!tab) return null;
  const clean = String(groupName ?? '').trim().slice(0, 40) || null;
  if (tab.is_private) {
    tab.group_name = clean;
    await refreshTabs();
    return tab;
  }
  const updated = await api.setTabGroup(tabId, clean);
  await refreshTabs();
  return updated;
}

export async function reopenClosedTab(closedId) {
  const closed = store.closedTabs.find((tab) => tab.id === closedId);
  if (!closed) return null;
  if (!store.workspaces.some((workspace) => workspace.id === closed.workspace_id)) {
    store.closedTabs = store.closedTabs.filter((tab) => tab.id !== closedId);
    return null;
  }
  if (store.activeWorkspaceId !== closed.workspace_id) {
    await switchWorkspace(closed.workspace_id);
  }
  let reopened = await createTab(closed.url);
  if (closed.is_pinned) reopened = await togglePinTab(reopened.id);
  if (closed.group_name) reopened = await setTabGroup(reopened.id, closed.group_name);
  store.closedTabs = store.closedTabs.filter((tab) => tab.id !== closedId);
  await persistClosedTabs();
  return reopened;
}

export async function persistClosedTabs() {
  store.closedTabs = store.closedTabs.slice(0, CLOSED_TABS_LIMIT);
  await api
    .setSetting('recently_closed', JSON.stringify(store.closedTabs))
    .catch(() => {});
}

export async function clearClosedTabs() {
  store.closedTabs = [];
  await persistClosedTabs();
}

/**
 * Mute state is keyed by hostname. `hostOf()` returns `host:port`, so the port
 * is stripped here — otherwise the settings validator rejects the entry.
 */
export function mutedSiteKey(host) {
  const value = String(host ?? '').trim().toLowerCase();
  if (!value) return '';
  return value.startsWith('[') ? value.replace(/\]:\d+$/, ']') : value.replace(/:\d+$/, '');
}

/** Mute state is remembered per site, so it survives a restart. */
export async function rememberMutedSite(host, muted) {
  const key = mutedSiteKey(host);
  if (!key) return;
  host = key;
  if (muted) store.mutedSites.add(host);
  else store.mutedSites.delete(host);
  const hosts = [...store.mutedSites].slice(-MUTED_SITES_LIMIT);
  store.mutedSites = new Set(hosts);
  await api.setSetting('muted_sites', JSON.stringify(hosts)).catch(() => {});
}

export async function toggleReaderMode() {
  const tab = store.activeTab();
  if (!tab || store.isInternalTab(tab)) return false;
  const enabled = !store.readerModeTabs.has(tab.id);
  await api.readerModeTab(tab.id, enabled);
  if (enabled) store.readerModeTabs.add(tab.id);
  else store.readerModeTabs.delete(tab.id);
  return enabled;
}

export async function reorderTab(tabId, direction) {
  const privateTab = store.privateTabs.find((tab) => tab.id === tabId);
  if (privateTab) {
    const siblings = store.tabs
      .filter((tab) => tab.workspace_id === privateTab.workspace_id)
      .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || a.sort_order - b.sort_order);
    const index = siblings.findIndex((tab) => tab.id === tabId);
    const next = direction === 'up' ? index - 1 : index + 1;
    const target = siblings[next];
    if (target && !target.is_pinned) {
      const neighbor = siblings[next + (direction === 'up' ? -1 : 1)];
      privateTab.sort_order = neighbor
        ? (target.sort_order + neighbor.sort_order) / 2
        : target.sort_order + (direction === 'up' ? -0.5 : 0.5);
      await refreshTabs();
    }
    return store.tabs;
  }
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
    customSearchUrl: store.settings.custom_search_url,
    httpsFirst: store.settings.https_first !== 'false',
  });
  if (!nav) return null;

  const tabId = store.activeTabId;
  if (!tabId) return null;

  const activeTab = store.activeTab();
  store.audioStates.set(tabId, { playing: false, muted: store.mutedTabs.has(tabId) });
  store.readerModeTabs.delete(tabId);
  store.translatedTabs.delete(tabId);
  if (activeTab?.is_private) {
    await api.navigatePrivateTab(tabId, nav.url);
    activeTab.url = nav.url;
    activeTab.title = nav.url === HOME_URL ? 'New Private Tab' : nav.url;
    activeTab.favicon_url = null;
    if (nav.url.startsWith('govind://')) pushInternalNav(tabId, nav.url);
    await refreshTabs();
    applyViewForTab(activeTab);
    await syncNativeViews();
    return { tab: activeTab, nav };
  }

  const tab = await api.navigateTab(tabId, nav.url);

  if (nav.url.startsWith('govind://')) {
    pushInternalNav(tabId, nav.url);
  } else if (!activeTab?.is_private && nav.url !== HOME_URL && !nav.url.startsWith('about:')) {
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
  const known = ['home', 'history', 'downloads', 'bookmarks', 'settings', 'recently-closed', 'reading-list', 'task-manager', 'media-controls', 'unsafe'];
  if (!known.includes(route)) return null;
  if (route === 'settings') {
    const category = String(page).split(':')[1];
    if (category) store.settingsCategory = category;
  }
  return navigate(`govind://${route}`);
}

export async function goHome() {
  if (!store.activeTabId) return;
  const tab = store.activeTab();
  if (tab) store.audioStates.set(tab.id, { playing: false, muted: store.mutedTabs.has(tab.id) });
  if (tab) store.readerModeTabs.delete(tab.id);
  if (tab) store.translatedTabs.delete(tab.id);
  if (tab?.is_private) {
    await api.navigatePrivateTab(tab.id, HOME_URL);
    tab.url = HOME_URL;
    tab.title = 'New Private Tab';
    tab.favicon_url = null;
  } else {
    await api.navigateTab(store.activeTabId, HOME_URL);
  }
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
  const privateTabs = store.privateTabs.filter((tab) => tab.workspace_id === workspaceId);
  await Promise.all(privateTabs.map((tab) => api.closePrivateTab(tab.id)));
  store.privateTabs = store.privateTabs.filter((tab) => tab.workspace_id !== workspaceId);
  store.closedTabs = store.closedTabs.filter((tab) => tab.workspace_id !== workspaceId);
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
  if (meta.favicon_url !== undefined) tab.favicon_url = meta.favicon_url;
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
  const findBar = document.getElementById('find-bar');
  const toolbarRect = toolbar?.getBoundingClientRect();
  const sidebarRect = sidebar?.getBoundingClientRect();
  // While the find bar is open it takes a strip of the web region.
  const findRect = findBar && !findBar.classList.contains('hidden')
    ? findBar.getBoundingClientRect()
    : null;
  const x = sidebar && window.innerWidth > 700 && !sidebar.classList.contains('collapsed')
    ? sidebarRect?.right ?? 0
    : 0;
  const y = (findRect?.bottom ?? toolbarRect?.bottom ?? 80) + 2; // + loading bar
  const width = Math.max(1, window.innerWidth - x);
  const height = Math.max(1, window.innerHeight - y);
  return { x, y, width, height };
}

export async function syncNativeViews(visibleOverride = null) {
  const tab = store.activeTab();
  const { x, y, width, height } = webRegion();
  const visible = visibleOverride ?? (store.view === 'web' && !!tab && !store.isHomeTab(tab));
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
