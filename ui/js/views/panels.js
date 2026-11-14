/** Slide-over panels. Bookmarks, history, downloads and settings are full
 *  internal pages now (govind://bookmarks, /history, /downloads, /settings);
 *  only the scratchpad stays a panel. */

import { $, $$, escapeHtml, formatTime, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { store } from '../state/store.js';

const PANELS = ['scratchpad'];
const FOOTER_BTN = {
  scratchpad: '#btn-scratchpad',
};

export function isAnyPanelOpen() {
  return PANELS.some((name) => !$(`#panel-${name}`)?.classList.contains('hidden'));
}

export function closePanels() {
  for (const name of PANELS) $(`#panel-${name}`)?.classList.add('hidden');
  for (const sel of Object.values(FOOTER_BTN)) $(sel)?.classList.remove('active');
}

export async function openPanel(name) {
  const panel = $(`#panel-${name}`);
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  closePanels();
  if (!willOpen) return; // toggle behavior

  panel.classList.remove('hidden');
  $(FOOTER_BTN[name])?.classList.add('active');

  if (name === 'scratchpad') await renderNotes();
}

// ── Notes / scratchpad ────────────────────────────────────────────────
async function renderNotes() {
  const list = $('#notes-list');
  if (!list) return;
  const notes = await api.listNotes(store.activeWorkspaceId);
  list.innerHTML = notes.length === 0
    ? '<div class="empty-state"><svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg><p>Your scratchpad is empty.<br>Notes stay on this device.</p></div>'
    : notes.map((n) => `
      <div class="note-card">
        <div class="note-content">${escapeHtml(n.content)}</div>
        <div class="note-meta">
          <span>${formatTime(n.updated_at)}</span>
          <button class="icon-btn danger" data-del-note="${escapeHtml(n.id)}" title="Delete note" aria-label="Delete note">
            <svg class="icon sm" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>`).join('');
}

/** One-time wiring for panel interactions. */
export function wirePanels() {
  $$('[data-close-panel]').forEach((btn) => btn.addEventListener('click', closePanels));

  $('#note-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#note-input');
    const content = input?.value.trim();
    if (!content) return;
    await api.saveNote(content, store.activeWorkspaceId);
    input.value = '';
    await renderNotes();
    toast('Note saved locally.');
  });

  $('#notes-list')?.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-note]')?.getAttribute('data-del-note');
    if (del) {
      e.stopPropagation();
      await api.deleteNote(del);
      await renderNotes();
      toast('Note deleted.');
    }
  });
}
