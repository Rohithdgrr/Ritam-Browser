/**
 * Custom keyboard shortcut parsing and matching.
 *
 * Combos are stored the way they are shown: `Ctrl+Shift+K`, `Alt+Left`.
 * The backend validates the same shape, so both sides agree on what is legal.
 */

export const SHORTCUT_ACTIONS = [
  { id: 'new-tab', label: 'New tab' },
  { id: 'close-tab', label: 'Close tab' },
  { id: 'split-view', label: 'Split view' },
  { id: 'undo-close', label: 'Reopen closed tab' },
  { id: 'find', label: 'Find in page' },
  { id: 'reader-mode', label: 'Reader mode' },
  { id: 'focus-omnibar', label: 'Focus address bar' },
  { id: 'reload', label: 'Reload page' },
  { id: 'downloads', label: 'Open downloads' },
  { id: 'bookmark', label: 'Bookmark this page' },
  { id: 'settings', label: 'Open settings' },
  { id: 'history', label: 'Open history' },
  { id: 'statistics', label: 'Open statistics' },
  { id: 'tab-search', label: 'Search tabs' },
  { id: 'palette', label: 'Command palette' },
  { id: 'autofill', label: 'Fill this form' },
  { id: 'mute-tab', label: 'Mute tab' },
  { id: 'print', label: 'Print page' },
  { id: 'fullscreen', label: 'Fullscreen' },
  { id: 'next-tab', label: 'Next tab' },
  { id: 'prev-tab', label: 'Previous tab' },
  { id: 'zoom-in', label: 'Zoom in' },
  { id: 'zoom-out', label: 'Zoom out' },
  { id: 'zoom-reset', label: 'Reset zoom' },
];

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];

/**
 * Built-in combos, shown in Settings so a custom combo is a visible override.
 * Keep this in sync with `SHORTCUTS` in `src-tauri/src/lib.rs`.
 */
export const DEFAULT_SHORTCUTS = {
  'new-tab': 'Ctrl+T',
  'close-tab': 'Ctrl+W',
  'bookmark': 'Ctrl+D',
  'undo-close': 'Ctrl+Shift+T',
  'find': 'Ctrl+F',
  'focus-omnibar': 'Ctrl+L',
  'reload': 'Ctrl+R',
  'print': 'Ctrl+P',
  'palette': 'Ctrl+K',
  'tab-search': 'Ctrl+Shift+A',
  'settings': 'Ctrl+,',
  'history': 'Ctrl+H',
  'downloads': 'Ctrl+J',
  'autofill': 'Ctrl+Shift+L',
  'mute-tab': 'Alt+Shift+M',
  'next-tab': 'Ctrl+Tab',
  'prev-tab': 'Ctrl+Shift+Tab',
};

/** A letter/number (up to three characters) or one printable symbol key. */
function keyAllowed(key) {
  if (!key) return false;
  if (key.length === 1) return !/\s/.test(key) && key !== '+';
  return /^[a-z0-9]{1,3}$/i.test(key);
}

/** Parse `Ctrl+Shift+K` into its parts, or `null` when the combo is malformed. */
export function parseShortcut(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 40) return null;
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1];
  if (!keyAllowed(key)) return null;
  const modifiers = parts.slice(0, -1);
  if (!modifiers.every((modifier) => MODIFIERS.includes(modifier))) return null;
  return {
    ctrl: modifiers.includes('Ctrl'),
    alt: modifiers.includes('Alt'),
    shift: modifiers.includes('Shift'),
    meta: modifiers.includes('Meta'),
    key: key.toLowerCase(),
  };
}

/** Does a keyboard event trigger this combo? Modifiers must match exactly. */
export function matchesShortcut(event, combo) {
  const parsed = parseShortcut(combo);
  if (!parsed) return false;
  return event.ctrlKey === parsed.ctrl
    && event.altKey === parsed.alt
    && event.shiftKey === parsed.shift
    && event.metaKey === parsed.meta
    && String(event.key ?? '').toLowerCase() === parsed.key;
}

/** A combo string for a keydown event, used by the settings recorder. */
export function shortcutFromEvent(event) {
  const key = String(event.key ?? '');
  if (!key || key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  const label = key.length === 1 ? key.toUpperCase() : key.replace(/^Arrow/, '');
  return parseShortcut([...parts, label].join('+')) ? [...parts, label].join('+') : '';
}
