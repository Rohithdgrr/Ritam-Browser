import test from 'node:test';
import assert from 'node:assert/strict';

const { createFallbackDb } = await import('../ui/js/services/fallback-db.js');

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

const db = createFallbackDb(memoryStorage());

test('bookmark tags and notes can be edited and read back', async () => {
  const bookmark = await db.save_bookmark({ title: 'Docs', url: 'https://docs.example.com/guide' });
  const updated = await db.update_bookmark_details({
    bookmark_id: bookmark.id,
    tags: 'work, reading',
    notes: 'Chapter 3 has the API keys',
    folder: 'Work/Docs',
  });
  assert.equal(updated.tags, 'work, reading');
  assert.equal(updated.notes, 'Chapter 3 has the API keys');
  assert.equal(updated.folder, 'Work/Docs');

  const [stored] = (await db.list_bookmarks()).filter((entry) => entry.id === bookmark.id);
  assert.equal(stored.notes, 'Chapter 3 has the API keys');
  assert.equal(stored.folder, 'Work/Docs');
});

test('bookmark folders can be set at save time and searched', async () => {
  const saved = await db.save_bookmark({
    title: 'Design tokens',
    url: 'https://design.example.com/tokens',
    folder: '  Reading  ',
  });
  assert.equal(saved.folder, 'Reading');

  const [stored] = (await db.list_bookmarks()).filter((entry) => entry.id === saved.id);
  assert.equal(stored.folder, 'Reading');
});

test('history search filters by domain and date range', async () => {
  const now = Date.now();
  await db.add_history_entry({ url: 'https://news.example.com/a', title: 'A' });
  await db.add_history_entry({ url: 'https://shop.test/b', title: 'B' });

  const byDomain = await db.search_history({ query: '', domain: 'example.com' });
  assert.ok(byDomain.every((entry) => entry.url.includes('example.com')));
  assert.ok(byDomain.length >= 1);

  const future = await db.search_history({ query: '', from: now + 60_000 });
  assert.deepEqual(future, []);

  const inRange = await db.search_history({ query: '', from: now - 60_000, to: now + 60_000 });
  assert.ok(inRange.length >= 2);
});
