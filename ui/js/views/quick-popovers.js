/**
 * Anchored quick panels, Chrome-style: a small popover with the latest items
 * and a link to the full internal page. Nothing here mutates data directly —
 * it reuses the same commands and events as the pages.
 */

import { $, escapeHtml, formatBytes, formatTime, toast } from '../lib/dom.js';
import { displayUrl } from '../lib/url.js';
import * as api from '../services/ipc.js';
import { store } from '../state/store.js';

const TITLES = {
  downloads: 'Downloads',
  history: 'History',
  bookmarks: 'Bookmarks',
  media: 'Media controls',
  print: 'Print',
};
const FULL_PAGE = {
  downloads: 'downloads',
  history: 'history',
  bookmarks: 'bookmarks',
  media: 'media-controls',
};

let activeKind = null;
let activeAnchor = null;

export function closeQuick() {
  $('#quick-popover')?.classList.add('hidden');
  activeKind = null;
}

function position(anchor) {
  const popover = $('#quick-popover');
  if (!popover) return;
  const rect = anchor?.getBoundingClientRect?.();
  // Never wider than the window: the panel is a fixed 360px on desktop, but at
  // narrow (or phone-sized) widths it shrinks with the viewport instead of
  // overflowing it.
  const width = Math.min(360, window.innerWidth - 24);
  popover.style.width = `${width}px`;
  const left = rect
    ? Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
    : Math.max(12, window.innerWidth - width - 20);
  const height = popover.offsetHeight || 320;
  const top = rect
    ? Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 12))
    : 76;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

const row = (title, meta, attrs = {}) => `
  <button class="quick-row" ${Object.entries(attrs).map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(' ')}>
    <span class="quick-row-title">${escapeHtml(title)}</span>
    <span class="quick-row-meta">${escapeHtml(meta)}</span>
  </button>`;

function empty(message) {
  return `<div class="quick-empty">${escapeHtml(message)}</div>`;
}

function footer(kind, extra = '') {
  const foot = $('#quick-foot');
  if (!foot) return;
  foot.innerHTML = `${extra}${
    FULL_PAGE[kind]
      ? `<button class="linklike" data-open-page="${FULL_PAGE[kind]}">Open ${TITLES[kind].toLowerCase()} page →</button>`
      : ''
  }`;
}

async function renderDownloads() {
  const items = (await api.listDownloads().catch(() => [])) ?? [];
  const body = $('#quick-body');
  body.innerHTML = items.length
    ? items.slice(0, 6).map((item) => row(
      item.filename,
      [item.status, formatBytes(item.received_bytes ?? item.total_bytes)].filter(Boolean).join(' · '),
    )).join('')
    : empty('No downloads yet.');
  footer('downloads');
}

async function renderHistory() {
  const items = (await api.searchHistory('', 8).catch(() => [])) ?? [];
  const body = $('#quick-body');
  body.innerHTML = items.length
    ? items.map((item) => row(item.title || item.url, `${displayUrl(item.url)} · ${formatTime(item.visited_at)}`, {
      'data-quick-url': item.url,
    })).join('')
    : empty('Nothing in history yet.');
  footer('history');
}

async function renderBookmarks() {
  const items = (await api.listBookmarks().catch(() => [])) ?? [];
  const body = $('#quick-body');
  body.innerHTML = items.length
    ? items.slice(0, 8).map((item) => row(item.title || item.url, displayUrl(item.url), {
      'data-quick-url': item.url,
    })).join('')
    : empty('No bookmarks yet.');
  footer('bookmarks');
}

function renderMedia() {
  const body = $('#quick-body');
  const tabs = store.tabs.filter((tab) => !store.isInternalTab(tab));
  const rows = tabs.map((tab) => {
    const audio = store.audioStates.get(tab.id) ?? { playing: false, muted: false };
    const state = audio.playing ? (audio.muted ? 'playing · muted' : 'playing') : 'not playing';
    return `
      <div class="quick-media-row">
        <span class="quick-media-text">
          <span class="quick-row-title">${escapeHtml(tab.title || tab.url)}</span>
          <span class="quick-row-meta">${escapeHtml(displayUrl(tab.url))} · ${escapeHtml(state)}</span>
        </span>
        <button class="icon-btn" data-quick-media="toggle" data-quick-tab="${escapeHtml(tab.id)}"
          title="Play / pause" aria-label="Play or pause ${escapeHtml(tab.title || tab.url)}">
          <svg class="icon sm" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>
        </button>
        <button class="icon-btn" data-quick-media="mute" data-quick-tab="${escapeHtml(tab.id)}"
          title="${audio.muted ? 'Unmute' : 'Mute'}" aria-label="${audio.muted ? 'Unmute' : 'Mute'} tab">
          <svg class="icon sm" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15 9a5 5 0 0 1 0 6"/></svg>
        </button>
      </div>`;
  });
  body.innerHTML = rows.length ? rows.join('') : empty('No tabs with media.');
  footer('media');
}

function renderPrint() {
  const tab = store.activeTab();
  const body = $('#quick-body');
  body.innerHTML = `
    <div class="quick-print">
      <p>${tab && !store.isInternalTab(tab)
        ? `Print or save <strong>${escapeHtml(tab.title || tab.url)}</strong>.`
        : 'Open a website first — internal pages are not printable.'}</p>
      <button class="btn-primary" data-quick-print="print">Print…</button>
      <button class="btn-secondary" data-quick-print="pdf">Save as PDF…</button>
      <span class="quick-hint">Ctrl + P opens this panel on any page.</span>
    </div>`;
  footer('print');
}

export async function openQuick(kind, anchor) {
  const popover = $('#quick-popover');
  if (!popover) return;
  if (activeKind === kind && !popover.classList.contains('hidden')) {
    closeQuick();
    return;
  }
  $('#profile-popover')?.classList.add('hidden');
  activeKind = kind;
  activeAnchor = anchor ?? null;
  popover.classList.remove('hidden');
  position(anchor);
  $('#quick-title').textContent = TITLES[kind] ?? 'Panel';
  $('#quick-body').innerHTML = empty('Loading…');
  $('#quick-foot').innerHTML = '';
  if (kind === 'downloads') await renderDownloads();
  else if (kind === 'history') await renderHistory();
  else if (kind === 'bookmarks') await renderBookmarks();
  else if (kind === 'media') renderMedia();
  else renderPrint();
}

async function printActive() {
  if (api.isNative()) {
    await api.printTab(store.activeTabId).catch((error) => toast(`Print failed: ${error?.message ?? error}`));
  } else {
    window.print();
  }
  closeQuick();
}

export function initQuickPopovers() {
  $('#quick-close')?.addEventListener('click', closeQuick);

  document.addEventListener('click', (event) => {
    if (event.target.closest('#quick-popover')) return;
    // The button that opened the panel must not immediately close it again.
    if (activeAnchor && activeAnchor.contains(event.target)) return;
    closeQuick();
  });

  $('#quick-popover')?.addEventListener('click', (event) => {
    const url = event.target.closest('[data-quick-url]')?.getAttribute('data-quick-url');
    if (url) {
      closeQuick();
      document.dispatchEvent(new CustomEvent('govind:navigate', { detail: url }));
      return;
    }
    const page = event.target.closest('[data-open-page]')?.getAttribute('data-open-page');
    if (page) {
      closeQuick();
      document.dispatchEvent(new CustomEvent('govind:open-internal', { detail: page }));
      return;
    }
    const mediaButton = event.target.closest('[data-quick-media]');
    if (mediaButton) {
      const tabId = mediaButton.getAttribute('data-quick-tab');
      if (mediaButton.getAttribute('data-quick-media') === 'mute') {
        document.dispatchEvent(new CustomEvent('govind:mute-tab', { detail: tabId }));
      } else {
        api.controlTabMedia(tabId).catch((error) => toast(`${error?.message ?? error}`));
      }
      return;
    }
    const printKind = event.target.closest('[data-quick-print]')?.getAttribute('data-quick-print');
    if (printKind) printActive();
  });
}
