/**
 * Pure helpers for the developer workbench (`govind://inspector`).
 *
 * Requests arrive from the page instrumentation as plain objects:
 * `{ id, kind, method, url, status, duration_ms, request_headers, ... }`.
 * Everything here is formatting/filtering only — no network calls.
 */

/** Normalise a header list (also accepts a plain object) into pairs. */
export function headerPairs(headers) {
  const out = [];
  if (!headers) return out;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!entry) continue;
      const name = String(entry.name ?? entry[0] ?? '').trim();
      if (!name) continue;
      out.push({ name, value: String(entry.value ?? entry[1] ?? '') });
    }
    return out;
  }
  if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) {
      if (!name) continue;
      out.push({ name, value: String(value) });
    }
  }
  return out;
}

/** Headers as an object for the Fetch export. */
export function headersObject(headers) {
  const out = {};
  for (const header of headerPairs(headers)) out[header.name] = header.value;
  return out;
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/** A ready-to-paste cURL command for one captured request. */
export function toCurl(request) {
  const method = String(request?.method || 'GET').toUpperCase();
  const url = String(request?.url ?? '');
  const lines = [`curl ${shellQuote(url)}`];
  if (method !== 'GET') lines.push(`--request ${method}`);
  for (const header of headerPairs(request?.request_headers)) {
    lines.push(`--header ${shellQuote(`${header.name}: ${header.value}`)}`);
  }
  const body = String(request?.request_body ?? '');
  if (body) lines.push(`--data-raw ${shellQuote(body)}`);
  return lines.join(' \\\n  ');
}

/** A ready-to-paste JavaScript fetch call for one captured request. */
export function toFetch(request) {
  const method = String(request?.method || 'GET').toUpperCase();
  const init = { method };
  const headers = headersObject(request?.request_headers);
  if (Object.keys(headers).length) init.headers = headers;
  const body = String(request?.request_body ?? '');
  if (body && method !== 'GET' && method !== 'HEAD') init.body = body;
  return `fetch(${JSON.stringify(String(request?.url ?? ''))}, ${JSON.stringify(init, null, 2)})`;
}

/**
 * Pretty-print a response body when it is JSON. Everything else is returned
 * unchanged so the viewer never invents a structure that was not there.
 */
export function prettyBody(body, contentType = '') {
  const raw = String(body ?? '');
  if (!raw.trim()) return '';
  const type = String(contentType ?? '').toLowerCase();
  const looksJson = type.includes('json') || /^\s*[[{]/.test(raw);
  if (!looksJson) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Filter captured requests by text, method and error status. */
export function filterRequests(requests, { query = '', method = 'ALL', errorsOnly = false } = {}) {
  const needle = String(query).trim().toLowerCase();
  const wanted = String(method || 'ALL').toUpperCase();
  return (requests ?? []).filter((request) => {
    if (wanted !== 'ALL' && String(request.method).toUpperCase() !== wanted) return false;
    if (errorsOnly && !(Number(request.status) >= 400 || String(request.error ?? '').trim())) {
      return false;
    }
    if (!needle) return true;
    return String(request.url ?? '').toLowerCase().includes(needle)
      || String(request.method ?? '').toLowerCase().includes(needle)
      || String(request.status ?? '').includes(needle);
  });
}

/** Semantic tone for a status code (drives the colour of the status chip). */
export function statusTone(status) {
  const code = Number(status) || 0;
  if (code >= 500) return 'bad';
  if (code >= 400) return 'warn';
  if (code >= 300) return 'redirect';
  if (code >= 200) return 'ok';
  return 'muted';
}

/** Compact human duration. */
export function formatMs(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}
