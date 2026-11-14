/** Command palette (Ctrl+K). Commands are injected by main.js; data sources are queried live. */

import { $, escapeHtml } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { displayUrl } from '../lib/url.js';
import { store } from '../state/store.js';

let injectedCommands = [];
let items = [];
let selected = 0;

export function initPalette(commands) {
  injectedCommands = commands;
  $('#palette-input')?.addEventListener('input', (e) => render(e.target.value));
  $('#palette-input')?.addEventListener('keydown', onKeydown);
  $('#palette-results')?.addEventListener('click', (e) => {
    const idx = Number(e.target.closest('[data-index]')?.getAttribute('data-index'));
    if (Number.isFinite(idx)) runItem(idx);
  });
  $('#command-palette')?.addEventListener('click', (e) => {
    if (e.target.id === 'command-palette') closePalette();
  });
}

export function isPaletteOpen() {
  return !$('#command-palette')?.classList.contains('hidden');
}

export async function openPalette() {
  const modal = $('#command-palette');
  if (!modal) return;
  modal.classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  await render('');
  input.focus();
}

export function closePalette() {
  $('#command-palette')?.classList.add('hidden');
}

const ICONS = {
  command: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M4 17l6-6-6-6M12 19h8"/></svg>',
  tab: '<svg class="icon sm" viewBox="0 0 24 24"><rect width="16" height="13" x="4" y="5" rx="2"/><path d="M9 5V3M15 5V3"/></svg>',
  bookmark: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  history: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

async function render(query) {
  const q = query.trim().toLowerCase();
  items = [];

  const push = (group, icon, title, hint, run) => items.push({ group, icon, title, hint, run });

  // 1) Commands
  for (const cmd of injectedCommands) {
    if (!q || cmd.title.toLowerCase().includes(q) || (cmd.keywords ?? []).some((k) => k.includes(q))) {
      push('Commands', ICONS.command, cmd.title, cmd.hint ?? '', cmd.run);
    }
  }

  // 2) Open tabs
  for (const tab of store.tabs) {
    if (!q || tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q)) {
      push('Open Tabs', ICONS.tab, tab.title, 'Switch to tab', () => document.dispatchEvent(new CustomEvent('govind:activate-tab', { detail: tab.id })));
    }
  }

  // 3) Bookmarks
  const bookmarks = store.bookmarks.filter((b) => !q || b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)).slice(0, 8);
  for (const b of bookmarks) {
    push('Bookmarks', ICONS.bookmark, b.title, displayUrl(b.url), () => document.dispatchEvent(new CustomEvent('govind:navigate', { detail: b.url })));
  }

  // 4) History
  try {
    const history = await api.searchHistory(q, q ? 8 : 5);
    for (const h of history) {
      push('History', ICONS.history, h.title, displayUrl(h.url), () => document.dispatchEvent(new CustomEvent('govind:navigate', { detail: h.url })));
    }
  } catch { /* history unavailable — skip */ }

  selected = 0;
  paint();
}

function paint() {
  const wrap = $('#palette-results');
  if (!wrap) return;
  if (items.length === 0) {
    wrap.innerHTML = '<p class="fav-empty" style="padding:24px; text-align:center;">Nothing matches. Try a different query.</p>';
    return;
  }
  let html = '';
  let lastGroup = null;
  items.forEach((item, index) => {
    if (item.group !== lastGroup) {
      html += `<div class="palette-group">${escapeHtml(item.group)}</div>`;
      lastGroup = item.group;
    }
    html += `
      <div class="palette-item ${index === selected ? 'selected' : ''}" role="option" data-index="${index}" aria-selected="${index === selected}">
        ${item.icon}
        <span class="p-title">${escapeHtml(item.title)}</span>
        <span class="p-hint">${escapeHtml(item.hint)}</span>
      </div>`;
  });
  wrap.innerHTML = html;
}

function onKeydown(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(items.length - 1, selected + 1); paint(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); paint(); }
  else if (e.key === 'Enter') { e.preventDefault(); runItem(selected); }
}

async function runItem(index) {
  const item = items[index];
  if (!item) return;
  closePalette();
  try { await item.run(); } catch (err) { console.error(err); }
}
