/**
 * Govind Browser — address-bar input normalization.
 * Pure functions, no DOM. Unit-tested with node:test (tests/url.test.mjs).
 *
 * Rules:
 *  - empty input            → null
 *  - explicit allowed scheme → kept as-is (https, http, govind, about, file blocked)
 *  - domain-like string     → https:// (or http:// for localhost / IPs), https-upgraded by caller if setting enabled
 *  - anything else          → search engine URL with the query
 */

export const SEARCH_ENGINES = [
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=' },
];

export const DEFAULT_SEARCH_ENGINE = 'duckduckgo';
export const HOME_URL = 'govind://home';

const SCHEME_ALLOWLIST = new Set(['https:', 'http:']);

/** Is this an IP literal (v4/v6) or localhost-style host? (brackets optional) */
function isLocalHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    h === '::1' ||
    h === '0.0.0.0'
  );
}

/** Domain-like: no spaces, has at least one dot, valid labels, optional port and path. */
function looksLikeDomain(s) {
  if (/\s/.test(s)) return false;
  const m = s.match(/^([a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?(\/\S*)?$/i);
  if (!m) return false;
  // TLD must be at least 2 alpha chars
  const host = m[1];
  const tld = host.split('.').pop();
  return /^[a-z]{2,}$/i.test(tld);
}

function looksLikeLocalhost(s) {
  return /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\])(:\d{1,5})?(\/\S*)?$/i.test(s);
}

export function searchEngineById(id) {
  return SEARCH_ENGINES.find((e) => e.id === id) || SEARCH_ENGINES[0];
}

/**
 * Normalize raw omnibar input into a navigation target.
 * @param {string} raw
 * @param {{searchEngine?: string, httpsFirst?: boolean}} opts
 * @returns {{type: 'url'|'search', url: string, query?: string} | null}
 */
export function normalizeInput(raw, opts = {}) {
  const input = String(raw ?? '').trim();
  if (!input) return null;

  // Explicit govind:// internal route (only the home page exists)
  if (/^govind:\/\//i.test(input)) {
    const route = input.slice('govind://'.length).replace(/\/+$/, '').toLowerCase() || 'home';
    return { type: 'url', url: `govind://${route}` };
  }

  // Explicit scheme? Schemes practically never contain dots — excluding
  // '.' keeps "sub.domain.co.uk:8443/x" from parsing as scheme "sub.domain.co.uk".
  const schemeMatch = input.match(/^([a-z][a-z0-9+-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (SCHEME_ALLOWLIST.has(`${scheme}:`)) {
      let url = input;
      // https-first upgrade for cleartext http URLs (never downgrade)
      const bareHost = (hostOf(input) ?? '').replace(/:\d{1,5}$/, '').replace(/^\[|\]$/g, '');
      if (opts.httpsFirst !== false && scheme === 'http' && !isLocalHost(bareHost)) {
        url = 'https://' + input.slice(input.indexOf(':') + 3);
      }
      return { type: 'url', url };
    }
    if (scheme === 'about' && input.toLowerCase() === 'about:blank') {
      return { type: 'url', url: 'about:blank' };
    }
    // Unknown scheme: it may actually be "host:port" (e.g. localhost:3000)
    if (looksLikeLocalhost(input)) return { type: 'url', url: `http://${input}` };
    if (looksLikeDomain(input)) return { type: 'url', url: `https://${input}` };
    // Anything else (javascript:, data:, mailto:, …) → treat as search, never navigate
    return search(input, opts);
  }

  // localhost / IPs → http by default (typical dev servers)
  if (looksLikeLocalhost(input)) {
    return { type: 'url', url: `http://${input}` };
  }

  // Bare domain-like input → https
  if (looksLikeDomain(input)) {
    return { type: 'url', url: `https://${input}` };
  }

  return search(input, opts);
}

function search(query, opts) {
  const engine = searchEngineById(opts.searchEngine || DEFAULT_SEARCH_ENGINE);
  return { type: 'search', url: engine.url + encodeURIComponent(query), query };
}

/** Extract the host from an absolute http(s) URL, or null. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Origin (scheme://host) of an absolute http(s) URL, or null. */
export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Scheme of a URL, lowercased, or null. */
export function schemeOf(url) {
  const m = String(url ?? '').match(/^([a-z][a-z0-9+-]*):/i);
  return m ? m[1].toLowerCase() : null;
}

/** Human display form for the omnibar (trims https://, trailing slash). */
export function displayUrl(url) {
  if (!url) return '';
  if (url === HOME_URL || url === 'govind://home') return '';
  return url.replace(/^https:\/\//, '').replace(/\/$/, '');
}

/** favicon letter for monogram rendering */
export function monogram(url) {
  const h = hostOf(url) ?? (url === HOME_URL ? 'govind' : url);
  const clean = h.replace(/^www\./, '');
  return (clean?.[0] || '?').toUpperCase();
}
