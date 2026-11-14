import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
const tabs = [];
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args = {}) => {
        calls.push(command);
        if (command === 'list_tabs') return [...tabs];
        if (command === 'create_tab') {
          const tab = {
            id: 'reopened',
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
        if (command === 'close_tab') {
          const index = tabs.findIndex((tab) => tab.id === args.tabId);
          if (index >= 0) tabs.splice(index, 1);
          return { closed_id: args.tabId, active_tab_id: null };
        }
        if (command === 'set_tab_group') {
          const tab = tabs.find((item) => item.id === args.tabId);
          if (tab) tab.group_name = args.groupName;
          return tab;
        }
        return undefined;
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

const { store, closeTab, reopenClosedTab } = await import('../ui/js/state/store.js');

test('undo center reopens a closed tab with its group', async () => {
  const tab = {
    id: 'closed',
    workspace_id: 'workspace',
    url: 'https://example.com/article',
    title: 'Article',
    favicon_url: null,
    is_pinned: 0,
    group_name: 'Reading',
    sort_order: 0,
    created_at: Date.now(),
    last_active_at: Date.now(),
  };
  tabs.push(tab);
  store.workspaces = [{ id: 'workspace' }];
  store.activeWorkspaceId = 'workspace';
  store.tabs = [tab];
  store.activeTabId = tab.id;

  await closeTab(tab.id);
  assert.equal(store.closedTabs[0].url, tab.url);

  const reopened = await reopenClosedTab(tab.id);
  assert.equal(reopened.url, tab.url);
  assert.equal(reopened.group_name, 'Reading');
  assert.equal(store.closedTabs.length, 0);
  assert.ok(calls.includes('set_tab_group'));
});
