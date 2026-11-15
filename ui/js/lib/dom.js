/** Tiny DOM + formatting helpers (no framework). */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape a string for safe interpolation into innerHTML. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Format bytes as KB/MB for display. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Relative-ish time label for history/notes. */
export function formatTime(ts) {
  const d = new Date(Number(ts) || 0);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Local calendar day as `YYYY-MM-DD` (site time is stored per local day). */
export function localDay(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Milliseconds at local midnight, `offsetDays` before today. */
export function startOfLocalDay(offsetDays = 0, now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays).getTime();
}

/** Greeting based on local time. */
export function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 5) return 'Good night.';
  if (h < 12) return 'Good morning.';
  if (h < 17) return 'Good afternoon.';
  if (h < 21) return 'Good evening.';
  return 'Good night.';
}

let toastTimer = null;
/** Show a transient toast message. */
export function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
