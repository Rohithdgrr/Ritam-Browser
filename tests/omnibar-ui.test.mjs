import test from 'node:test';
import assert from 'node:assert/strict';

// Set up minimal DOM mocks
const elements = new Map();

function createElement(id, tag = 'div') {
  const el = {
    id,
    tagName: tag.toUpperCase(),
    value: '',
    classList: {
      _classes: new Set(),
      add(cls) { this._classes.add(cls); },
      remove(cls) { this._classes.delete(cls); },
      toggle(cls, force) {
        if (force === undefined) {
          if (this._classes.has(cls)) { this._classes.delete(cls); return false; }
          this._classes.add(cls); return true;
        }
        if (force) this._classes.add(cls); else this._classes.delete(cls);
        return force;
      },
      contains(cls) { return this._classes.has(cls); },
    },
    innerHTML: '',
    addEventListener() {},
    focus() {},
    select() {},
    querySelectorAll() { return []; },
  };
  elements.set(id, el);
  return el;
}

const omnibarInput = createElement('omnibar-input', 'input');
const omnibarClear = createElement('omnibar-clear', 'button');
const omnibarCopy = createElement('omnibar-copy', 'button');
const omnibarDropdown = createElement('omnibar-dropdown', 'div');

globalThis.document = {
  querySelector: (sel) => {
    if (sel === '#omnibar-input') return omnibarInput;
    if (sel === '#omnibar-clear') return omnibarClear;
    if (sel === '#omnibar-copy') return omnibarCopy;
    if (sel === '#omnibar-dropdown') return omnibarDropdown;
    return null;
  },
  getElementById: (id) => elements.get(id) || null,
  addEventListener: () => {},
};

globalThis.window = {
  matchMedia: () => ({ matches: false }),
};

const { updateClearButton, hideOmnibarSuggestions } = await import('../ui/js/views/omnibar.js');

test('omnibar clear button toggles based on input value', () => {
  omnibarInput.value = '';
  updateClearButton();
  assert.equal(omnibarClear.classList.contains('hidden'), true);

  omnibarInput.value = 'hello';
  updateClearButton();
  assert.equal(omnibarClear.classList.contains('hidden'), false);

  omnibarInput.value = '   ';
  updateClearButton();
  assert.equal(omnibarClear.classList.contains('hidden'), true);
});

test('hideOmnibarSuggestions adds hidden class to dropdown', () => {
  omnibarDropdown.classList.remove('hidden');
  hideOmnibarSuggestions();
  assert.equal(omnibarDropdown.classList.contains('hidden'), true);
});
