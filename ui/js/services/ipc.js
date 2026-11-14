/**
 * Govind Browser — typed IPC service layer.
 * Inside Tauri 2 (withGlobalTauri) every call goes to the Rust backend.
 * In a plain browser (the Arena preview) the same command names are served
 * by a localStorage fallback with an identical contract (services/fallback-db.js).
 */

import { getFallbackDb } from './fallback-db.js';

const isTauri = () =>
  typeof window !== 'undefined' &&
  !!(window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function');

async function invoke(command, args = {}) {
  if (isTauri()) return window.__TAURI__.core.invoke(command, args);
  const fallback = getFallbackDb();
  const fn = fallback[command];
  if (typeof fn !== 'function') throw new Error(`unknown command: ${command}`);
  return fn(args);
}

export const isNative = isTauri;

// ── Browser / tab surface ─────────────────────────────────────────────
export const createTab = (args) => invoke('create_tab', args);
export const listTabs = (args) => invoke('list_tabs', args);
export const activateTab = (args) => invoke('activate_tab', args);
export const closeTab = (args) => invoke('close_tab', args);
export const navigateTab = (args) => invoke('navigate_tab', args);
export const updateTabMeta = (args) => invoke('update_tab_meta', args);
export const togglePinTab = (args) => invoke('toggle_pin_tab', args);
export const reorderTab = (args) => invoke('reorder_tab', args);
export const goBack = (tabId) => invoke('go_back', { tab_id: tabId ?? null });
export const goForward = (tabId) => invoke('go_forward', { tab_id: tabId ?? null });
export const reloadTab = (tabId) => invoke('reload_tab', { tab_id: tabId ?? null });
export const syncTabWindows = (args) => invoke('sync_tab_windows', args);

// ── Workspaces ────────────────────────────────────────────────────────
export const createWorkspace = (args) => invoke('create_workspace', args);
export const listWorkspaces = () => invoke('list_workspaces');
export const renameWorkspace = (args) => invoke('rename_workspace', args);
export const deleteWorkspace = (args) => invoke('delete_workspace', args);
export const setActiveWorkspace = (args) => invoke('set_active_workspace', args);

// ── Bookmarks ─────────────────────────────────────────────────────────
export const listBookmarks = () => invoke('list_bookmarks');
export const saveBookmark = (args) => invoke('save_bookmark', args);
export const deleteBookmark = (args) => invoke('delete_bookmark', args);
export const toggleFavorite = (args) => invoke('toggle_favorite', args);

// ── History ───────────────────────────────────────────────────────────
export const searchHistory = (args) => invoke('search_history', args);
export const addHistoryEntry = (args) => invoke('add_history_entry', args);
export const deleteHistoryEntry = (args) => invoke('delete_history_entry', args);

// ── Notes ─────────────────────────────────────────────────────────────
export const saveNote = (args) => invoke('save_note', args);
export const listNotes = (args) => invoke('list_notes', args);
export const deleteNote = (args) => invoke('delete_note', args);

// ── Downloads ─────────────────────────────────────────────────────────
export const listDownloads = () => invoke('list_downloads');
export const recordDownload = (args) => invoke('record_download', args);
export const clearDownloads = () => invoke('clear_downloads');

// ── Settings & privacy ────────────────────────────────────────────────
export const getSettings = () => invoke('get_settings');
export const setSetting = (args) => invoke('set_setting', args);
export const clearBrowsingData = (args) => invoke('clear_browsing_data', args);
export const listSitePermissions = () => invoke('list_site_permissions');
export const setSitePermission = (args) => invoke('set_site_permission', args);
export const clearSitePermissions = (args) => invoke('clear_site_permissions', args);
export const getAppInfo = () => invoke('get_app_info');

// ── Window chrome (native only; graceful fallback otherwise) ─────────
function currentWindow() {
  if (isTauri() && window.__TAURI__.window?.getCurrentWindow) {
    return window.__TAURI__.window.getCurrentWindow();
  }
  return null;
}
export async function minimizeWindow() {
  const w = currentWindow();
  if (w) return w.minimize();
  showPreviewNotice('Window controls are live in the installed app.');
}
export async function toggleMaximizeWindow() {
  const w = currentWindow();
  if (w) return w.toggleMaximize();
  showPreviewNotice('Window controls are live in the installed app.');
}
export async function closeWindow() {
  const w = currentWindow();
  if (w) return w.close();
  showPreviewNotice('Close is live in the installed app (the preview cannot close itself).');
}

// ── Native events (Tauri) — resolves to an unsubscribe fn or no-op ───
export async function listen(event, handler) {
  if (isTauri() && window.__TAURI__.event?.listen) {
    return window.__TAURI__.event.listen(event, handler);
  }
  return () => {};
}

export async function openExternal(url) {
  if (isTauri() && window.__TAURI__.shell?.open) {
    return window.__TAURI__.shell.open(url);
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

let noticeFn = null;
export function onPreviewNotice(fn) { noticeFn = fn; }
function showPreviewNotice(msg) { if (noticeFn) noticeFn(msg); }
