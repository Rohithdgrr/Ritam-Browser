/**
 * Govind Browser — typed IPC service layer.
 * Inside Tauri 2 (withGlobalTauri) every call goes to the Rust backend.
 * In a plain browser (the local preview) the same command names are served
 * by a localStorage fallback with an identical contract (services/fallback-db.js).
 *
 * PAYLOAD CONTRACT (important):
 * Tauri v2 expects **camelCase** keys in the JS payload and maps them onto the
 * snake_case Rust parameter names (`tabId` → `tab_id`). Sending snake_case keys
 * makes the command fail with "missing required key tabId" and every caller
 * silently dies. The localStorage fallback speaks snake_case, so `invoke()`
 * translates the payload on that path only — the rest of the app always uses
 * camelCase.
 */

import { getFallbackDb } from './fallback-db.js';

const isTauri = () =>
  typeof window !== 'undefined' &&
  !!(window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function');

/** camelCase → snake_case, dropping undefined values. */
export function toSnakeCase(args) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined) continue;
    out[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = value;
  }
  return out;
}

async function invoke(command, args = {}) {
  if (isTauri()) return window.__TAURI__.core.invoke(command, args);
  const fallback = getFallbackDb();
  const fn = fallback[command];
  if (typeof fn !== 'function') throw new Error(`unknown command: ${command}`);
  return fn(toSnakeCase(args));
}

export const isNative = isTauri;

// ── Browser / tab surface ─────────────────────────────────────────────
export const createTab = ({ workspaceId, url } = {}) => invoke('create_tab', { workspaceId, url });
export const listTabs = ({ workspaceId } = {}) => invoke('list_tabs', { workspaceId });
export const activateTab = (tabId) => invoke('activate_tab', { tabId });
export const closeTab = (tabId) => invoke('close_tab', { tabId });
export const navigateTab = (tabId, url) => invoke('navigate_tab', { tabId, url });
export const updateTabMeta = (tabId, meta = {}) =>
  invoke('update_tab_meta', { tabId, ...meta });
export const togglePinTab = (tabId) => invoke('toggle_pin_tab', { tabId });
export const reorderTab = (tabId, direction) => invoke('reorder_tab', { tabId, direction });
export const goBack = (tabId) => invoke('go_back', { tabId });
export const goForward = (tabId) => invoke('go_forward', { tabId });
export const reloadTab = (tabId) => invoke('reload_tab', { tabId });
export const syncTabWindows = (args = {}) => invoke('sync_tab_windows', args);
export const printTab = (tabId) => invoke('print_tab', { tabId });
export const zoomTab = (tabId, factor) => invoke('zoom_tab', { tabId, factor });

// ── Workspaces ────────────────────────────────────────────────────────
export const createWorkspace = (name) => invoke('create_workspace', { name });
export const listWorkspaces = () => invoke('list_workspaces');
export const renameWorkspace = (workspaceId, name) => invoke('rename_workspace', { workspaceId, name });
export const deleteWorkspace = (workspaceId) => invoke('delete_workspace', { workspaceId });
export const setActiveWorkspace = (workspaceId) => invoke('set_active_workspace', { workspaceId });

// ── Bookmarks ─────────────────────────────────────────────────────────
export const listBookmarks = () => invoke('list_bookmarks');
export const saveBookmark = (title, url, isFavorite = 0) =>
  invoke('save_bookmark', { title, url, isFavorite });
export const deleteBookmark = (bookmarkId) => invoke('delete_bookmark', { bookmarkId });
export const toggleFavorite = (bookmarkId) => invoke('toggle_favorite', { bookmarkId });

// ── History ───────────────────────────────────────────────────────────
export const searchHistory = (query = '', limit = 100) => invoke('search_history', { query, limit });
export const addHistoryEntry = (url, title) => invoke('add_history_entry', { url, title });
export const deleteHistoryEntry = (historyId) => invoke('delete_history_entry', { historyId });

// ── Notes / scratchpad ────────────────────────────────────────────────
export const saveNote = (content, workspaceId, noteId) =>
  invoke('save_note', { content, workspaceId, noteId });
export const listNotes = (workspaceId) => invoke('list_notes', { workspaceId });
export const deleteNote = (noteId) => invoke('delete_note', { noteId });

// ── Downloads ─────────────────────────────────────────────────────────
export const listDownloads = () => invoke('list_downloads');
export const recordDownload = ({ url, filename, destination, totalBytes, mimeType } = {}) =>
  invoke('record_download', { url, filename, destination, totalBytes, mimeType });
export const clearDownloads = () => invoke('clear_downloads');
export const removeDownload = (downloadId) => invoke('remove_download', { downloadId });

// ── Settings & privacy ────────────────────────────────────────────────
export const getSettings = () => invoke('get_settings');
export const setSetting = (key, value) => invoke('set_setting', { key, value });
export const clearBrowsingData = (categories = []) => invoke('clear_browsing_data', { categories });
export const listSitePermissions = () => invoke('list_site_permissions');
export const setSitePermission = (origin, permission, decision) =>
  invoke('set_site_permission', { origin, permission, decision });
export const clearSitePermissions = (origin) => invoke('clear_site_permissions', { origin });
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
