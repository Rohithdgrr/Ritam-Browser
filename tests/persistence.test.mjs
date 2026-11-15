import test from 'node:test';
import assert from 'node:assert/strict';

const settings = {};
const calls = [];
const tabs = [];

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args = {}) => {
        calls.push(command);
        switch (command) {
          case 'get_settings':
            return { ...settings };
          case 'list_workspaces':
            return [{ id: 'ws1', name: 'Work' }];
          case 'list_tabs':
            return [...tabs];
          case 'create_tab': {
            const tab = {
              id: 'created',
              workspace_id: args.workspaceId,
              url: args.url,
              title: args.url,
              favicon_url: null,
              is_pinned: 0,
              group_name: null,
              sort_order: tabs.length,
              created_at: Date.now(),
              last_active_at: Date.now(),
            };
            tabs.push(tab);
            return tab;
          }
          case 'close_tab': {
            const index = tabs.findIndex((tab) => tab.id === args.tabId);
            if (index >= 0) tabs.splice(index, 1);
            return { closed_id: args.tabId, active_tab_id: null };
          }
          case 'set_setting':
            settings[args.key] = args.value;
            return { key: args.key, value: args.value };
          case 'list_bookmarks':
            return [];
          default:
            return undefined;
        }
      },
    },
  },
  innerWidth: 1000,
  innerHeight: 800,
};
globalThis.document = {
  querySelector: () => null,
  getElementById: () => null,
};

const { store, initStore, closeTab, rememberMutedSite, clearClosedTabs } = await import(
  '../ui/js/state/store.js'
);

settings.recently_closed = JSON.stringify([
  { id: 'old', url: 'https://example.com/old', title: 'Old', workspace_id: 'ws1' },
]);
settings.muted_sites = JSON.stringify(['news.example']);

test('initStore restores recently closed tabs and muted sites', async () => {
  await initStore();
  assert.equal(store.closedTabs.length, 1);
  assert.equal(store.closedTabs[0].url, 'https://example.com/old');
  assert.ok(store.mutedSites.has('news.example'));
});

test('closing a tab persists the recently closed entry', async () => {
  const tab = {
    id: 'tab-1',
    workspace_id: 'ws1',
    url: 'https://example.com/article',
    title: 'Article',
    favicon_url: null,
    is_pinned: 0,
    group_name: null,
    sort_order: 0,
    created_at: Date.now(),
    last_active_at: Date.now(),
  };
  tabs.push(tab);
  store.tabs = [tab];
  store.activeTabId = tab.id;

  await closeTab(tab.id);

  const persisted = JSON.parse(settings.recently_closed);
  assert.equal(persisted[0].url, 'https://example.com/article');
  assert.equal(store.closedTabs[0].url, 'https://example.com/article');
});

test('recently closed history is capped at 20 entries', async () => {
  store.closedTabs = Array.from({ length: 24 }, (_, i) => ({
    id: `tab-${i}`,
    url: `https://example.com/${i}`,
    title: `${i}`,
  }));
  await clearClosedTabs();
  assert.equal(JSON.parse(settings.recently_closed).length, 0);
  assert.equal(store.closedTabs.length, 0);
});

test('mute keys drop the port so host:port entries validate', async () => {
  const { mutedSiteKey } = await import('../ui/js/state/store.js');
  assert.equal(mutedSiteKey('127.0.0.1:8081'), '127.0.0.1');
  assert.equal(mutedSiteKey('News.Example'), 'news.example');
  assert.equal(mutedSiteKey('[::1]:8081'), '[::1]');
  assert.equal(mutedSiteKey(''), '');
});

test('muting a site is remembered and unmuting forgets it', async () => {
  await rememberMutedSite('video.example', true);
  assert.deepEqual(JSON.parse(settings.muted_sites), ['news.example', 'video.example']);

  // Re-muting the same host must not duplicate it.
  await rememberMutedSite('video.example', true);
  assert.equal(JSON.parse(settings.muted_sites).filter((h) => h === 'video.example').length, 1);

  await rememberMutedSite('video.example', false);
  assert.deepEqual(JSON.parse(settings.muted_sites), ['news.example']);
  assert.ok(calls.includes('set_setting'));
});
