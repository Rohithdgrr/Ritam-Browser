import test from 'node:test';
import assert from 'node:assert/strict';

const {
  DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, parseShortcut, matchesShortcut, shortcutFromEvent,
} = await import('../ui/js/lib/shortcuts.js');

test('shortcut combos parse into modifiers and a key', () => {
  assert.deepEqual(parseShortcut('Ctrl+Shift+K'), {
    ctrl: true, alt: false, shift: true, meta: false, key: 'k',
  });
  assert.deepEqual(parseShortcut('Meta+Alt+2'), {
    ctrl: false, alt: true, shift: false, meta: true, key: '2',
  });
});

test('malformed combos are rejected', () => {
  assert.equal(parseShortcut('K'), null);
  assert.equal(parseShortcut('Ctrl+Shift+Enter'), null);
  assert.equal(parseShortcut('Hyper+K'), null);
  assert.equal(parseShortcut('Ctrl+'), null);
  assert.equal(parseShortcut(''), null);
  assert.equal(parseShortcut('Ctrl++'), null);
});

test('symbol keys are valid single-character accelerators', () => {
  assert.deepEqual(parseShortcut('Ctrl+,'), {
    ctrl: true, alt: false, shift: false, meta: false, key: ',',
  });
  assert.equal(matchesShortcut({ ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, key: ',' }, 'Ctrl+,'), true);
});

test('every advertised default shortcut is parseable', () => {
  for (const [action, combo] of Object.entries(DEFAULT_SHORTCUTS)) {
    assert.ok(parseShortcut(combo), `${action} default ${combo}`);
  }
});

test('every override action has a label', () => {
  const ids = new Set(SHORTCUT_ACTIONS.map((action) => action.id));
  for (const action of Object.keys(DEFAULT_SHORTCUTS)) assert.ok(ids.has(action), action);
});

test('matching requires the exact modifier set', () => {
  const event = { ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, key: 'K' };
  assert.equal(matchesShortcut(event, 'Ctrl+Alt+K'), true);
  assert.equal(matchesShortcut(event, 'Ctrl+K'), false);
  assert.equal(matchesShortcut(event, 'Ctrl+Shift+K'), false);
  assert.equal(matchesShortcut({ ...event, key: 'J' }, 'Ctrl+Alt+K'), false);
});

test('a keydown produces a storable combo', () => {
  assert.equal(shortcutFromEvent({ ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, key: 's' }), 'Ctrl+Shift+S');
  // Bare keys and modifier-only presses are not shortcuts.
  assert.equal(shortcutFromEvent({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, key: 's' }), '');
  assert.equal(shortcutFromEvent({ ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, key: 'Control' }), '');
});
