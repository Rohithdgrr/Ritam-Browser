import test from 'node:test';
import assert from 'node:assert/strict';

const { siteKey, tabGroupSuggestions, duplicateTabGroups, sleepCandidates, AI_TAB_URL, isAiTab } = await import('../ui/js/lib/tabs.js');

const tab = (overrides) => ({
  id: overrides.id ?? overrides.url,
  url: overrides.url,
  title: overrides.title ?? overrides.url,
  workspace_id: 'ws-1',
  is_pinned: overrides.is_pinned ?? 0,
  is_private: overrides.is_private ?? false,
  group_name: overrides.group_name ?? null,
  last_active_at: overrides.last_active_at ?? 0,
});

test('the AI Workspace tab is identified by URL', () => {
  assert.equal(AI_TAB_URL, 'govind://ai');
  assert.equal(isAiTab({ url: 'govind://ai' }), true);
  assert.equal(isAiTab({ url: 'https://example.com' }), false);
  assert.equal(isAiTab(null), false);
});

test('siteKey normalises web hosts and rejects internal pages', () => {
  assert.equal(siteKey('https://www.example.com/a?b=1'), 'example.com');
  assert.equal(siteKey('http://docs.example.com:8080/x'), 'docs.example.com');
  assert.equal(siteKey('govind://downloads'), null);
  assert.equal(siteKey('not a url'), null);
});

test('smart groups suggest sites with three loose tabs', () => {
  const suggestions = tabGroupSuggestions([
    tab({ id: 'a', url: 'https://github.com/one' }),
    tab({ id: 'b', url: 'https://github.com/two' }),
    tab({ id: 'c', url: 'https://www.github.com/three' }),
    tab({ id: 'd', url: 'https://github.com/four', group_name: 'Work' }),
    tab({ id: 'e', url: 'https://news.example.com/x' }),
    tab({ id: 'f', url: 'https://news.example.com/y' }),
    tab({ id: 'g', url: 'govind://home' }),
  ]);
  assert.deepEqual(suggestions, [{ site: 'github.com', count: 3 }]);
});

test('smart groups ignore pinned tabs and honour the limit', () => {
  const suggestions = tabGroupSuggestions([
    tab({ id: 'a', url: 'https://one.test/1' }),
    tab({ id: 'b', url: 'https://one.test/2' }),
    tab({ id: 'c', url: 'https://one.test/3' }),
    tab({ id: 'd', url: 'https://two.test/1' }),
    tab({ id: 'e', url: 'https://two.test/2' }),
    tab({ id: 'f', url: 'https://two.test/3' }),
    tab({ id: 'g', url: 'https://one.test/4', is_pinned: 1 }),
  ], { limit: 1 });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].site, 'one.test');
});

test('duplicate detection groups identical URLs only', () => {
  const groups = duplicateTabGroups([
    tab({ id: 'a', url: 'https://example.com/page' }),
    tab({ id: 'b', url: 'https://example.com/page' }),
    tab({ id: 'c', url: 'https://example.com/other' }),
    tab({ id: 'd', url: 'https://example.com/page', is_private: true }),
    tab({ id: 'e', url: 'govind://home' }),
    tab({ id: 'f', url: 'govind://home' }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((entry) => entry.id), ['a', 'b']);
});

test('sleep candidates are idle, unprotected web tabs', () => {
  const now = 10 * 60_000;
  const minutes = 5;
  const candidates = sleepCandidates([
    tab({ id: 'active', url: 'https://active.test', last_active_at: now - 60 * 60_000 }),
    tab({ id: 'idle', url: 'https://idle.test', last_active_at: now - 6 * 60_000 }),
    tab({ id: 'fresh', url: 'https://fresh.test', last_active_at: now - 60_000 }),
    tab({ id: 'pinned', url: 'https://pinned.test', last_active_at: now - 6 * 60_000, is_pinned: 1 }),
    tab({ id: 'private', url: 'https://private.test', last_active_at: now - 6 * 60_000, is_private: true }),
    tab({ id: 'playing', url: 'https://music.test', last_active_at: now - 6 * 60_000 }),
    tab({ id: 'internal', url: 'govind://downloads', last_active_at: now - 6 * 60_000 }),
    tab({ id: 'already', url: 'https://already.test', last_active_at: now - 6 * 60_000 }),
  ], {
    activeTabId: 'active',
    sleeping: new Set(['already']),
    audioPlaying: new Set(['playing']),
    minutes,
    now,
  });
  assert.deepEqual(candidates, ['idle']);
});

test('tab sleeping is off when the threshold is zero', () => {
  assert.deepEqual(sleepCandidates([
    tab({ id: 'old', url: 'https://old.test', last_active_at: 1 }),
  ], { minutes: 0, now: Date.now() }), []);
});
