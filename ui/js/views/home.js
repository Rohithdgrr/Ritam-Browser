/** Home / start page rendering. */

import { $, escapeHtml, greeting, formatTime, localDay, startOfLocalDay } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { displayUrl, HOME_URL, monogram } from '../lib/url.js';
import { store, refreshBookmarks } from '../state/store.js';
import { toast } from '../lib/dom.js';

export async function renderHome() {
  const isPrivate = store.activeTab()?.is_private;
  $('#view-home')?.classList.toggle('private-mode', !!isPrivate);
  // Greeting
  const greet = $('#home-greeting');
  if (greet) greet.textContent = greeting();
  const eyebrow = $('#home-eyebrow-label');
  if (eyebrow) eyebrow.textContent = isPrivate ? 'Private browsing' : 'Ritam Browser';
  $('#private-home-icon')?.classList.toggle('hidden', !isPrivate);
  const subtitle = $('.home-sub');
  if (subtitle) {
    subtitle.textContent = isPrivate
      ? 'This tab uses temporary browser storage. Browsing history and downloads are not saved; downloaded files remain on your device.'
      : 'A fast, calm place for the web — your data stays on this machine.';
  }

  await renderDashboard(isPrivate);

  // Favorites grid
  const favWrap = $('#home-favorites');
  const favorites = store.bookmarks.filter((b) => b.is_favorite);
  if (favWrap) {
    if (favorites.length === 0) {
      favWrap.innerHTML = '<p class="fav-empty" style="grid-column: 1/-1;">No favorites yet. Bookmark a page and mark it as a favorite to pin it here.</p>';
    } else {
      favWrap.innerHTML = favorites.map((b) => `
        <div class="home-fav" data-url="${escapeHtml(b.url)}" role="link" tabindex="0" aria-label="Open ${escapeHtml(b.title)}">
          <button class="fav-remove" data-remove="${escapeHtml(b.id)}" title="Remove favorite" aria-label="Remove ${escapeHtml(b.title)}">
            <svg class="icon sm" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
          <div class="fav-icon">${escapeHtml(monogram(b.url))}</div>
          <div class="fav-name">${escapeHtml(b.title.slice(0, 24))}</div>
        </div>`).join('');
    }
  }

  // Recent history
  const recentWrap = $('#home-recent');
  const recentSection = recentWrap?.closest('.home-section');
  recentSection?.classList.toggle('hidden', !!isPrivate);
  $('#btn-view-all-history')?.classList.toggle('hidden', !!isPrivate);
  if (recentWrap) {
    if (isPrivate) {
      recentWrap.innerHTML = '';
    } else {
      const recent = await api.searchHistory('', 6);
      recentWrap.innerHTML = recent.length === 0
        ? '<p class="fav-empty">Pages you visit will appear here.</p>'
        : recent.map((h) => `
          <button class="recent-item" data-url="${escapeHtml(h.url)}">
            <span class="tab-favicon">${escapeHtml(monogram(h.url))}</span>
            <span style="flex:1; min-width:0;">
              <span class="r-title" style="display:block;">${escapeHtml(h.title)}</span>
              <span class="r-url">${escapeHtml(displayUrl(h.url))}</span>
            </span>
            <time>${formatTime(h.visited_at)}</time>
          </button>`).join('');
    }
  }

  // Footer stats
  const stats = $('#home-stats');
  if (stats) stats.textContent = `${store.tabs.length} tab${store.tabs.length === 1 ? '' : 's'} · ${store.bookmarks.length} bookmark${store.bookmarks.length === 1 ? '' : 's'}`;

  // Welcome kit fallback URL recorded via IPC (kept in sync with assets file)
  void HOME_URL;
}

function settingJson(raw, fallback) {
  try {
    const parsed = JSON.parse(raw ?? '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** Clock, today's browsing time and the user's website shortcuts. */
async function renderDashboard(isPrivate) {
  const host = $('#home-dashboard');
  if (!host) return;
  if (isPrivate) {
    host.innerHTML = '';
    host.classList.add('hidden');
    return;
  }
  const widgets = new Set(settingJson(store.settings.dashboard_widgets, ['clock', 'shortcuts', 'time']));
  const shortcuts = settingJson(store.settings.website_shortcuts, []);
  const parts = [];

  if (widgets.has('clock')) {
    parts.push(`<div class="home-widget"><span class="widget-label">Now</span><strong id="home-clock">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong></div>`);
  }
  if (widgets.has('time')) {
    let minutes = 0;
    try {
      const stats = await api.siteTimeSummary(1, localDay(), startOfLocalDay(0));
      minutes = Math.round((stats.total_seconds ?? 0) / 60);
    } catch { /* preview mode */ }
    parts.push(`<div class="home-widget"><span class="widget-label">Today</span><strong>${minutes ? `${minutes}m` : '—'}</strong></div>`);
  }
  if (widgets.has('shortcuts') && Array.isArray(shortcuts) && shortcuts.length) {
    parts.push(`<div class="home-widget wide"><span class="widget-label">Shortcuts</span><div class="home-shortcut-row">${shortcuts.map((shortcut) => `
      <button class="quick-chip" data-shortcut-url="${escapeHtml(shortcut.url)}" title="${escapeHtml(shortcut.url)}">${escapeHtml(shortcut.title)}</button>`).join('')}</div></div>`);
  }

  host.innerHTML = parts.join('');
  host.classList.toggle('hidden', parts.length === 0);
}

/** Wire one-time event handlers for the home view. */
export function wireHome({ onNavigate, onOpenPanel }) {
  const searchInput = $('#home-search-input');
  const searchClear = $('#home-search-clear');

  searchInput?.addEventListener('input', () => {
    if (searchClear) {
      searchClear.classList.toggle('hidden', !searchInput.value || searchInput.value.trim().length === 0);
    }
  });

  searchClear?.addEventListener('click', () => {
    if (searchInput) {
      searchInput.value = '';
      searchClear.classList.add('hidden');
      searchInput.focus();
    }
  });

  $('#home-search-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = searchInput?.value.trim();
    if (value) onNavigate(value);
  });

  // Quick navigation chips
  document.querySelector('.home-quick-chips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-quick-action]');
    if (!chip) return;
    const action = chip.getAttribute('data-quick-action');
    if (action === 'scratchpad') {
      onOpenPanel?.('scratchpad');
    } else if (action) {
      document.dispatchEvent(new CustomEvent('govind:open-internal', { detail: action }));
    }
  });

  $('#home-favorites')?.addEventListener('click', async (e) => {
    const removeId = e.target.closest('[data-remove]')?.getAttribute('data-remove');
    if (removeId) {
      e.stopPropagation();
      await api.deleteBookmark(removeId);
      await refreshBookmarks();
      await renderHome();
      toast('Favorite removed.');
      return;
    }
    const card = e.target.closest('[data-url]');
    const url = card?.getAttribute('data-url');
    if (url) onNavigate(url);
  });
  $('#home-favorites')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = e.target.closest('[data-url]')?.getAttribute('data-url');
      if (url) onNavigate(url);
    }
  });

  $('#home-recent')?.addEventListener('click', (e) => {
    const url = e.target.closest('[data-url]')?.getAttribute('data-url');
    if (url) onNavigate(url);
  });

  $('#home-dashboard')?.addEventListener('click', (e) => {
    const url = e.target.closest('[data-shortcut-url]')?.getAttribute('data-shortcut-url');
    if (url) onNavigate(url);
  });

  // The clock only needs minute precision; update it while the app is open.
  setInterval(() => {
    const clock = $('#home-clock');
    if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, 30_000);

  $('#home-download-kit')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = 'assets/govind-welcome.txt';
    a.download = 'govind-welcome.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    api.recordDownload({ url: 'govind://assets/govind-welcome.txt', filename: 'govind-welcome.txt', mimeType: 'text/plain' }).catch(() => {});
    toast('Welcome kit downloading — see Downloads.');
  });

  $('#btn-manage-favorites')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('govind:open-internal', { detail: 'bookmarks' }));
  });
  $('#btn-view-all-history')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('govind:open-internal', { detail: 'history' }));
  });
}
