/**
 * govind://inspector — the developer workbench.
 *
 * Tabs of the current workspace are the capture targets. Capture is installed
 * by the Rust side (page-level instrumentation over WebView2's message
 * channel); this page only reads the session buffer, renders it and sends the
 * user's replay/mock/DOM-snapshot actions back.
 *
 * Nothing here is persisted: capture starts when the user asks for it and lives
 * in memory until the tab closes or the report is cleared.
 */

import { $, escapeHtml, formatBytes, formatTime, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { store } from '../state/store.js';
import {
  filterRequests, formatMs, prettyBody, statusTone, toCurl, toFetch,
} from '../lib/inspector.js';

const EMPTY = {
  supported: true,
  enabled: false,
  requests: [],
  console: [],
  errors: [],
  rules: [],
  snapshot: null,
  mock_hits: 0,
  dropped: 0,
};

const state = {
  targetId: null,
  tab: 'network',
  query: '',
  method: 'ALL',
  errorsOnly: false,
  selectedId: null,
  /** Full record (headers + bodies) of the selected request. */
  selected: null,
  replay: null,
  mockDraft: null,
  data: EMPTY,
  targetOptions: '',
  listSignature: '',
  detailSignature: '',
  consoleSignature: '',
  errorsSignature: '',
  domSignature: '',
  mockSignature: '',
};

let poll = null;
let mountedHost = null;

// ── Targets ───────────────────────────────────────────────────────────
function webTabs() {
  return store.tabs.filter((tab) => !store.isInternalTab(tab) && !store.isHomeTab(tab));
}

function pickTarget() {
  const tabs = webTabs();
  if (tabs.length === 0) {
    state.targetId = null;
    return null;
  }
  const current = tabs.find((tab) => tab.id === state.targetId);
  if (current) return current;
  const target = [...tabs].sort((a, b) => (b.last_active_at ?? 0) - (a.last_active_at ?? 0))[0];
  state.targetId = target.id;
  return target;
}

// ── Small render helpers ──────────────────────────────────────────────
function headerTable(headers) {
  const pairs = Array.isArray(headers) ? headers : [];
  if (pairs.length === 0) return '<p class="inspector-muted">None captured.</p>';
  return `<table class="inspector-headers"><tbody>${pairs.map((header) => `
    <tr><th>${escapeHtml(header.name)}</th><td>${escapeHtml(header.value)}</td></tr>`).join('')}</tbody></table>`;
}

function section(title, body) {
  return `<section class="inspector-section"><h4>${escapeHtml(title)}</h4>${body}</section>`;
}

function bodyBlock(body) {
  if (!String(body ?? '').trim()) return '<p class="inspector-muted">No body captured.</p>';
  return `<pre class="inspector-body">${escapeHtml(body)}</pre>`;
}

function rowCountLabel(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ── Public entry point ────────────────────────────────────────────────
export async function renderInspectorPage(host) {
  if (!host) return;
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
  mountedHost = host;
  pickTarget();

  const tabs = webTabs();
  state.targetOptions = tabs.map((tab) => `${tab.id}:${tab.title ?? ''}`).join('|');

  host.innerHTML = `
    <div class="inspector-toolbar">
      <label class="inspector-target">Target tab
        <select id="inspector-target">
          ${tabs.length
            ? tabs.map((tab) => `<option value="${escapeHtml(tab.id)}" ${tab.id === state.targetId ? 'selected' : ''}>${escapeHtml(tab.title || tab.url)}</option>`).join('')
            : '<option value="">No website tabs in this workspace</option>'}
        </select>
      </label>
      <button class="btn-secondary" id="inspector-toggle" type="button" disabled>Start capture</button>
      <button class="btn-secondary" id="inspector-clear" type="button" disabled>Clear report</button>
      <span class="inspector-status" id="inspector-status">Checking…</span>
    </div>
    <p class="internal-note" id="inspector-note"></p>
    <div class="internal-tabs inspector-tabs" role="tablist">
      <button class="internal-tab" data-inspector-tab="network" role="tab">Network</button>
      <button class="internal-tab" data-inspector-tab="console" role="tab">Console</button>
      <button class="internal-tab" data-inspector-tab="errors" role="tab">Errors</button>
      <button class="internal-tab" data-inspector-tab="mocks" role="tab">Mocks</button>
      <button class="internal-tab" data-inspector-tab="dom" role="tab">DOM snapshot</button>
    </div>
    <section class="inspector-pane" data-pane="network">
      <div class="inspector-filters">
        <input id="inspector-query" type="search" spellcheck="false" placeholder="Filter by URL, method or status" aria-label="Filter requests"/>
        <select id="inspector-method" aria-label="Filter by method">
          ${['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((method) => `<option value="${method}" ${method === state.method ? 'selected' : ''}>${method === 'ALL' ? 'All methods' : method}</option>`).join('')}
        </select>
        <label class="inspector-check"><input id="inspector-errors-only" type="checkbox" ${state.errorsOnly ? 'checked' : ''}/> Errors only</label>
      </div>
      <div class="inspector-layout">
        <div class="inspector-list" id="inspector-requests" role="list"></div>
        <div class="inspector-detail" id="inspector-detail"></div>
      </div>
    </section>
    <section class="inspector-pane hidden" data-pane="console"><div id="inspector-console"></div></section>
    <section class="inspector-pane hidden" data-pane="errors"><div id="inspector-errors"></div></section>
    <section class="inspector-pane hidden" data-pane="mocks"><div id="inspector-mocks"></div></section>
    <section class="inspector-pane hidden" data-pane="dom"><div id="inspector-dom"></div></section>`;

  wire(host);
  applyTab(host);
  await refresh();
  poll = setInterval(() => {
    // Stop polling as soon as the page is replaced instead of idling forever.
    if (!mountedHost?.isConnected || store.internalPage !== 'inspector') {
      clearInterval(poll);
      poll = null;
      return;
    }
    refresh();
  }, 2000);
}

// ── Events ────────────────────────────────────────────────────────────
function wire(host) {
  $('#inspector-target', host)?.addEventListener('change', async (event) => {
    state.targetId = event.target.value || null;
    state.selectedId = null;
    state.selected = null;
    state.replay = null;
    state.mockDraft = null;
    state.listSignature = '';
    state.detailSignature = '';
    state.consoleSignature = '';
    state.errorsSignature = '';
    state.domSignature = '';
    state.mockSignature = '';
    await refresh();
  });

  $('#inspector-toggle', host)?.addEventListener('click', async () => {
    const target = pickTarget();
    if (!target) return;
    try {
      await api.setNetworkCapture(target.id, !state.data.enabled);
      state.selectedId = null;
      state.selected = null;
      state.replay = null;
      await refresh();
      toast(state.data.enabled ? 'Capturing network activity for this tab.' : 'Capture stopped.');
    } catch (error) {
      toast(`Could not change capture: ${error?.message ?? error}`);
    }
  });

  $('#inspector-clear', host)?.addEventListener('click', async () => {
    const target = pickTarget();
    if (!target) return;
    await api.clearCapture(target.id).catch(() => {});
    state.selectedId = null;
    state.selected = null;
    state.replay = null;
    state.listSignature = '';
    state.detailSignature = '';
    state.consoleSignature = '';
    state.errorsSignature = '';
    state.domSignature = '';
    await refresh();
    toast('Inspector report cleared.');
  });

  host.querySelectorAll('[data-inspector-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.getAttribute('data-inspector-tab');
      applyTab(host);
      if (state.tab === 'mocks') paintMocks();
      if (state.tab === 'dom') paintDom();
    });
  });

  $('#inspector-query', host)?.addEventListener('input', (event) => {
    state.query = event.target.value;
    state.listSignature = '';
    paintRequests();
  });

  $('#inspector-method', host)?.addEventListener('change', (event) => {
    state.method = event.target.value;
    state.listSignature = '';
    paintRequests();
  });

  $('#inspector-errors-only', host)?.addEventListener('change', (event) => {
    state.errorsOnly = event.target.checked;
    state.listSignature = '';
    paintRequests();
  });

  $('#inspector-requests', host)?.addEventListener('click', async (event) => {
    const id = event.target.closest('[data-request-id]')?.getAttribute('data-request-id');
    if (!id) return;
    state.selectedId = id;
    state.selected = null;
    state.replay = null;
    state.detailSignature = '';
    paintRequests();
    paintDetail();
    const target = pickTarget();
    if (!target) return;
    try {
      const request = await api.inspectorRequest(target.id, id);
      // The target or selection may have moved while the detail was loading.
      if (state.selectedId !== id) return;
      state.selected = request;
      state.detailSignature = '';
      paintDetail();
    } catch (error) {
      if (state.selectedId === id) {
        state.selected = null;
        state.detailSignature = '';
        paintDetail();
      }
      toast(`Could not load the request: ${error?.message ?? error}`);
    }
  });

  $('#inspector-detail', host)?.addEventListener('click', async (event) => {
    const request = state.selected;
    if (!request) return;

    if (event.target.closest('[data-copy-curl]')) {
      await copy(toCurl(request), 'cURL command');
      return;
    }
    if (event.target.closest('[data-copy-fetch]')) {
      await copy(toFetch(request), 'Fetch code');
      return;
    }
    if (event.target.closest('[data-copy-body]')) {
      await copy(prettyBody(request.response_body, request.content_type), 'response body');
      return;
    }
    if (event.target.closest('[data-replay]')) {
      await replay(request);
      return;
    }
    if (event.target.closest('[data-mock-request]')) {
      state.mockDraft = {
        url_contains: request.url,
        method: request.method || 'GET',
        status: 200,
        content_type: 'application/json',
        body: '{\n  "mocked": true\n}',
      };
      state.tab = 'mocks';
      state.mockSignature = '';
      applyTab(host);
      paintMocks();
      $('#mock-url', host)?.focus();
      return;
    }
    if (event.target.closest('[data-copy-replay-body]') && state.replay?.result) {
      await copy(state.replay.result.body, 'replay body');
    }
  });

  $('#inspector-console', host)?.addEventListener('click', (event) => {
    if (event.target.closest('[data-copy-console]')) {
      const text = state.data.console.map((entry) => `[${entry.level}] ${entry.text}`).join('\n');
      copy(text, 'console log');
    }
  });

  $('#inspector-errors', host)?.addEventListener('click', (event) => {
    if (event.target.closest('[data-copy-errors]')) {
      const text = state.data.errors
        .map((entry) => `${entry.message}${entry.source ? ` (${entry.source}:${entry.line}:${entry.column})` : ''}`)
        .join('\n');
      copy(text, 'error log');
    }
  });

  $('#inspector-dom', host)?.addEventListener('click', async (event) => {
    if (event.target.closest('[data-capture-dom]')) {
      const target = pickTarget();
      if (!target) return;
      const sent = await api.requestDomSnapshot(target.id).catch(() => false);
      toast(sent ? 'Requesting a DOM snapshot…' : 'No live page to snapshot.');
      setTimeout(refresh, 500);
      return;
    }
    if (event.target.closest('[data-copy-dom]') && state.data.snapshot) {
      copy(state.data.snapshot.html, 'DOM snapshot');
    }
  });

  $('#inspector-mocks', host)?.addEventListener('click', async (event) => {
    const removeId = event.target.closest('[data-remove-mock]')?.getAttribute('data-remove-mock');
    if (removeId) {
      const target = pickTarget();
      if (!target) return;
      const rules = state.data.rules.filter((rule) => rule.id !== removeId);
      await api.setMockRules(target.id, rules).catch((error) => toast(`Could not remove the mock: ${error?.message ?? error}`));
      state.mockSignature = '';
      await refresh();
      paintMocks();
      toast('Mock removed.');
      return;
    }
    if (event.target.closest('[data-save-mock]')) {
      await saveMock(host);
    }
  });
}

// ── Refresh / paint ───────────────────────────────────────────────────
async function refresh() {
  if (!mountedHost?.isConnected) return;
  const target = pickTarget();
  if (!target) {
    state.data = { ...EMPTY };
    paintAll();
    return;
  }
  let data;
  try {
    data = await api.inspectorRead(target.id);
  } catch (error) {
    data = { ...EMPTY, supported: false, detail: String(error?.message ?? error) };
  }
  state.data = { ...EMPTY, ...data };
  if (state.selectedId && !state.data.requests.some((entry) => entry.id === state.selectedId)) {
    state.selectedId = null;
    state.selected = null;
    state.replay = null;
  }
  paintAll();
}

function paintAll() {
  paintStatus();
  paintRequests();
  paintDetail();
  paintConsole();
  paintErrors();
  paintDom();
  if (state.tab === 'mocks') paintMocks();
}

function paintStatus() {
  const data = state.data;
  const target = pickTarget();
  const toggle = $('#inspector-toggle');
  const clear = $('#inspector-clear');
  const note = $('#inspector-note');

  if (toggle) {
    toggle.disabled = !data.supported || !target;
    toggle.textContent = data.enabled ? 'Stop capture' : 'Start capture';
    toggle.classList.toggle('active', !!data.enabled);
  }
  if (clear) clear.disabled = !target;
  if (note) {
    note.textContent = !data.supported
      ? 'Network, console and DOM capture needs the Windows WebView2 message channel; this build cannot receive page reports.'
      : !target
        ? 'Open a website tab in this workspace, then start capture. The inspector tab itself cannot be a target.'
        : 'Capture is page-level: fetch/XHR calls, resource timings, console output and JS errors. Requests made before Start, and request bodies sent as streams, are not seen. The report lives in memory and is never written to disk.';
  }

  const status = $('#inspector-status');
  if (status) {
    if (!data.supported) {
      status.innerHTML = '<span class="inspector-dot"></span> Unsupported on this engine';
    } else if (data.enabled) {
      status.innerHTML = `<span class="inspector-dot live"></span> Capturing · ${rowCountLabel(data.requests.length, 'request')} · ${rowCountLabel(data.console.length, 'console message')} · ${rowCountLabel(data.errors.length, 'error')}${data.mock_hits ? ` · ${data.mock_hits} mock hit${data.mock_hits === 1 ? '' : 's'}` : ''}${data.dropped ? ` · ${data.dropped} older dropped` : ''}`;
    } else {
      status.innerHTML = '<span class="inspector-dot"></span> Idle — press Start capture';
    }
  }

  const tabs = host_tabs();
  if (tabs.length) {
    const countByTab = {
      network: data.requests.length,
      console: data.console.length,
      errors: data.errors.length,
      mocks: data.rules.length,
      dom: data.snapshot ? 1 : 0,
    };
    for (const button of tabs) {
      const id = button.getAttribute('data-inspector-tab');
      const label = { network: 'Network', console: 'Console', errors: 'Errors', mocks: 'Mocks', dom: 'DOM snapshot' }[id] ?? id;
      button.textContent = countByTab[id] ? `${label} (${countByTab[id]})` : label;
    }
  }

  const targetSelect = $('#inspector-target');
  const options = webTabs().map((tab) => `${tab.id}:${tab.title ?? ''}`).join('|');
  if (targetSelect && options !== state.targetOptions) {
    state.targetOptions = options;
    const current = state.targetId;
    targetSelect.innerHTML = webTabs().length
      ? webTabs().map((tab) => `<option value="${escapeHtml(tab.id)}" ${tab.id === current ? 'selected' : ''}>${escapeHtml(tab.title || tab.url)}</option>`).join('')
      : '<option value="">No website tabs in this workspace</option>';
  }
}

function host_tabs() {
  return mountedHost ? [...mountedHost.querySelectorAll('[data-inspector-tab]')] : [];
}

function paintRequests() {
  const host = $('#inspector-requests');
  if (!host) return;
  const rows = filterRequests(state.data.requests, {
    query: state.query,
    method: state.method,
    errorsOnly: state.errorsOnly,
  }).slice().reverse();
  const signature = `${rows.length}:${rows.slice(0, 3).map((row) => row.id).join(',')}:${state.selectedId ?? ''}`;
  if (signature === state.listSignature) return;
  state.listSignature = signature;

  if (rows.length === 0) {
    host.innerHTML = `<div class="internal-empty"><p>${state.data.enabled
      ? 'No matching requests yet. Use the target tab; new fetch/XHR calls and resources appear here.'
      : 'Press Start capture to record this tab’s network activity.'}</p></div>`;
    return;
  }
  host.innerHTML = rows.map((request) => `
    <button class="inspector-row ${request.id === state.selectedId ? 'active' : ''}" data-request-id="${escapeHtml(request.id)}" role="listitem" title="${escapeHtml(request.url)}">
      <span class="inspector-method method-${escapeHtml(String(request.method || 'GET').toLowerCase())}">${escapeHtml(request.method || 'GET')}</span>
      <span class="inspector-url">${escapeHtml(request.url)}</span>
      <span class="inspector-status-chip tone-${statusTone(request.status)}">${request.status ? escapeHtml(request.status) : '—'}</span>
      <span class="inspector-time">${escapeHtml(formatMs(request.duration_ms))}</span>
    </button>`).join('');
}

function paintDetail() {
  const host = $('#inspector-detail');
  if (!host) return;
  const request = state.selected;
  if (!request) {
    host.innerHTML = state.selectedId
      ? '<div class="internal-empty"><p>Loading request details…</p></div>'
      : '<div class="internal-empty"><p>Select a request to see headers, bodies and export options.</p></div>';
    state.detailSignature = '';
    return;
  }
  const signature = `${request.id}:${state.replay ? `${state.replay.loading}:${state.replay.result?.status ?? ''}:${state.replay.error ?? ''}` : ''}:${request.response_body.length}:${request.mocked}`;
  if (signature === state.detailSignature) return;
  state.detailSignature = signature;

  const responseBody = prettyBody(request.response_body, request.content_type);
  host.innerHTML = `
    <header class="inspector-detail-head">
      <span class="inspector-method method-${escapeHtml(String(request.method || 'GET').toLowerCase())}">${escapeHtml(request.method || 'GET')}</span>
      <span class="inspector-status-chip tone-${statusTone(request.status)}">${request.status ? escapeHtml(request.status) : '—'}</span>
      <span class="inspector-time">${escapeHtml(formatMs(request.duration_ms))}</span>
      ${request.mocked ? '<span class="inspector-badge">mocked</span>' : ''}
    </header>
    <p class="inspector-detail-url">${escapeHtml(request.url)}</p>
    ${request.error ? `<p class="inspector-error">${escapeHtml(request.error)}</p>` : ''}
    <div class="inspector-actions">
      <button class="btn-secondary" data-copy-curl type="button">Copy as cURL</button>
      <button class="btn-secondary" data-copy-fetch type="button">Copy as Fetch</button>
      <button class="btn-secondary" data-replay type="button">Replay</button>
      <button class="btn-secondary" data-mock-request type="button">Mock this response</button>
    </div>
    ${section('Overview', `<dl class="inspector-meta">
      <div><dt>Type</dt><dd>${escapeHtml(request.kind || 'other')}</dd></div>
      <div><dt>Content type</dt><dd>${escapeHtml(request.content_type || 'not captured')}</dd></div>
      <div><dt>Size</dt><dd>${request.size ? escapeHtml(formatBytes(request.size)) : 'not captured'}</dd></div>
      <div><dt>Started</dt><dd>${escapeHtml(formatTime(request.started_at))}</dd></div>
    </dl>`)}
    ${section('Request headers', headerTable(request.request_headers))}
    ${section('Request body', bodyBlock(request.request_body))}
    ${section('Response headers', headerTable(request.response_headers))}
    ${section('Response', `
      ${responseBody ? '<div class="inspector-actions"><button class="btn-secondary" data-copy-body type="button">Copy body</button></div>' : ''}
      ${bodyBlock(responseBody)}`)}
    ${state.replay ? replayBlock() : ''}`;
}

function replayBlock() {
  if (state.replay.loading) {
    return '<section class="inspector-section"><h4>Replay result</h4><p class="inspector-muted">Sending the request…</p></section>';
  }
  if (state.replay.error) {
    return `<section class="inspector-section"><h4>Replay result</h4><p class="inspector-error">${escapeHtml(state.replay.error)}</p></section>`;
  }
  const result = state.replay.result;
  if (!result) return '';
  const body = prettyBody(result.body, result.headers?.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? '');
  return `<section class="inspector-section">
    <h4>Replay result</h4>
    <div class="inspector-detail-head">
      <span class="inspector-status-chip tone-${statusTone(result.status)}">${escapeHtml(result.status)}</span>
      <span class="inspector-time">${escapeHtml(formatMs(result.duration_ms))}</span>
      ${result.truncated ? '<span class="inspector-badge">truncated</span>' : ''}
      <button class="btn-secondary" data-copy-replay-body type="button">Copy body</button>
    </div>
    <p class="inspector-muted">${escapeHtml(result.final_url)}</p>
    ${headerTable(result.headers)}
    ${bodyBlock(body)}
    <p class="internal-note">The replay ran from the Ritam process, not from the page — the page's cookies and origin were not used.</p>
  </section>`;
}

function paintConsole() {
  const host = $('#inspector-console');
  if (!host) return;
  const messages = state.data.console;
  const signature = `${messages.length}:${messages[messages.length - 1]?.id ?? ''}`;
  if (signature === state.consoleSignature) return;
  state.consoleSignature = signature;
  if (messages.length === 0) {
    host.innerHTML = '<div class="internal-empty"><p>No console messages recorded. Press Start capture, then interact with the target tab.</p></div>';
    return;
  }
  host.innerHTML = `
    <div class="inspector-actions"><button class="btn-secondary" data-copy-console type="button">Copy log</button></div>
    <div class="inspector-log">${messages.slice().reverse().map((entry) => `
      <div class="inspector-log-row level-${escapeHtml(entry.level)}">
        <span class="inspector-log-level">${escapeHtml(entry.level)}</span>
        <span class="inspector-log-text">${escapeHtml(entry.text)}</span>
        <span class="inspector-time">${escapeHtml(formatTime(entry.at))}</span>
      </div>`).join('')}</div>`;
}

function paintErrors() {
  const host = $('#inspector-errors');
  if (!host) return;
  const errors = state.data.errors;
  const signature = `${errors.length}:${errors[errors.length - 1]?.id ?? ''}`;
  if (signature === state.errorsSignature) return;
  state.errorsSignature = signature;
  if (errors.length === 0) {
    host.innerHTML = '<div class="internal-empty"><p>No JavaScript errors recorded. Uncaught exceptions and unhandled rejections appear here while capture is on.</p></div>';
    return;
  }
  host.innerHTML = `
    <div class="inspector-actions"><button class="btn-secondary" data-copy-errors type="button">Copy errors</button></div>
    <div class="inspector-log">${errors.slice().reverse().map((entry) => `
      <div class="inspector-log-row level-error">
        <span class="inspector-log-level">error</span>
        <span class="inspector-log-text">${escapeHtml(entry.message)}${entry.source ? `<br/><span class="inspector-muted">${escapeHtml(entry.source)}:${escapeHtml(entry.line)}:${escapeHtml(entry.column)}</span>` : ''}</span>
        <span class="inspector-time">${escapeHtml(formatTime(entry.at))}</span>
      </div>`).join('')}</div>`;
}

function paintDom() {
  const host = $('#inspector-dom');
  if (!host) return;
  const snapshot = state.data.snapshot;
  const signature = `${snapshot ? `${snapshot.at}:${snapshot.html.length}` : 'none'}:${state.data.supported}:${state.data.enabled}`;
  if (signature === state.domSignature) return;
  state.domSignature = signature;
  host.innerHTML = `
    <div class="inspector-toolbar">
      <button class="btn-secondary" data-capture-dom type="button" ${state.data.supported ? '' : 'disabled'}>Capture DOM snapshot</button>
      <button class="btn-secondary" data-copy-dom type="button" ${snapshot ? '' : 'disabled'}>Copy HTML</button>
      <span class="inspector-muted">${snapshot ? `${escapeHtml(snapshot.title || 'Untitled page')} · ${escapeHtml(formatTime(snapshot.at))}${snapshot.truncated ? ' · truncated' : ''}` : 'No snapshot yet.'}</span>
    </div>
    <p class="internal-note">The snapshot is the rendered DOM serialised as HTML. It is display-only here: scripts are never executed and forms are inert.</p>
    ${snapshot ? `<pre class="inspector-body inspector-dom">${escapeHtml(snapshot.html)}</pre>` : ''}`;
}

function paintMocks() {
  const host = $('#inspector-mocks');
  if (!host) return;
  const rules = state.data.rules ?? [];
  const draft = state.mockDraft ?? {
    url_contains: '',
    method: 'GET',
    status: 200,
    content_type: 'application/json',
    body: '{\n  "mocked": true\n}',
  };
  const signature = `${rules.map((rule) => rule.id).join(',')}:${JSON.stringify(draft)}:${state.data.enabled}`;
  if (signature === state.mockSignature) return;
  state.mockSignature = signature;

  host.innerHTML = `
    <section class="inspector-section">
      <h4>Active mocks</h4>
      ${rules.length === 0
        ? '<p class="inspector-muted">No mock responses. Add one below, or use “Mock this response” on a captured request.</p>'
        : `<div class="inspector-card">${rules.map((rule) => `
          <div class="inspector-row mock-row">
            <span class="inspector-method method-${escapeHtml(String(rule.method || 'GET').toLowerCase())}">${escapeHtml(rule.method || 'GET')}</span>
            <span class="inspector-url">${escapeHtml(rule.url_contains)}</span>
            <span class="inspector-status-chip tone-${statusTone(rule.status)}">${escapeHtml(rule.status)}</span>
            <button class="row-action" data-remove-mock="${escapeHtml(rule.id)}" title="Remove mock" aria-label="Remove mock">×</button>
          </div>`).join('')}</div>`}
      <p class="internal-note">Mocks are applied by the page script while capture is on, and only to the target tab. A mock is a literal URL substring match, checked before the real request leaves the page.</p>
    </section>
    <section class="inspector-section">
      <h4>New mock response</h4>
      <div class="inspector-form">
        <label>URL contains <input id="mock-url" type="text" maxlength="500" spellcheck="false" value="${escapeHtml(draft.url_contains)}" placeholder="/api/users"/></label>
        <label>Method
          <select id="mock-method">
            ${['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'].map((method) => `<option value="${method}" ${method === draft.method ? 'selected' : ''}>${method === '*' ? 'Any method' : method}</option>`).join('')}
          </select>
        </label>
        <label>Status <input id="mock-status" type="number" min="200" max="599" value="${escapeHtml(draft.status)}"/></label>
        <label>Content type <input id="mock-content-type" type="text" maxlength="120" spellcheck="false" value="${escapeHtml(draft.content_type)}"/></label>
        <label class="wide">Body <textarea id="mock-body" rows="6" spellcheck="false">${escapeHtml(draft.body)}</textarea></label>
        <button class="btn-secondary" data-save-mock type="button">Add mock</button>
      </div>
    </section>`;
}

async function saveMock(host) {
  const target = pickTarget();
  if (!target) return;
  const rule = {
    id: '',
    url_contains: $('#mock-url', host)?.value.trim() ?? '',
    method: $('#mock-method', host)?.value ?? 'GET',
    status: Number($('#mock-status', host)?.value) || 200,
    content_type: $('#mock-content-type', host)?.value.trim() ?? 'text/plain',
    body: $('#mock-body', host)?.value ?? '',
  };
  if (!rule.url_contains) {
    toast('A mock needs a URL substring to match.');
    return;
  }
  if (rule.status < 200 || rule.status > 599) {
    toast('Mock status must be between 200 and 599.');
    return;
  }
  try {
    const rules = await api.setMockRules(target.id, [...state.data.rules, rule]);
    state.data.rules = rules;
    state.mockDraft = null;
    state.mockSignature = '';
    await refresh();
    paintMocks();
    toast(state.data.enabled
      ? 'Mock saved. Matching requests are intercepted while capture is on.'
      : 'Mock saved. Start capture to apply it.');
  } catch (error) {
    toast(`Could not save the mock: ${error?.message ?? error}`);
  }
}

function applyTab(host) {
  host.querySelectorAll('[data-inspector-tab]').forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-inspector-tab') === state.tab);
  });
  host.querySelectorAll('[data-pane]').forEach((pane) => {
    pane.classList.toggle('hidden', pane.getAttribute('data-pane') !== state.tab);
  });
}

async function replay(request) {
  state.replay = { loading: true };
  state.detailSignature = '';
  paintDetail();
  try {
    const result = await api.replayRequest({
      method: request.method || 'GET',
      url: request.url,
      headers: request.request_headers ?? [],
      body: request.request_body ?? '',
    });
    state.replay = { loading: false, result };
    toast(`Replay finished with HTTP ${result.status}.`);
  } catch (error) {
    state.replay = { loading: false, error: String(error?.message ?? error) };
    toast(`Replay failed: ${error?.message ?? error}`);
  }
  state.detailSignature = '';
  paintDetail();
}

async function copy(text, label) {
  if (!String(text ?? '').length) {
    toast(`Nothing to copy — no ${label} was captured.`);
    return;
  }
  const copied = await api.copyText(String(text));
  toast(copied ? `Copied ${label}.` : `Could not copy the ${label}; select the text and copy it manually.`);
}
