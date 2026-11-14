import assert from 'node:assert/strict';
import test from 'node:test';
import { webRegion } from '../ui/js/state/store.js';

test('webview bounds ignore collapsed and overlay sidebars', () => {
  const sidebar = {
    collapsed: false,
    classList: { contains: () => sidebar.collapsed },
    getBoundingClientRect: () => ({ right: 280, width: 280 }),
  };
  globalThis.window = { innerWidth: 1200, innerHeight: 900 };
  globalThis.document = {
    querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 80 }) }),
    getElementById: (id) => id === 'sidebar' ? sidebar : null,
  };

  try {
    assert.equal(webRegion().x, 280);
    assert.equal(webRegion().width, 920);
    sidebar.collapsed = true;
    assert.equal(webRegion().x, 0);
    sidebar.collapsed = false;
    globalThis.window.innerWidth = 600;
    assert.equal(webRegion().x, 0);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});
