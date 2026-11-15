/**
 * Govind Browser — localStorage fallback implementing the exact IPC command
 * surface of the Rust backend, so the whole app works in a plain browser
 * (this preview) as well as inside Tauri. In Tauri the service layer routes
 * to real SQLite-backed commands instead of touching storage here.
 *
 * Factory pattern: createFallbackDb(storage) where storage is a Storage-like
 * object (getItem/setItem/removeItem). Testable in node with a Map shim.
 */

import { parseBookmarksHtml, buildBookmarksHtml } from '../lib/bookmarks-file.js';

const STORAGE_KEY = 'govind.db.v1';
export const HOME_URL = 'govind://home';
const MAX_TEXT = 20000;
const now = () => Date.now();
const id = () =>
  (globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `id-${now()}-${Math.random().toString(36).slice(2, 10)}`);

const KNOWN_SETTINGS = {
  search_engine: { type: 'enum', values: ['duckduckgo', 'google', 'bing', 'startpage'] },
  restore_session: { type: 'bool' },
  https_first: { type: 'bool' },
  theme: { type: 'enum', values: ['zen-light', 'zen-dark'] },
  force_dark_websites: { type: 'bool' },
  translation_endpoint: { type: 'translation-endpoint' },
  active_workspace_id: { type: 'string' },
  spellcheck: { type: 'bool' },
  do_not_track: { type: 'bool' },
  safe_browsing: { type: 'bool' },
  network_blocking: { type: 'bool' },
  adblock_allowlist: { type: 'blocklist' },
  safebrowsing_blocklist: { type: 'blocklist' },
  content_blocking: { type: 'bool' },
  cosmetic_filters: { type: 'filters' },
  autofill_profiles: { type: 'profiles' },
};

const DEFAULT_SETTINGS = {
  search_engine: 'duckduckgo',
  restore_session: 'false',
  https_first: 'true',
  theme: 'zen-light',
  force_dark_websites: 'false',
  translation_endpoint: '',
  active_workspace_id: '',
  spellcheck: 'true',
  do_not_track: 'false',
  safe_browsing: 'true',
  network_blocking: 'true',
  adblock_allowlist: '',
  safebrowsing_blocklist: '',
  content_blocking: 'false',
  cosmetic_filters: '',
  autofill_profiles: '[]',
};

function validTranslationEndpoint(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

function isSafeUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return false;
  return /^(https|http|govind):\/\//i.test(u) || u.toLowerCase() === 'about:blank';
}

export function createFallbackDb(storage) {
  const mem = new Map();
  const store = storage ?? {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  };

  function load() {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* corrupted → reseed */ }
    return seed();
  }
  function save(db) {
    store.setItem(STORAGE_KEY, JSON.stringify(db));
    return db;
  }
  function seed() {
    const wsId = id();
    const db = {
      version: 1,
      workspaces: [{ id: wsId, name: 'Personal', color: '#4A6B5D', sort_order: 0, created_at: now() }],
      tabs: [],
      bookmarks: [
        // Seed a few favorite starter sites (user can remove any of them)
        { id: id(), title: 'Wikipedia', url: 'https://www.wikipedia.org', is_favorite: 1, sort_order: 0, created_at: now() },
        { id: id(), title: 'MDN Web Docs', url: 'https://developer.mozilla.org', is_favorite: 1, sort_order: 1, created_at: now() },
        { id: id(), title: 'GitHub', url: 'https://github.com', is_favorite: 1, sort_order: 2, created_at: now() },
      ],
      history: [],
      notes: [],
      downloads: [],
      reading_list: [],
      settings: { ...DEFAULT_SETTINGS, active_workspace_id: wsId },
      site_permissions: [],
    };
    return save(db);
  }

  const ok = (db) => db;
  const findTab = (db, tabId) => db.tabs.find((t) => t.id === tabId);

  const api = {
    // ── Tabs ────────────────────────────────────────────────
    async create_tab({ workspace_id, url } = {}) {
      const db = load();
      const target = url ?? HOME_URL;
      if (!isSafeUrl(target)) throw new Error('disallowed url scheme');
      const wsId = workspace_id ?? db.settings.active_workspace_id ?? db.workspaces[0]?.id;
      if (!db.workspaces.some((w) => w.id === wsId)) throw new Error('workspace not found');
      const order = db.tabs.filter((t) => t.workspace_id === wsId).reduce((m, t) => Math.max(m, t.sort_order), -1) + 1;
      const tab = {
        id: id(), workspace_id: wsId, url: target, title: target === HOME_URL ? 'New Tab' : titleFromUrl(target),
        favicon_url: null, is_pinned: 0, group_name: null, sort_order: order, created_at: now(), last_active_at: now(),
      };
      db.tabs.push(tab);
      db.settings.active_workspace_id = wsId;
      return ok(save(db)).tabs.find((t) => t.id === tab.id);
    },
    async list_tabs({ workspace_id } = {}) {
      const db = load();
      const rows = workspace_id ? db.tabs.filter((t) => t.workspace_id === workspace_id) : db.tabs;
      return [...rows].sort((a, b) => b.is_pinned - a.is_pinned || a.sort_order - b.sort_order);
    },
    async activate_tab({ tab_id }) {
      const db = load();
      const tab = findTab(db, tab_id);
      if (!tab) throw new Error('tab not found');
      tab.last_active_at = now();
      db.settings.active_workspace_id = tab.workspace_id;
      save(db);
      return tab;
    },
    async close_tab({ tab_id }) {
      const db = load();
      const idx = db.tabs.findIndex((t) => t.id === tab_id);
      if (idx === -1) return { closed_id: tab_id, active_tab_id: null };
      const [closed] = db.tabs.splice(idx, 1);
      const remaining = db.tabs.filter((t) => t.workspace_id === closed.workspace_id);
      let active = remaining.sort((a, b) => b.last_active_at - a.last_active_at)[0]
        ?? [...db.tabs].sort((a, b) => b.last_active_at - a.last_active_at)[0]
        ?? null;
      if (!active) {
        // Always keep at least one tab open (like mainstream browsers)
        active = {
          id: id(), workspace_id: closed.workspace_id, url: HOME_URL, title: 'New Tab',
          favicon_url: null, is_pinned: 0, group_name: null, sort_order: 0, created_at: now(), last_active_at: now(),
        };
        db.tabs.push(active);
      }
      active.last_active_at = now();
      db.settings.active_workspace_id = active.workspace_id;
      save(db);
      return { closed_id: tab_id, active_tab_id: active.id };
    },
    async update_tab_meta({ tab_id, title, url, favicon_url } = {}) {
      const db = load();
      const tab = findTab(db, tab_id);
      if (!tab) throw new Error('tab not found');
      if (url !== undefined) { if (!isSafeUrl(url)) throw new Error('disallowed url scheme'); tab.url = url; }
      if (title !== undefined) tab.title = String(title).slice(0, 500);
      if (favicon_url !== undefined) tab.favicon_url = favicon_url === null ? null : String(favicon_url).slice(0, 2048);
      tab.last_active_at = now();
      save(db);
      return tab;
    },
    async toggle_pin_tab({ tab_id }) {
      const db = load();
      const tab = findTab(db, tab_id);
      if (!tab) throw new Error('tab not found');
      tab.is_pinned = tab.is_pinned ? 0 : 1;
      save(db);
      return tab;
    },
    async set_tab_group({ tab_id, group_name } = {}) {
      const db = load();
      const tab = findTab(db, tab_id);
      if (!tab) throw new Error('tab not found');
      tab.group_name = String(group_name ?? '').trim().slice(0, 40) || null;
      save(db);
      return tab;
    },
    async reorder_tab({ tab_id, direction }) {
      const db = load();
      const tab = findTab(db, tab_id);
      if (!tab) throw new Error('tab not found');
      const siblings = db.tabs.filter((t) => t.workspace_id === tab.workspace_id).sort((a, b) => a.sort_order - b.sort_order);
      const i = siblings.findIndex((t) => t.id === tab_id);
      const j = direction === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < siblings.length) {
        [siblings[i].sort_order, siblings[j].sort_order] = [siblings[j].sort_order, siblings[i].sort_order];
      }
      save(db);
      return api.list_tabs({ workspace_id: tab.workspace_id });
    },

    // ── Workspaces ──────────────────────────────────────────
    async create_workspace({ name, color } = {}) {
      const clean = String(name ?? '').trim().slice(0, 80);
      if (!clean) throw new Error('workspace name required');
      const db = load();
      const ws = { id: id(), name: clean, color: /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : '#4A6B5D', sort_order: db.workspaces.length, created_at: now() };
      db.workspaces.push(ws);
      db.settings.active_workspace_id = ws.id;
      save(db);
      return ws;
    },
    async list_workspaces() {
      return [...load().workspaces].sort((a, b) => a.sort_order - b.sort_order);
    },
    async rename_workspace({ workspace_id, name }) {
      const clean = String(name ?? '').trim().slice(0, 80);
      if (!clean) throw new Error('workspace name required');
      const db = load();
      const ws = db.workspaces.find((w) => w.id === workspace_id);
      if (!ws) throw new Error('workspace not found');
      ws.name = clean;
      save(db);
      return ws;
    },
    async delete_workspace({ workspace_id }) {
      const db = load();
      if (db.workspaces.length <= 1) throw new Error('cannot delete the last workspace');
      const ws = db.workspaces.find((w) => w.id === workspace_id);
      if (!ws) throw new Error('workspace not found');
      db.tabs = db.tabs.filter((t) => t.workspace_id !== workspace_id);
      db.notes = db.notes.filter((n) => n.workspace_id !== workspace_id);
      db.workspaces = db.workspaces.filter((w) => w.id !== workspace_id);
      if (db.settings.active_workspace_id === workspace_id) db.settings.active_workspace_id = db.workspaces[0].id;
      save(db);
      return { deleted_id: workspace_id, active_workspace_id: db.settings.active_workspace_id };
    },
    async set_active_workspace({ workspace_id }) {
      const db = load();
      if (!db.workspaces.some((w) => w.id === workspace_id)) throw new Error('workspace not found');
      db.settings.active_workspace_id = workspace_id;
      save(db);
      return { active_workspace_id: workspace_id };
    },

    // ── Bookmarks ───────────────────────────────────────────
    async list_bookmarks() {
      return [...load().bookmarks].sort((a, b) => b.is_favorite - a.is_favorite || a.sort_order - b.sort_order || b.created_at - a.created_at);
    },
    async save_bookmark({ title, url, is_favorite = 0 } = {}) {
      if (!isSafeUrl(url)) throw new Error('disallowed url scheme');
      if (url === HOME_URL) throw new Error('cannot bookmark the internal home page');
      const db = load();
      const existing = db.bookmarks.find((b) => b.url === url);
      if (existing) {
        existing.title = String(title || existing.title).slice(0, 500);
        if (is_favorite) existing.is_favorite = 1;
        save(db);
        return existing;
      }
      const order = db.bookmarks.reduce((m, b) => Math.max(m, b.sort_order), -1) + 1;
      const b = { id: id(), title: String(title || titleFromUrl(url)).slice(0, 500), url, is_favorite: is_favorite ? 1 : 0, sort_order: order, created_at: now() };
      db.bookmarks.push(b);
      save(db);
      return b;
    },
    async delete_bookmark({ bookmark_id }) {
      const db = load();
      const before = db.bookmarks.length;
      db.bookmarks = db.bookmarks.filter((b) => b.id !== bookmark_id);
      save(db);
      return before !== db.bookmarks.length;
    },
    async toggle_favorite({ bookmark_id }) {
      const db = load();
      const b = db.bookmarks.find((x) => x.id === bookmark_id);
      if (!b) throw new Error('bookmark not found');
      b.is_favorite = b.is_favorite ? 0 : 1;
      save(db);
      return b;
    },

    // ── Bookmark import / export (Netscape HTML) ────────────
    // Native dialogs do not exist in the preview, so the *_file variants are
    // unavailable here; the UI uses the HTML variants with a browser file input.
    async import_bookmarks_file() {
      throw new Error('Native file dialog is only available in the installed app.');
    },
    async export_bookmarks_file() {
      throw new Error('Native file dialog is only available in the installed app.');
    },
    async import_bookmarks_html({ html } = {}) {
      const items = parseBookmarksHtml(html);
      const db = load();
      let imported = 0;
      let duplicates = 0;
      let skipped = 0;
      const seen = new Set();
      for (const { title, url } of items) {
        if (seen.has(url)) { duplicates += 1; continue; }
        seen.add(url);
        const existing = db.bookmarks.find((b) => b.url === url);
        if (existing) {
          existing.title = String(title || existing.title).slice(0, 500);
          duplicates += 1;
          continue;
        }
        if (db.bookmarks.length >= 5000) { skipped += 1; continue; }
        const order = db.bookmarks.reduce((m, b) => Math.max(m, b.sort_order), -1) + 1;
        db.bookmarks.push({
          id: id(),
          title: String(title || titleFromUrl(url)).slice(0, 500),
          url,
          is_favorite: 0,
          sort_order: order,
          created_at: now(),
        });
        imported += 1;
      }
      save(db);
      return { imported, skipped, duplicates };
    },
    async export_bookmarks_html() {
      const bookmarks = [...load().bookmarks].sort(
        (a, b) => b.is_favorite - a.is_favorite || a.sort_order - b.sort_order || b.created_at - a.created_at,
      );
      return buildBookmarksHtml(bookmarks);
    },

    async export_browser_backup_snapshot() {
      const db = load();
      return JSON.stringify({
        version: 1,
        exported_at: now(),
        workspaces: db.workspaces,
        tabs: db.tabs.filter((tab) => !tab.is_private),
        bookmarks: db.bookmarks,
        history: db.history,
        notes: db.notes,
        downloads: db.downloads,
        reading_list: db.reading_list,
        site_permissions: db.site_permissions,
        settings: db.settings,
      });
    },
    async import_browser_backup_snapshot({ snapshot_json } = {}) {
      if (typeof snapshot_json !== 'string' || snapshot_json.length > 32 * 1024 * 1024) {
        throw new Error('browser backup is too large');
      }
      let incoming;
      try { incoming = JSON.parse(snapshot_json); } catch { throw new Error('invalid browser backup data'); }
      const keys = ['workspaces', 'tabs', 'bookmarks', 'history', 'notes', 'downloads', 'reading_list', 'site_permissions'];
      if (incoming?.version !== 1 || keys.some((key) => !Array.isArray(incoming[key]) || incoming[key].length > 50000)
        || !incoming.settings || typeof incoming.settings !== 'object' || Array.isArray(incoming.settings)) {
        throw new Error('unsupported or oversized browser backup');
      }
      const workspaceIds = new Set(incoming.workspaces.map((workspace) => workspace?.id));
      const validBackupUrl = (url) => isSafeUrl(url)
        && url !== HOME_URL
        && (!url.startsWith('govind://') || [
          'home', 'history', 'downloads', 'bookmarks', 'settings', 'recently-closed',
          'reading-list', 'task-manager', 'media-controls', 'unsafe',
        ].includes(url.slice('govind://'.length).replace(/\/+$/, '').toLowerCase()));
      for (const tab of incoming.tabs) {
        if (!tab || !isSafeUrl(tab.url) || !workspaceIds.has(tab.workspace_id)) throw new Error('invalid tab in browser backup');
      }
      for (const bookmark of incoming.bookmarks) {
        if (!bookmark || !validBackupUrl(bookmark.url)) throw new Error('invalid bookmark in browser backup');
      }
      for (const item of [...incoming.history, ...incoming.reading_list]) {
        if (!item || !validBackupUrl(item.url)) throw new Error('invalid URL in browser backup');
      }

      const db = JSON.parse(JSON.stringify(load()));
      const summary = Object.fromEntries([...keys, 'settings'].map((key) => [key, 0]));
      const addMissing = (target, rows, keyFn) => {
        const seen = new Set(target.map(keyFn));
        for (const row of rows) {
          const key = keyFn(row);
          if (seen.has(key)) continue;
          target.push(row);
          seen.add(key);
          summary[target === db.workspaces ? 'workspaces'
            : target === db.tabs ? 'tabs'
              : target === db.bookmarks ? 'bookmarks'
                : target === db.notes ? 'notes'
                  : target === db.downloads ? 'downloads'
                    : target === db.site_permissions ? 'site_permissions' : 'reading_list'] += 1;
        }
      };
      addMissing(db.workspaces, incoming.workspaces, (row) => row.id);
      addMissing(db.tabs, incoming.tabs, (row) => row.id);
      addMissing(db.bookmarks, incoming.bookmarks, (row) => row.url);
      for (const row of incoming.history) {
        const existing = db.history.find((item) => item.url === row.url);
        if (!existing) { db.history.push(row); summary.history += 1; }
        else {
          if (row.visited_at > existing.visited_at) existing.title = row.title;
          existing.visited_at = Math.max(existing.visited_at, row.visited_at);
          existing.visit_count = Math.max(existing.visit_count, row.visit_count);
        }
      }
      addMissing(db.notes, incoming.notes, (row) => row.id);
      addMissing(db.downloads, incoming.downloads, (row) => row.id);
      addMissing(db.reading_list, incoming.reading_list, (row) => row.url);
      addMissing(db.site_permissions, incoming.site_permissions, (row) => `${row.origin}\n${row.permission}`);
      for (const [key, value] of Object.entries(incoming.settings)) {
        if (!(key in db.settings) || (key in DEFAULT_SETTINGS && db.settings[key] === DEFAULT_SETTINGS[key])) {
          db.settings[key] = value;
          summary.settings += 1;
        }
      }
      save(db);
      return summary;
    },

    // ── History ─────────────────────────────────────────────
    async search_history({ query = '', limit = 100 } = {}) {
      const db = load();
      const q = String(query).trim().toLowerCase();
      const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
      return [...db.history]
        .filter((h) => !q || h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q))
        .sort((a, b) => b.visited_at - a.visited_at)
        .slice(0, lim);
    },
    async add_history_entry({ url, title } = {}) {
      if (!isSafeUrl(url) || url === HOME_URL) return null;
      const db = load();
      const cleanTitle = String(title || titleFromUrl(url)).slice(0, 500);
      const existing = db.history.find((h) => h.url === url);
      if (existing) {
        existing.visited_at = now();
        existing.visit_count += 1;
        existing.title = cleanTitle;
        save(db);
        return existing;
      }
      const h = { id: id(), url, title: cleanTitle, visited_at: now(), visit_count: 1 };
      db.history.push(h);
      save(db);
      return h;
    },
    async delete_history_entry({ history_id }) {
      const db = load();
      const before = db.history.length;
      db.history = db.history.filter((h) => h.id !== history_id);
      save(db);
      return before !== db.history.length;
    },

    // ── Notes / scratchpad ──────────────────────────────────
    async save_note({ note_id, content, workspace_id } = {}) {
      const clean = String(content ?? '').slice(0, MAX_TEXT);
      if (!clean.trim()) throw new Error('note content required');
      const db = load();
      if (note_id) {
        const n = db.notes.find((x) => x.id === note_id);
        if (!n) throw new Error('note not found');
        n.content = clean;
        n.updated_at = now();
        save(db);
        return n;
      }
      const n = { id: id(), workspace_id: workspace_id ?? db.settings.active_workspace_id ?? null, content: clean, created_at: now(), updated_at: now() };
      db.notes.push(n);
      save(db);
      return n;
    },
    async list_notes({ workspace_id } = {}) {
      const db = load();
      const rows = workspace_id ? db.notes.filter((n) => !n.workspace_id || n.workspace_id === workspace_id) : db.notes;
      return [...rows].sort((a, b) => b.updated_at - a.updated_at);
    },
    async delete_note({ note_id }) {
      const db = load();
      const before = db.notes.length;
      db.notes = db.notes.filter((n) => n.id !== note_id);
      save(db);
      return before !== db.notes.length;
    },

    // ── Downloads ───────────────────────────────────────────
    async list_downloads() {
      return [...load().downloads].sort((a, b) => b.created_at - a.created_at);
    },
    async record_download({ url, filename, destination, total_bytes, mime_type } = {}) {
      if (!isSafeUrl(url)) throw new Error('disallowed url scheme');
      const db = load();
      const d = {
        id: id(), url, filename: String(filename || 'download').slice(0, 500),
        destination: destination ? String(destination).slice(0, 1024) : null,
        mime_type: mime_type ? String(mime_type).slice(0, 200) : null,
        total_bytes: Number.isFinite(total_bytes) ? total_bytes : null,
        received_bytes: Number.isFinite(total_bytes) ? total_bytes : 0,
        status: 'completed', created_at: now(), completed_at: now(),
      };
      db.downloads.push(d);
      save(db);
      return d;
    },
    async clear_downloads() {
      const db = load();
      const n = db.downloads.length;
      db.downloads = [];
      save(db);
      return n;
    },
    async remove_download({ download_id } = {}) {
      const db = load();
      const before = db.downloads.length;
      db.downloads = db.downloads.filter((d) => d.id !== download_id);
      save(db);
      return before !== db.downloads.length;
    },

    // ── Settings ────────────────────────────────────────────
    async get_settings() {
      return { ...DEFAULT_SETTINGS, ...load().settings };
    },
    async set_setting({ key, value }) {
      const spec = KNOWN_SETTINGS[key];
      if (!spec) throw new Error(`unknown setting key: ${key}`);
      const v = String(value);
      if (spec.type === 'bool' && v !== 'true' && v !== 'false') throw new Error('expected "true" or "false"');
      if (spec.type === 'enum' && !spec.values.includes(v)) throw new Error(`expected one of: ${spec.values.join(', ')}`);
      if (spec.type === 'string' && v.length > 128) throw new Error('value too long');
      if (spec.type === 'translation-endpoint' && (v.length > 2048 || !validTranslationEndpoint(v))) {
        throw new Error('translation endpoint must use HTTPS or localhost HTTP');
      }
      if (spec.type === 'blocklist' && (v.length > 20000 || !v.split('\n').every((l) => {
        const t = l.trim();
        return !t || /^[a-zA-Z0-9.*-]+$/.test(t.replace(/^\*\./, ''));
      }))) throw new Error('blocklist must be one hostname per line');
      if (spec.type === 'filters' && (v.length > 50000 || !v.split('\n').every((l) => {
        const t = l.trim();
        return !t || (!t.includes('{') && !t.includes('}') && !t.startsWith('@') && t.length <= 500);
      }))) throw new Error('filters must be CSS selectors, one per line');
      if (spec.type === 'profiles') {
        try {
          const parsed = JSON.parse(v);
          if (!Array.isArray(parsed) || parsed.length > 50 || v.length > 100000) throw new Error('bad');
        } catch {
          throw new Error('autofill profiles must be a JSON array of at most 50 entries');
        }
      }
      const db = load();
      db.settings[key] = v;
      save(db);
      return { key, value: v };
    },

    // ── Privacy: clear data ─────────────────────────────────
    async clear_browsing_data({ categories = [] } = {}) {
      const db = load();
      const result = { history: 0, downloads: 0, site_permissions: 0 };
      const cats = new Set(categories);
      if (cats.has('history')) { result.history = db.history.length; db.history = []; }
      if (cats.has('downloads')) { result.downloads = db.downloads.length; db.downloads = []; }
      if (cats.has('site_permissions')) { result.site_permissions = db.site_permissions.length; db.site_permissions = []; }
      save(db);
      return result;
    },

    // ── Site permissions ────────────────────────────────────
    async list_site_permissions() {
      return [...load().site_permissions].sort((a, b) => a.origin.localeCompare(b.origin));
    },
    async set_site_permission({ origin, permission, decision }) {
      const cleanOrigin = String(origin ?? '').trim().slice(0, 200);
      const cleanPerm = String(permission ?? '').trim().slice(0, 50);
      const cleanDecision = String(decision ?? '').trim().toLowerCase();
      if (!/^https?:\/\//i.test(cleanOrigin)) throw new Error('origin must be http(s)');
      if (!cleanPerm) throw new Error('permission required');
      if (!['ask', 'allow', 'deny'].includes(cleanDecision)) throw new Error('decision must be ask|allow|deny');
      const db = load();
      const existing = db.site_permissions.find((p) => p.origin === cleanOrigin && p.permission === cleanPerm);
      if (existing) {
        existing.decision = cleanDecision;
        existing.updated_at = now();
        save(db);
        return existing;
      }
      const p = { id: id(), origin: cleanOrigin, permission: cleanPerm, decision: cleanDecision, updated_at: now() };
      db.site_permissions.push(p);
      save(db);
      return p;
    },
    async clear_site_permissions({ origin } = {}) {
      const db = load();
      const before = db.site_permissions.length;
      db.site_permissions = origin ? db.site_permissions.filter((p) => p.origin !== origin) : [];
      save(db);
      return before - db.site_permissions.length;
    },

    // ── Reading list ────────────────────────────────────────
    async list_reading_items() {
      return [...load().reading_list].sort((a, b) => b.created_at - a.created_at);
    },
    async save_reading_item({ url, title, snapshot_text, note } = {}) {
      if (!isSafeUrl(url) || url.startsWith('govind://')) throw new Error('cannot save this page');
      const db = load();
      const existing = db.reading_list.find((r) => r.url === url);
      if (existing) {
        existing.title = String(title || existing.title).slice(0, 500);
        if (snapshot_text) existing.snapshot_text = String(snapshot_text).slice(0, 100000);
        if (note) existing.note = String(note).slice(0, 2000);
        save(db);
        return existing;
      }
      const item = {
        id: id(), url,
        title: String(title || titleFromUrl(url)).slice(0, 500),
        snapshot_text: snapshot_text ? String(snapshot_text).slice(0, 100000) : null,
        note: note ? String(note).slice(0, 2000) : null,
        created_at: now(),
      };
      db.reading_list.push(item);
      save(db);
      return item;
    },
    async delete_reading_item({ item_id }) {
      const db = load();
      const before = db.reading_list.length;
      db.reading_list = db.reading_list.filter((r) => r.id !== item_id);
      save(db);
      return before !== db.reading_list.length;
    },
    async clear_reading_list() {
      const db = load();
      const n = db.reading_list.length;
      db.reading_list = [];
      save(db);
      return n;
    },

    // ── App info ────────────────────────────────────────────
    async get_app_info() {
      return {
        name: 'Govind Browser', version: '0.1.0', milestone: 'Milestone 1 — Browser shell',
        engine: 'Browser preview (iframe) · Tauri 2 + system WebView2 in the installed app',
        storage: 'localStorage (fallback) · SQLite in the installed app',
        telemetry: 'disabled',
      };
    },

    // Tauri-only commands → harmless no-ops in the browser preview
    async sync_tab_windows() { return { ok: true, note: 'no-op outside Tauri' }; },
    async navigate_tab({ tab_id, url }) {
      if (!isSafeUrl(url)) throw new Error('disallowed url scheme');
      const db = load();
      const tab = findTab(db, tab_id);
      if (!tab) throw new Error('tab not found');
      tab.url = url;
      tab.title = url === HOME_URL ? 'New Tab' : titleFromUrl(url);
      tab.last_active_at = now();
      save(db);
      return tab;
    },
    async go_back() { return { ok: true }; },
    async go_forward() { return { ok: true }; },
    async reload_tab() { return { ok: true }; },
    async print_tab() { return { ok: true }; },
    async zoom_tab() { return { ok: true }; },
    async find_in_tab() { return { ok: true }; },
    async inspect_tab() { return { ok: true }; },
    async duplicate_tab({ tab_id } = {}) {
      const db = load();
      const source = findTab(db, tab_id);
      if (!source) throw new Error('tab not found');
      const clone = {
        ...source, id: 'fb-' + Math.random().toString(16).slice(2, 8),
        is_pinned: 0, sort_order: (db.tabs?.length ?? 0) + 1,
        created_at: now(), last_active_at: now(),
      };
      db.tabs.push(clone);
      save(db);
      return clone;
    },
    async close_other_tabs({ tab_id, scope } = {}) {
      const db = load();
      const source = findTab(db, tab_id);
      if (!source) throw new Error('tab not found');
      const siblings = db.tabs.filter((t) => t.workspace_id === source.workspace_id && t.id !== tab_id);
      const targets = scope === 'right'
        ? siblings.filter((t) => t.sort_order > source.sort_order)
        : siblings;
      db.tabs = db.tabs.filter((t) => !targets.includes(t));
      save(db);
      return db.tabs.filter((t) => t.workspace_id === source.workspace_id);
    },
    // Page-feature commands are engine-side; harmless no-ops in preview.
    async set_spellcheck() { return { ok: true }; },
    async set_do_not_track() { return { ok: true }; },
    async set_content_blocking() { return { ok: true }; },
    async set_network_blocking() { return { ok: true }; },
    async set_network_blocking_allowlist() { return { ok: true }; },
    async get_network_blocker_status() {
      return {
        available: false,
        enabled: false,
        ready: false,
        loadedLists: 0,
        resourceCount: 0,
        allowlistCount: 0,
        blockedRequests: 0,
        redirectedRequests: 0,
        rewrittenRequests: 0,
      };
    },
    async set_autofill_profiles() { return { ok: true }; },
    async request_page_snapshot() { throw new Error('Page snapshots need the installed app.'); },
    async clear_site_data() { return { ok: true }; },
    async bypass_unsafe_url() { return { ok: true }; },
  };

  return api;
}

function titleFromUrl(url) {
  if (url === HOME_URL) return 'New Tab';
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url.slice(0, 120);
  }
}

/** Browser singleton backed by window.localStorage. */
let singleton = null;
export function getFallbackDb() {
  if (!singleton) {
    const storage = typeof window !== 'undefined' ? window.localStorage : undefined;
    singleton = createFallbackDb(storage);
  }
  return singleton;
}
