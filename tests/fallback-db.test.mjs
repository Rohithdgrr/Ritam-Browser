import test from 'node:test';
import assert from 'node:assert/strict';
import { createFallbackDb } from '../ui/js/services/fallback-db.js';

function freshDb() {
  // In-memory Storage shim
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return createFallbackDb(storage);
}

test('seeds a default Personal workspace with no tabs', async () => {
  const db = freshDb();
  const workspaces = await db.list_workspaces();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].name, 'Personal');
  assert.deepEqual(await db.list_tabs(), []);
});

test('create/activate/close tab lifecycle keeps one tab open', async () => {
  const db = freshDb();
  const t1 = await db.create_tab({ url: 'https://example.com' });
  assert.equal(t1.url, 'https://example.com');
  const t2 = await db.create_tab({ url: 'govind://home' });
  let tabs = await db.list_tabs();
  assert.equal(tabs.length, 2);

  await db.activate_tab({ tab_id: t1.id });
  const res = await db.close_tab({ tab_id: t1.id });
  assert.equal(res.closed_id, t1.id);
  assert.equal(res.active_tab_id, t2.id);

  // Closing the last tab auto-opens a fresh home tab
  await db.close_tab({ tab_id: t2.id });
  tabs = await db.list_tabs();
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].url, 'govind://home');
});

test('tab groups are trimmed, bounded, and removable', async () => {
  const db = freshDb();
  const tab = await db.create_tab({ url: 'https://example.com' });
  const grouped = await db.set_tab_group({ tab_id: tab.id, group_name: '  Work  ' });
  assert.equal(grouped.group_name, 'Work');
  const bounded = await db.set_tab_group({ tab_id: tab.id, group_name: 'x'.repeat(60) });
  assert.equal(bounded.group_name.length, 40);
  const removed = await db.set_tab_group({ tab_id: tab.id, group_name: ' ' });
  assert.equal(removed.group_name, null);
});

test('navigate then bookmark then unbookmark', async () => {
  const db = freshDb();
  const tab = await db.create_tab({ url: 'govind://home' });
  await db.navigate_tab({ tab_id: tab.id, url: 'https://news.ycombinator.com' });
  const b = await db.save_bookmark({ title: 'HN', url: 'https://news.ycombinator.com' });
  assert.equal(b.url, 'https://news.ycombinator.com');
  let bookmarks = await db.list_bookmarks();
  assert.ok(bookmarks.some((x) => x.id === b.id));

  const toggled = await db.toggle_favorite({ bookmark_id: b.id });
  assert.equal(toggled.is_favorite, 1);

  const removed = await db.delete_bookmark({ bookmark_id: b.id });
  assert.equal(removed, true);
  bookmarks = await db.list_bookmarks();
  assert.ok(!bookmarks.some((x) => x.id === b.id));
});

test('bookmark rejects disallowed schemes and internal pages', async () => {
  const db = freshDb();
  await assert.rejects(() => db.save_bookmark({ title: 'x', url: 'javascript:alert(1)' }));
  await assert.rejects(() => db.save_bookmark({ title: 'x', url: 'govind://home' }));
});

test('history upsert increments visit_count', async () => {
  const db = freshDb();
  await db.add_history_entry({ url: 'https://example.com', title: 'Example' });
  await db.add_history_entry({ url: 'https://example.com', title: 'Example' });
  const rows = await db.search_history({ query: 'example' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].visit_count, 2);
});

test('clear_browsing_data honors categories and counts deletions', async () => {
  const db = freshDb();
  await db.add_history_entry({ url: 'https://a.com', title: 'A' });
  await db.record_download({ url: 'https://a.com/f.pdf', filename: 'f.pdf', total_bytes: 2048 });
  await db.set_site_permission({ origin: 'https://a.com', permission: 'camera', decision: 'allow' });

  const onlyHistory = await db.clear_browsing_data({ categories: ['history'] });
  assert.equal(onlyHistory.history, 1);
  assert.equal(onlyHistory.downloads, 0);

  const rest = await db.clear_browsing_data({ categories: ['downloads', 'site_permissions'] });
  assert.equal(rest.downloads, 1);
  assert.equal(rest.site_permissions, 1);
});

test('set_setting enforces the key allowlist and value types', async () => {
  const db = freshDb();
  await assert.rejects(() => db.set_setting({ key: 'evil_key', value: 'x' }));
  await assert.rejects(() => db.set_setting({ key: 'https_first', value: 'yes' }));
  await db.set_setting({ key: 'https_first', value: 'false' });
  assert.equal((await db.get_settings()).network_blocking, 'true');
  await db.set_setting({ key: 'network_blocking', value: 'false' });
  await db.set_setting({ key: 'translation_endpoint', value: 'http://localhost:5000' });
  await db.set_setting({ key: 'translation_endpoint', value: 'https://translate.example/api' });
  await assert.rejects(() => db.set_setting({ key: 'translation_endpoint', value: 'http://example.com' }));
  await assert.rejects(() => db.set_setting({ key: 'translation_endpoint', value: 'https://user:pass@example.com' }));
  const s = await db.get_settings();
  assert.equal(s.https_first, 'false');
  assert.equal(s.network_blocking, 'false');
});

test('workspace deletion refuses the last workspace and cleans its tabs', async () => {
  const db = freshDb();
  const second = await db.create_workspace({ name: 'Studio' });
  await db.create_tab({ url: 'https://example.com', workspace_id: second.id });
  const res = await db.delete_workspace({ workspace_id: second.id });
  assert.ok(res.active_workspace_id);
  const tabs = await db.list_tabs({ workspace_id: second.id });
  assert.equal(tabs.length, 0);
  await assert.rejects(() => db.delete_workspace({ workspace_id: res.active_workspace_id }));
});

test('notes: save, list (workspace-scoped), delete', async () => {
  const db = freshDb();
  const n = await db.save_note({ content: 'remember the milk', workspace_id: null });
  const notes = await db.list_notes({});
  assert.ok(notes.some((x) => x.id === n.id));
  assert.equal(await db.delete_note({ note_id: n.id }), true);
  assert.equal((await db.list_notes({})).length, 0);
});

test('record_download stores bytes and clears list', async () => {
  const db = freshDb();
  await db.record_download({ url: 'https://x.com/a.zip', filename: 'a.zip', total_bytes: 1024 * 1024 });
  const rows = await db.list_downloads();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_bytes, 1024 * 1024);
  assert.equal(rows[0].status, 'completed');
  assert.equal(await db.clear_downloads(), 1);
  assert.deepEqual(await db.list_downloads(), []);
});

test('permissions upsert by origin+permission', async () => {
  const db = freshDb();
  await db.set_site_permission({ origin: 'https://a.com', permission: 'camera', decision: 'allow' });
  await db.set_site_permission({ origin: 'https://a.com', permission: 'camera', decision: 'deny' });
  const rows = await db.list_site_permissions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'deny');
});

test('bookmark import/export round-trips through the HTML fallback', async () => {
  const db = freshDb();
  const sample = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><A HREF="https://imported.example/one">One &amp; only</A>
  <DT><A HREF="https://imported.example/two">Two</A>
  <DT><A HREF="javascript:alert(1)">Evil</A>
</DL><p>`;

  const summary = await db.import_bookmarks_html({ html: sample });
  assert.equal(summary.imported, 2);
  assert.equal(summary.duplicates, 0);

  // Re-importing the same file updates titles, counts as duplicates.
  const again = await db.import_bookmarks_html({ html: sample });
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 2);

  const html = await db.export_bookmarks_html();
  assert.ok(html.includes('https://imported.example/one'));
  assert.ok(!html.includes('javascript:'));

  // The exported file is itself importable (round-trip).
  const roundTrip = await db.import_bookmarks_html({ html });
  assert.equal(roundTrip.imported, 0);
  assert.ok(roundTrip.duplicates >= 2);
});

test('encrypted backup data merges without deleting local records', async () => {
  const source = freshDb();
  await source.save_bookmark({ title: 'From backup', url: 'https://backup.example' });
  await source.set_setting({ key: 'theme', value: 'zen-dark' });
  const snapshot = await source.export_browser_backup_snapshot();
  const target = freshDb();
  await target.save_bookmark({ title: 'Keep local', url: 'https://local.example' });
  await target.set_setting({ key: 'https_first', value: 'false' });

  const summary = await target.import_browser_backup_snapshot({ snapshot_json: snapshot });
  const bookmarks = await target.list_bookmarks();
  assert.equal(summary.bookmarks, 1);
  assert.ok(bookmarks.some((bookmark) => bookmark.url === 'https://local.example'));
  assert.ok(bookmarks.some((bookmark) => bookmark.url === 'https://backup.example'));
  const settings = await target.get_settings();
  assert.equal(settings.theme, 'zen-dark');
  assert.equal(settings.https_first, 'false');
  assert.equal((await target.import_browser_backup_snapshot({ snapshot_json: snapshot })).bookmarks, 0);
});

test('browser backup rejects unsafe URLs before modifying local data', async () => {
  const db = freshDb();
  const snapshot = JSON.parse(await db.export_browser_backup_snapshot());
  snapshot.bookmarks.push({
    id: 'unsafe', title: 'Unsafe', url: 'javascript:alert(1)', is_favorite: 0, sort_order: 0, created_at: 1,
  });
  await assert.rejects(db.import_browser_backup_snapshot({ snapshot_json: JSON.stringify(snapshot) }));
  assert.equal((await db.list_bookmarks()).length, 3);
});

test('native-only bookmark commands are unavailable in preview', async () => {
  const db = freshDb();
  await assert.rejects(() => db.import_bookmarks_file());
  await assert.rejects(() => db.export_bookmarks_file());
});
