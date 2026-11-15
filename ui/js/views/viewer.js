/**
 * govind://viewer — read-only previews for local files.
 *
 * Images, video, PDF and Office documents are rendered from bytes the user
 * picked; nothing is uploaded and no remote content is fetched. The bytes come
 * either from the native dialog + `read_viewer_bytes` command (installed app)
 * or from a hidden `<input type="file">` (browser preview).
 */

import { $, escapeHtml, formatBytes, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { store } from '../state/store.js';
import {
  VIEWER_ACCEPT,
  VIEWER_EXTENSIONS,
  viewerKindFor,
  kindLabel,
  mimeFor,
  parseCsv,
  tableHtml,
  markdownToHtml,
  renderDocx,
  readXlsx,
} from '../lib/file-preview.js';

/** Mirrors `MAX_VIEW_BYTES` in src-tauri/src/commands/viewer.rs. */
const MAX_VIEW_BYTES = 64 * 1024 * 1024;

const viewer = {
  mountId: 0,
  name: '',
  path: '',
  size: 0,
  kind: null,
  bytes: null,
  objectUrl: null,
  sheets: null,
  sheet: 0,
  error: null,
};

// ── Rendering ────────────────────────────────────────────────────────

export function renderViewerPage() {
  const host = $('#view-internal');
  if (!host || store.internalPage !== 'viewer') return;
  // Keep playback/scroll position when unrelated parts of the shell re-render.
  if (host.dataset.viewerMount === String(viewer.mountId)) return;
  host.dataset.viewerMount = String(viewer.mountId);

  const meta = viewer.name
    ? [kindLabel(viewer.kind), formatBytes(viewer.size), viewer.path].filter(Boolean).join(' · ')
    : 'Files are read on this device and never uploaded';

  host.innerHTML = `
    <div class="viewer-shell">
      <header class="viewer-bar">
        <div class="viewer-heading">
          <strong class="viewer-filename" title="${escapeHtml(viewer.path || viewer.name)}">${escapeHtml(viewer.name || 'File viewer')}</strong>
          <span class="viewer-meta">${escapeHtml(meta)}</span>
        </div>
        <div class="viewer-actions">
          ${viewer.name ? '<button class="btn-secondary" type="button" data-viewer-close>Close</button>' : ''}
          <button class="btn-secondary" type="button" data-viewer-open>Open file…</button>
        </div>
      </header>
      <div class="viewer-body" id="viewer-body"></div>
    </div>`;

  host.querySelector('[data-viewer-open]')?.addEventListener('click', openViewerPicker);
  host.querySelector('[data-viewer-close]')?.addEventListener('click', closeViewerFile);
  // Links in Markdown open as browser tabs, never inside the shell.
  $('#viewer-body')?.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    document.dispatchEvent(new CustomEvent('govind:navigate', { detail: link.href }));
  });
  renderViewerBody();
}

function emptyViewerHtml() {
  return `
    <div class="viewer-empty">
      <h2>Preview a file</h2>
      <p>Images, video, PDF, Word (.docx), Excel (.xlsx), CSV, JSON, Markdown and plain text.</p>
      <button class="btn-primary" type="button" data-viewer-open>Open file…</button>
    </div>`;
}

function wireViewerBody() {
  const body = $('#viewer-body');
  if (!body) return;
  body.querySelector('[data-viewer-open]')?.addEventListener('click', openViewerPicker);
  for (const tab of body.querySelectorAll('[data-sheet]')) {
    tab.addEventListener('click', () => {
      viewer.sheet = Number(tab.dataset.sheet);
      renderViewerBody();
    });
  }
}

async function renderViewerBody() {
  const body = $('#viewer-body');
  if (!body) return;
  const token = viewer.mountId;

  if (!viewer.name) {
    body.innerHTML = emptyViewerHtml();
    wireViewerBody();
    return;
  }
  if (viewer.error) {
    body.innerHTML = `<div class="viewer-empty"><p class="viewer-error" role="alert">${escapeHtml(viewer.error)}</p></div>`;
    wireViewerBody();
    return;
  }

  try {
    switch (viewer.kind) {
      case 'image': {
        body.innerHTML = '<figure class="viewer-media"></figure>';
        const image = document.createElement('img');
        image.className = 'viewer-image';
        image.alt = viewer.name;
        image.src = ensureObjectUrl();
        body.firstElementChild.append(image);
        return;
      }
      case 'video': {
        body.innerHTML = '<video class="viewer-video" controls playsinline></video>';
        body.firstElementChild.src = ensureObjectUrl();
        return;
      }
      case 'pdf': {
        body.innerHTML = '<iframe class="viewer-pdf" title="PDF preview"></iframe>';
        body.firstElementChild.src = ensureObjectUrl();
        return;
      }
      case 'docx': {
        body.innerHTML = '<p class="viewer-hint">Reading document…</p>';
        const html = await renderDocx(viewer.bytes);
        if (token !== viewer.mountId) return;
        body.innerHTML = html;
        return;
      }
      case 'xlsx': {
        body.innerHTML = '<p class="viewer-hint">Reading workbook…</p>';
        if (!viewer.sheets) {
          const data = await readXlsx(viewer.bytes);
          if (token !== viewer.mountId) return;
          viewer.sheets = data.sheets;
          viewer.sheet = 0;
        }
        renderWorkbook(body);
        return;
      }
      case 'csv': {
        const rows = parseCsv(decodeText());
        if (!rows.length) throw new Error('This CSV file is empty.');
        body.innerHTML = tableHtml(rows);
        return;
      }
      case 'json': {
        let pretty;
        try {
          pretty = JSON.stringify(JSON.parse(decodeText().replace(/^\uFEFF/, '')), null, 2);
        } catch {
          throw new Error('This file is not valid JSON.');
        }
        body.innerHTML = '<pre class="viewer-text"></pre>';
        body.firstElementChild.textContent = pretty;
        return;
      }
      case 'markdown':
        body.innerHTML = `<article class="viewer-doc viewer-markdown">${markdownToHtml(decodeText())}</article>`;
        return;
      case 'text':
        body.innerHTML = '<pre class="viewer-text"></pre>';
        body.firstElementChild.textContent = decodeText();
        return;
      default:
        throw new Error('Ritam cannot preview this file type yet.');
    }
  } catch (err) {
    if (token !== viewer.mountId) return;
    viewer.error = err?.message ?? String(err);
    renderViewerBody();
  }
}

function renderWorkbook(body) {
  const sheets = viewer.sheets ?? [];
  const index = Math.min(viewer.sheet, Math.max(0, sheets.length - 1));
  const sheet = sheets[index];
  if (!sheet) throw new Error('This workbook has no sheets.');

  const tabs = sheets.length > 1
    ? `<div class="viewer-sheet-tabs" role="tablist">${sheets.map((item, i) => `
        <button class="viewer-sheet-tab${i === index ? ' active' : ''}" type="button" role="tab"
          aria-selected="${i === index}" data-sheet="${i}">${escapeHtml(item.name)}</button>`).join('')}
      </div>`
    : '';

  body.innerHTML = `${tabs}${tableHtml(sheet.rows)}`;
  wireViewerBody();
}

function decodeText() {
  return new TextDecoder().decode(viewer.bytes);
}

function ensureObjectUrl() {
  if (viewer.objectUrl) return viewer.objectUrl;
  const type = mimeFor(viewer.name) ?? 'application/octet-stream';
  viewer.objectUrl = URL.createObjectURL(new Blob([viewer.bytes], { type }));
  return viewer.objectUrl;
}

function revokeObjectUrl() {
  if (viewer.objectUrl) URL.revokeObjectURL(viewer.objectUrl);
  viewer.objectUrl = null;
}

// ── Opening files ────────────────────────────────────────────────────

export async function openViewerPicker() {
  if (api.isNative()) {
    try {
      const picked = await api.pickViewerFile(VIEWER_EXTENSIONS);
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (path) await openViewerPath(String(path));
    } catch (err) {
      toast(`Could not open the file picker: ${err?.message ?? err}`);
    }
    return;
  }
  viewerInput().click();
}

async function openViewerPath(path) {
  const name = path.split(/[\\/]/).pop() || path;
  if (!viewerKindFor(name)) {
    toast('Ritam cannot preview this file type yet.');
    return;
  }
  try {
    const data = await api.readViewerBytes(path);
    const bytes = data instanceof Uint8Array
      ? data
      : new Uint8Array(data?.buffer ?? data);
    applyViewerFile({ name, path, bytes });
  } catch (err) {
    toast(`Could not open ${name}: ${err?.message ?? err}`);
  }
}

function viewerInput() {
  const existing = document.getElementById('viewer-file-input');
  if (existing) return existing;

  const input = document.createElement('input');
  input.type = 'file';
  input.id = 'viewer-file-input';
  input.accept = VIEWER_ACCEPT;
  input.hidden = true;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    applyViewerFile({ name: file.name, path: '', bytes: new Uint8Array(await file.arrayBuffer()) });
  });
  document.body.append(input);
  return input;
}

function applyViewerFile({ name, path = '', bytes }) {
  revokeObjectUrl();
  viewer.mountId += 1;
  viewer.name = name;
  viewer.path = path;
  viewer.kind = viewerKindFor(name);
  viewer.bytes = bytes;
  viewer.size = bytes.byteLength;
  viewer.sheets = null;
  viewer.sheet = 0;
  viewer.error = bytes.byteLength > MAX_VIEW_BYTES
    ? `This file is larger than ${formatBytes(MAX_VIEW_BYTES)} and cannot be previewed.`
    : null;
  renderViewerPage();
}

function closeViewerFile() {
  revokeObjectUrl();
  viewer.mountId += 1;
  viewer.name = '';
  viewer.path = '';
  viewer.kind = null;
  viewer.bytes = null;
  viewer.size = 0;
  viewer.sheets = null;
  viewer.sheet = 0;
  viewer.error = null;
  renderViewerPage();
}
