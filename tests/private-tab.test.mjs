import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'list_tabs') return [];
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

const { store, createPrivateTab, navigate, closeTab } = await import('../ui/js/state/store.js');

test('private tabs navigate and close without persisting tab or history data', async () => {
  store.activeWorkspaceId = 'workspace';
  store.settings = { https_first: 'true' };

  const tab = await createPrivateTab();
  assert.equal(tab.is_private, true);
  assert.equal(calls.some(({ command }) => command === 'create_tab'), false);

  await navigate('example.com');
  assert.equal(calls.some(({ command }) => command === 'navigate_private_tab'), true);
  assert.equal(calls.some(({ command }) => command === 'navigate_tab'), false);
  assert.equal(calls.some(({ command }) => command === 'add_history_entry'), false);

  await closeTab(tab.id);
  assert.equal(calls.some(({ command }) => command === 'close_private_tab'), true);
  assert.equal(calls.some(({ command }) => command === 'close_tab'), false);
  assert.equal(store.privateTabs.length, 0);
});
