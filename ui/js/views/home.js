/** Home / start page rendering. */

import { $, escapeHtml, greeting, formatTime } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { displayUrl, HOME_URL, monogram } from '../lib/url.js';
import { store, refreshBookmarks } from '../state/store.js';
import { toast } from '../lib/dom.js';

export async function renderHome() {
  // Greeting
  const greet = $('#home-greeting');
  if (greet) greet.textContent = greeting();

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
  if (recentWrap) {
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

  // Footer stats
  const stats = $('#home-stats');
  if (stats) stats.textContent = `${store.tabs.length} tab${store.tabs.length === 1 ? '' : 's'} · ${store.bookmarks.length} bookmark${store.bookmarks.length === 1 ? '' : 's'}`;

  // Welcome kit fallback URL recorded via IPC (kept in sync with assets file)
  void HOME_URL;
}

/** Wire one-time event handlers for the home view. */
export function wireHome({ onNavigate, onOpenPanel }) {
  $('#home-search-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#home-search-input');
    const value = input?.value.trim();
    if (value) onNavigate(value);
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
