/** Slide-over panels: bookmarks, history, scratchpad, downloads. */

import { $, $$, escapeHtml, formatTime, formatBytes, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { displayUrl, monogram } from '../lib/url.js';
import { store, refreshBookmarks } from '../state/store.js';

const PANELS = ['bookmarks', 'history', 'scratchpad', 'downloads'];
const FOOTER_BTN = {
  bookmarks: '#btn-bookmarks-panel',
  history: '#btn-history-panel',
  scratchpad: '#btn-scratchpad',
  downloads: '#btn-downloads-panel',
};

export function isAnyPanelOpen() {
  return PANELS.some((name) => !$(`#panel-${name}`)?.classList.contains('hidden'));
}

export function closePanels() {
  for (const name of PANELS) $(`#panel-${name}`)?.classList.add('hidden');
  for (const sel of Object.values(FOOTER_BTN)) $(sel)?.classList.remove('active');
}

export async function openPanel(name, { onNavigate } = {}) {
  const panel = $(`#panel-${name}`);
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  closePanels();
  if (!willOpen) return; // toggle behavior

  panel.classList.remove('hidden');
  $(FOOTER_BTN[name])?.classList.add('active');

  if (name === 'bookmarks') await renderBookmarks();
  else if (name === 'history') await renderHistory();
  else if (name === 'scratchpad') await renderNotes();
  else if (name === 'downloads') await renderDownloads();

  // Navigation clicks inside the panel open in the active tab
  if (onNavigate) bindPanelNavigation(panel, onNavigate);
}

function bindPanelNavigation(panel, onNavigate) {
  panel.onclick = (e) => {
    const target = e.target.closest('[data-url]');
    const url = target?.getAttribute('data-url');
    if (url) {
      onNavigate(url);
      closePanels();
    }
  };
}

// ── Bookmarks ─────────────────────────────────────────────────────────
async function renderBookmarks(query = '') {
  const list = $('#bookmarks-list');
  if (!list) return;
  const q = query.trim().toLowerCase();
  const rows = store.bookmarks.filter(
    (b) => !q || b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)
  );
  list.innerHTML = rows.length === 0
    ? '<div class="empty-state"><svg class="icon" viewBox="0 0 24 24"><path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg><p>No bookmarks found.<br>Star a page from the address bar to save it.</p></div>'
    : rows.map((b) => `
      <div class="list-row" role="link" tabindex="0" data-url="${escapeHtml(b.url)}">
        <span class="tab-favicon">${escapeHtml(monogram(b.url))}</span>
        <div class="row-main">
          <div class="row-title">${escapeHtml(b.title)}</div>
          <div class="row-meta">${escapeHtml(displayUrl(b.url))}</div>
        </div>
        <button class="icon-btn ${b.is_favorite ? 'pin-active' : ''}" data-fav="${escapeHtml(b.id)}" title="${b.is_favorite ? 'Unfavorite' : 'Make favorite'}" aria-pressed="${b.is_favorite ? 'true' : 'false'}">
          <svg class="icon" viewBox="0 0 24 24" ${b.is_favorite ? 'fill="currentColor"' : ''} style="${b.is_favorite ? 'color:var(--zen-accent)' : ''}"><path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="icon-btn danger" data-del="${escapeHtml(b.id)}" title="Delete bookmark" aria-label="Delete bookmark">
          <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>`).join('');
}

// ── History ───────────────────────────────────────────────────────────
async function renderHistory(query = '') {
  const list = $('#history-list');
  if (!list) return;
  const rows = await api.searchHistory({ query, limit: 200 });
  list.innerHTML = rows.length === 0
    ? '<div class="empty-state"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><p>No history yet.<br>Pages you visit will be listed here — locally.</p></div>'
    : rows.map((h) => `
      <div class="list-row" role="link" tabindex="0" data-url="${escapeHtml(h.url)}">
        <span class="tab-favicon">${escapeHtml(monogram(h.url))}</span>
        <div class="row-main">
          <div class="row-title">${escapeHtml(h.title)}</div>
          <div class="row-meta">${escapeHtml(displayUrl(h.url))} · ${h.visit_count}× · ${formatTime(h.visited_at)}</div>
        </div>
        <button class="icon-btn danger" data-del-history="${escapeHtml(h.id)}" title="Remove from history" aria-label="Remove from history">
          <svg class="icon" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>`).join('');
}

// ── Notes ─────────────────────────────────────────────────────────────
async function renderNotes() {
  const list = $('#notes-list');
  if (!list) return;
  const notes = await api.listNotes({ workspace_id: store.activeWorkspaceId });
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

// ── Downloads ─────────────────────────────────────────────────────────
async function renderDownloads() {
  const list = $('#downloads-list');
  if (!list) return;
  const rows = await api.listDownloads();
  list.innerHTML = rows.length === 0
    ? '<div class="empty-state"><svg class="icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg><p>No downloads yet.</p></div>'
    : rows.map((d) => `
      <div class="list-row">
        <span class="tab-favicon" style="background:var(--zen-surface); color:var(--zen-sage-dark);"><svg class="icon sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>
        <div class="row-main">
          <div class="row-title">${escapeHtml(d.filename)}</div>
          <div class="row-meta">${escapeHtml(d.status)}${d.total_bytes ? ` · ${formatBytes(d.total_bytes)}` : ''} · ${formatTime(d.created_at)}</div>
        </div>
      </div>`).join('');
}

/** One-time wiring for panel interactions. */
export function wirePanels({ onNavigate }) {
  // Close buttons + backdrop-less dismissal
  $$('[data-close-panel]').forEach((btn) => btn.addEventListener('click', closePanels));

  // Bookmark row actions (favorite toggle / delete) — delegated, survives re-render
  $('#bookmarks-list')?.addEventListener('click', async (e) => {
    const fav = e.target.closest('[data-fav]')?.getAttribute('data-fav');
    const del = e.target.closest('[data-del]')?.getAttribute('data-del');
    if (fav) {
      await api.toggleFavorite({ bookmark_id: fav });
      await refreshBookmarks();
      await renderBookmarks($('#bookmarks-search')?.value ?? '');
      document.dispatchEvent(new CustomEvent('govind:bookmarks-changed'));
      return;
    }
    if (del) {
      await api.deleteBookmark({ bookmark_id: del });
      await refreshBookmarks();
      await renderBookmarks($('#bookmarks-search')?.value ?? '');
      document.dispatchEvent(new CustomEvent('govind:bookmarks-changed'));
      toast('Bookmark deleted.');
    }
  });
  $('#bookmarks-search')?.addEventListener('input', (e) => renderBookmarks(e.target.value));

  $('#history-list')?.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-history]')?.getAttribute('data-del-history');
    if (del) {
      e.stopPropagation();
      await api.deleteHistoryEntry({ history_id: del });
      await renderHistory($('#history-search')?.value ?? '');
      toast('History entry removed.');
    }
  });
  $('#history-search')?.addEventListener('input', (e) => renderHistory(e.target.value));
  $('#history-clear-all')?.addEventListener('click', async () => {
    const result = await api.clearBrowsingData({ categories: ['history'] });
    await renderHistory('');
    document.dispatchEvent(new CustomEvent('govind:history-changed'));
    toast(`Cleared ${result.history} history ${result.history === 1 ? 'entry' : 'entries'}.`);
  });

  $('#note-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#note-input');
    const content = input?.value.trim();
    if (!content) return;
    await api.saveNote({ content, workspace_id: store.activeWorkspaceId });
    input.value = '';
    await renderNotes();
    toast('Note saved locally.');
  });
  $('#notes-list')?.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-note]')?.getAttribute('data-del-note');
    if (del) {
      await api.deleteNote({ note_id: del });
      await renderNotes();
      toast('Note deleted.');
    }
  });

  $('#downloads-clear')?.addEventListener('click', async () => {
    const n = await api.clearDownloads();
    await renderDownloads();
    toast(`Cleared ${n} download ${n === 1 ? 'entry' : 'entries'}.`);
  });

  // Keyboard: Enter on focused rows triggers navigation
  for (const id of ['#bookmarks-list', '#history-list']) {
    $(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const url = e.target.closest('[data-url]')?.getAttribute('data-url');
        if (url) onNavigate(url);
      }
    });
  }
}
