/**
 * Omnibar enhancements: autocomplete suggestions dropdown, quick clear, and copy URL action.
 */

import { $, escapeHtml, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { displayUrl, searchEngineById, SEARCH_ENGINES } from '../lib/url.js';
import { store } from '../state/store.js';

let navigateCallback = null;
let selectedIndex = -1;
let currentSuggestions = [];
let blurTimeout = null;

const ICONS = {
  search: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
  tab: '<svg class="icon sm" viewBox="0 0 24 24"><rect width="16" height="13" x="4" y="5" rx="2"/><path d="M9 5V3M15 5V3"/></svg>',
  bookmark: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  history: '<svg class="icon sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  copy: '<svg class="icon sm" viewBox="0 0 24 24"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check: '<svg class="icon sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>',
};

export function initOmnibar({ onNavigate }) {
  navigateCallback = onNavigate;
  const input = $('#omnibar-input');
  const clearBtn = $('#omnibar-clear');
  const copyBtn = $('#omnibar-copy');
  const engineSelect = $('#omnibar-search-engine');
  const dropdown = $('#omnibar-dropdown');

  engineSelect?.addEventListener('change', async () => {
    const previous = store.settings.search_engine || 'duckduckgo';
    const next = engineSelect.value;
    store.settings.search_engine = next;
    try {
      await api.setSetting('search_engine', next);
      const name = SEARCH_ENGINES.find((engine) => engine.id === next)?.name ?? 'Custom';
      toast(`Search engine set to ${name}.`);
    } catch (error) {
      store.settings.search_engine = previous;
      engineSelect.value = previous;
      toast('Could not save the search engine setting.');
      console.error('Could not save the search engine setting.', error);
    }
  });

  input?.addEventListener('input', () => {
    updateClearButton();
    renderSuggestions(input.value);
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && currentSuggestions[selectedIndex]) {
        executeSuggestion(currentSuggestions[selectedIndex]);
      } else {
        const val = input.value.trim();
        if (val && navigateCallback) navigateCallback(val);
      }
      hideOmnibarSuggestions();
      input.blur();
    } else if (e.key === 'Escape') {
      hideOmnibarSuggestions();
      input.blur();
    }
  });

  input?.addEventListener('focus', () => {
    clearTimeout(blurTimeout);
    updateClearButton();
    input.select();
    if (input.value.trim()) renderSuggestions(input.value);
  });

  input?.addEventListener('blur', () => {
    blurTimeout = setTimeout(() => {
      hideOmnibarSuggestions();
    }, 200);
  });

  clearBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (input) {
      input.value = '';
      input.focus();
      updateClearButton();
      hideOmnibarSuggestions();
    }
  });

  copyBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const tab = store.activeTab();
    if (!tab || !tab.url) return;
    const ok = await api.copyText(tab.url);
    if (ok) {
      copyBtn.innerHTML = ICONS.check;
      copyBtn.classList.add('copied');
      toast('URL copied to clipboard.');
      setTimeout(() => {
        copyBtn.innerHTML = ICONS.copy;
        copyBtn.classList.remove('copied');
      }, 1500);
    } else {
      toast('Could not copy URL.');
    }
  });

  dropdown?.addEventListener('click', (e) => {
    const itemEl = e.target.closest('[data-sug-index]');
    if (!itemEl) return;
    const idx = Number(itemEl.getAttribute('data-sug-index'));
    if (idx >= 0 && currentSuggestions[idx]) {
      executeSuggestion(currentSuggestions[idx]);
      hideOmnibarSuggestions();
    }
  });

  dropdown?.addEventListener('mousemove', (e) => {
    const itemEl = e.target.closest('[data-sug-index]');
    if (!itemEl) return;
    const idx = Number(itemEl.getAttribute('data-sug-index'));
    if (idx !== selectedIndex) {
      selectedIndex = idx;
      highlightSelection();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#omnibar-container')) {
      hideOmnibarSuggestions();
    }
  });
}

export function updateClearButton() {
  const input = $('#omnibar-input');
  const clearBtn = $('#omnibar-clear');
  if (clearBtn && input) {
    clearBtn.classList.toggle('hidden', !input.value || input.value.trim().length === 0);
  }
}

export function hideOmnibarSuggestions() {
  const dropdown = $('#omnibar-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
  selectedIndex = -1;
  currentSuggestions = [];
}

async function renderSuggestions(raw) {
  const q = raw.trim();
  const dropdown = $('#omnibar-dropdown');
  if (!dropdown) return;

  if (!q || q.length === 0) {
    hideOmnibarSuggestions();
    return;
  }

  const qLower = q.toLowerCase();
  const list = [];

  // 1. Search Engine suggestion
  const engineId = store.settings.search_engine || 'duckduckgo';
  const engine = searchEngineById(engineId);
  list.push({
    type: 'search',
    icon: ICONS.search,
    title: q,
    subtitle: `Search ${engine.name}`,
    badge: 'Search',
    action: () => navigateCallback?.(q),
  });

  // 2. Open tabs match
  for (const tab of store.tabs) {
    if (tab.title?.toLowerCase().includes(qLower) || tab.url?.toLowerCase().includes(qLower)) {
      list.push({
        type: 'tab',
        icon: ICONS.tab,
        title: tab.title || tab.url,
        subtitle: displayUrl(tab.url),
        badge: 'Open Tab',
        action: () => document.dispatchEvent(new CustomEvent('govind:activate-tab', { detail: tab.id })),
      });
      if (list.length >= 6) break;
    }
  }

  // 3. Bookmarks match
  for (const b of store.bookmarks) {
    if (b.title?.toLowerCase().includes(qLower) || b.url?.toLowerCase().includes(qLower)) {
      list.push({
        type: 'bookmark',
        icon: ICONS.bookmark,
        title: b.title,
        subtitle: displayUrl(b.url),
        badge: 'Bookmark',
        action: () => navigateCallback?.(b.url),
      });
      if (list.length >= 7) break;
    }
  }

  // 4. History match
  try {
    const history = await api.searchHistory(q, 4);
    for (const h of history) {
      if (!list.some((item) => item.subtitle === displayUrl(h.url))) {
        list.push({
          type: 'history',
          icon: ICONS.history,
          title: h.title || h.url,
          subtitle: displayUrl(h.url),
          badge: 'History',
          action: () => navigateCallback?.(h.url),
        });
      }
      if (list.length >= 8) break;
    }
  } catch {
    /* history search unavailable in preview */
  }

  currentSuggestions = list;
  selectedIndex = -1;

  if (list.length === 0) {
    hideOmnibarSuggestions();
    return;
  }

  dropdown.innerHTML = list.map((item, i) => `
    <div class="sug-item" data-sug-index="${i}" role="option">
      <span class="sug-icon ${item.type}">${item.icon}</span>
      <div class="sug-text">
        <span class="sug-title">${escapeHtml(item.title)}</span>
        <span class="sug-sub">${escapeHtml(item.subtitle)}</span>
      </div>
      <span class="sug-badge">${escapeHtml(item.badge)}</span>
    </div>
  `).join('');

  dropdown.classList.remove('hidden');
}

function moveSelection(direction) {
  if (currentSuggestions.length === 0) return;
  selectedIndex += direction;
  if (selectedIndex < 0) selectedIndex = currentSuggestions.length - 1;
  if (selectedIndex >= currentSuggestions.length) selectedIndex = 0;
  highlightSelection();
}

function highlightSelection() {
  const dropdown = $('#omnibar-dropdown');
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.sug-item');
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === selectedIndex);
    if (i === selectedIndex) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
}

function executeSuggestion(item) {
  if (item?.action) {
    item.action();
  }
}
