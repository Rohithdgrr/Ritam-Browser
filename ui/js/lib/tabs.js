/**
 * Pure tab helpers — grouping suggestions, duplicate detection, sleep
 * candidates. Kept out of the store so they can be unit-tested without the app.
 */

import { HOME_URL } from './url.js';

/** Fixed first tab in every workspace; mirrored by `navigation::AI_URL` in Rust. */
export const AI_TAB_URL = 'govind://ai';

export function isAiTab(tab) {
  return tab?.url === AI_TAB_URL;
}

/** `example.com` for http(s) pages, `null` for internal pages and blank tabs. */
export function siteKey(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Sites with `min` or more loose (ungrouped, unpinned) tabs — newest wins. */
export function tabGroupSuggestions(tabs, { min = 3, limit = 2 } = {}) {
  const counts = new Map();
  for (const tab of tabs) {
    if (tab.is_private || tab.is_pinned || tab.group_name) continue;
    const site = siteKey(tab.url);
    if (!site) continue;
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([site, count]) => ({ site, count }));
}

/** Tabs that load the same web page (start-page and internal tabs excluded). */
export function duplicateTabGroups(tabs) {
  const byUrl = new Map();
  for (const tab of tabs) {
    if (tab.is_private || !tab.url || tab.url === HOME_URL || !siteKey(tab.url)) continue;
    if (!byUrl.has(tab.url)) byUrl.set(tab.url, []);
    byUrl.get(tab.url).push(tab);
  }
  return [...byUrl.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => b.length - a.length);
}

/**
 * Tabs that have been idle longer than `minutes` and can be suspended: never the
 * active tab, a private tab, a pinned tab, a playing tab or an internal page.
 */
export function sleepCandidates(tabs, {
  activeTabId = null,
  sleeping = new Set(),
  audioPlaying = new Set(),
  minutes = 0,
  now = Date.now(),
} = {}) {
  if (!Number.isFinite(minutes) || minutes <= 0) return [];
  const cutoff = now - minutes * 60_000;
  return tabs
    .filter((tab) => {
      const lastActive = Number(tab.last_active_at ?? 0);
      return tab.id !== activeTabId
        && !tab.is_private
        && !tab.is_pinned
        && !sleeping.has(tab.id)
        && !audioPlaying.has(tab.id)
        && !String(tab.url ?? '').startsWith('govind://')
        && lastActive > 0
        && lastActive <= cutoff;
    })
    .map((tab) => tab.id);
}
