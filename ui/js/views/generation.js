/**
 * "Generate with WorkAny" dialog.
 *
 * The shell is plain ES modules; this view owns only the dialog mirror of the
 * native job. Generation itself runs in Rust against an optional hardened
 * sidecar, so every state below is also reachable when the engine is absent.
 */

import { $, escapeHtml, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { openInternalPage } from '../state/store.js';
import { openViewerPath } from './viewer.js';
import { selectSettingsCategory } from './settings.js';
import {
  GENERATION_TYPES,
  INITIAL_GENERATION_STATE,
  folderOf,
  formatElapsed,
  generationReducer,
  typeLabel,
  validatePrompt,
} from '../lib/generation.js';

let state = { ...INITIAL_GENERATION_STATE };
let info = null;
let unlisten = null;
let wired = false;
let clock = null;
let startedAt = 0;

const dialog = () => document.getElementById('generation-dialog');
const isBusy = () => state.status === 'generating';
const PHASE_LABELS = {
  queued: 'Queued',
  starting: 'Starting',
  thinking: 'Thinking',
  tool: 'Running tool',
  writing: 'Saving',
  result: 'Finishing',
  waiting: 'Waiting',
};

function beginClock() {
  startedAt = Date.now();
  stopClock();
  updateLive();
  clock = setInterval(updateLive, 1000);
}

function stopClock() {
  if (clock) clearInterval(clock);
  clock = null;
}

function updateLive() {
  const host = document.getElementById('generation-live');
  if (!host) return;
  host.hidden = !isBusy();
  if (!isBusy()) return;
  const last = state.progress.at(-1);
  const phase = PHASE_LABELS[last?.phase] || 'Working';
  const detail = last?.message?.trim() || 'Waiting for the model’s first step…';
  const elapsed = startedAt ? Date.now() - startedAt : 0;
  const phaseNode = document.getElementById('generation-live-phase');
  const detailNode = document.getElementById('generation-live-detail');
  const timeNode = document.getElementById('generation-live-time');
  if (phaseNode) phaseNode.textContent = phase;
  if (detailNode) detailNode.textContent = detail;
  if (timeNode) timeNode.textContent = formatElapsed(elapsed);
}

function ensureDialog() {
  let host = dialog();
  if (!host) {
    host = document.createElement('dialog');
    host.id = 'generation-dialog';
    host.className = 'generation-dialog';
    document.body.append(host);
  }
  if (!wired) {
    wired = true;
    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('cancel', (event) => {
      if (isBusy()) {
        event.preventDefault();
        toast('Cancel the generation before closing.');
      }
    });
  }
  return host;
}

function onClick(event) {
  if (event.target.closest('[data-generation-type]')) {
    const type = event.target.closest('[data-generation-type]').getAttribute('data-generation-type');
    state = generationReducer(state, { type: 'type', value: type });
    paint();
    return;
  }
  if (event.target.closest('[data-generation-start]')) {
    start();
    return;
  }
  if (event.target.closest('[data-generation-cancel]')) {
    cancel();
    return;
  }
  if (event.target.closest('[data-generation-settings]')) {
    openNvidiaSettings();
    return;
  }
  if (event.target.closest('[data-generation-close]')) {
    close();
  }
}

function onInput(event) {
  if (event.target.id !== 'generation-prompt') return;
  state = generationReducer(state, { type: 'prompt', value: event.target.value });
  const counter = document.getElementById('generation-count');
  if (counter) counter.textContent = `${state.prompt.length} / 8000`;
}

export async function openGenerationDialog(options = {}) {
  const host = ensureDialog();
  if (!host) return;
  if (host.open) {
    host.focus();
    return;
  }
  if (!isBusy()) {
    state = generationReducer(state, { type: 'reset' });
    if (GENERATION_TYPES.some((item) => item.id === options.type)) {
      state = generationReducer(state, { type: 'type', value: options.type });
    }
    if (typeof options.prompt === 'string') {
      state = generationReducer(state, { type: 'prompt', value: options.prompt });
    }
  }
  info = null;
  render();
  host.showModal();
  if (!unlisten) {
    unlisten = await api.listen('generation-progress', onProgress);
  }
  paint();
  try {
    info = await api.generationInfo();
  } catch (error) {
    info = {
      supported: false,
      detail: `Could not check the generation engine: ${error?.message ?? error}`,
    };
  }
  // A page reload or a dialog reopened while a worker is still unwinding must
  // show that job and offer Cancel instead of letting Generate hit the backend
  // guard with "another generation is already running".
  if (info?.active_job) {
    adoptActiveJob(info.active_job);
    requestAnimationFrame(() => {
      document.getElementById('generation-live')?.scrollIntoView({ block: 'nearest' });
    });
  } else {
    stopClock();
  }
  paint();
  setTimeout(() => document.getElementById('generation-prompt')?.focus(), 0);
}

function adoptActiveJob(jobId, message = 'A generation is already running. Cancel it to start another.') {
  if (!jobId) return false;
  state = generationReducer(state, { type: 'start' });
  state = generationReducer(state, {
    type: 'progress',
    jobId,
    phase: 'waiting',
    message,
    at: Date.now(),
  });
  beginClock();
  paint();
  return true;
}

function render() {
  const host = dialog();
  if (!host) return;
  host.innerHTML = `
    <form class="generation-form" method="dialog">
      <header class="generation-head">
        <div>
          <h2 id="generation-title">Generate with WorkAny</h2>
          <p class="generation-sub">Slides, workbooks, documents and static sites from a prompt.</p>
        </div>
        <button class="icon-btn" type="button" data-generation-close title="Close" aria-label="Close generation dialog">×</button>
      </header>
      <div class="generation-types" role="radiogroup" aria-label="Artifact type">
        ${GENERATION_TYPES.map((item) => `
          <button class="generation-type" type="button" role="radio" data-generation-type="${item.id}" aria-checked="false">
            <strong>${escapeHtml(item.label)}</strong>
            <span>${escapeHtml(item.hint)}</span>
          </button>`).join('')}
      </div>
      <label class="generation-field" for="generation-prompt">
        <span>Prompt</span>
        <textarea id="generation-prompt" rows="5" maxlength="8000" spellcheck="true"
          placeholder="Create a six-slide deck about local-first browsing…"></textarea>
        <span class="generation-count" id="generation-count">0 / 8000</span>
      </label>
      <div class="generation-info" id="generation-info"></div>
      <div class="generation-live" id="generation-live" hidden>
        <span class="generation-pulse" aria-hidden="true"></span>
        <div class="generation-live-copy">
          <strong id="generation-live-phase">Working</strong>
          <span id="generation-live-detail">Waiting for the model’s first step…</span>
        </div>
        <span class="generation-live-time" id="generation-live-time">0:00</span>
      </div>
      <div class="generation-progress" id="generation-progress" aria-live="polite"></div>
      <p class="generation-error" id="generation-error" role="alert" hidden></p>
      <footer class="generation-foot">
        <span class="generation-cost">Provider usage is billed by your configured model provider. Ritam does not set a spend cap.</span>
        <div class="generation-actions">
          <button class="btn-secondary" type="button" data-generation-cancel hidden>Cancel</button>
          <button class="btn-primary" type="button" data-generation-start>Generate</button>
        </div>
      </footer>
    </form>`;
  const prompt = document.getElementById('generation-prompt');
  if (prompt) prompt.value = state.prompt;
  const counter = document.getElementById('generation-count');
  if (counter) counter.textContent = `${state.prompt.length} / 8000`;
}

function paint() {
  const host = dialog();
  if (!host) return;
  host.querySelectorAll('[data-generation-type]').forEach((button) => {
    const active = button.getAttribute('data-generation-type') === state.type;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
    button.disabled = isBusy();
  });
  const prompt = document.getElementById('generation-prompt');
  if (prompt) {
    prompt.disabled = isBusy();
  }

  const infoHost = document.getElementById('generation-info');
  if (infoHost) {
    if (!info) {
      infoHost.innerHTML = '<span class="generation-muted">Checking for WorkAny…</span>';
    } else if (info.supported) {
      infoHost.innerHTML = `<span class="generation-ready">Ready</span> ${escapeHtml(info.detail)}`;
    } else {
      const keyButton = info.binary && info.api_key_configured === false
        ? ' <button class="btn-secondary generation-key-link" type="button" data-generation-settings>Add NVIDIA key</button>'
        : '';
      infoHost.innerHTML = `<span class="generation-missing">Not available</span> ${escapeHtml(info.detail)}${keyButton}`;
    }
  }

  const progress = document.getElementById('generation-progress');
  if (progress) {
    if (state.progress.length === 0) {
      progress.innerHTML = isBusy()
        ? '<span class="generation-muted">Preparing the engine…</span>'
        : '';
    } else {
      progress.innerHTML = state.progress.map((entry) => `
        <div class="generation-progress-row">
          <span class="generation-phase">${escapeHtml(entry.phase)}</span>
          <span>${escapeHtml(entry.message)}</span>
        </div>`).join('');
      progress.scrollTop = progress.scrollHeight;
    }
  }

  const error = document.getElementById('generation-error');
  if (error) {
    error.hidden = !state.error;
    error.textContent = state.error;
  }

  const start = host.querySelector('[data-generation-start]');
  if (start) {
    start.disabled = isBusy() || !info?.supported;
    start.textContent = isBusy()
      ? 'Working…'
      : state.status === 'success'
        ? 'Generate another'
        : 'Generate';
  }
  const cancel = host.querySelector('[data-generation-cancel]');
  if (cancel) {
    cancel.hidden = !isBusy();
    cancel.disabled = !state.jobId;
  }
  const close = host.querySelector('[data-generation-close]');
  if (close) close.disabled = isBusy();
  updateLive();
}

async function start() {
  const problem = validatePrompt(state.prompt);
  if (problem) {
    state = generationReducer(state, { type: 'error', message: problem });
    paint();
    toast(problem);
    return;
  }
  if (!info?.supported) {
    toast(info?.detail || 'WorkAny is not available.');
    return;
  }
  const artifactType = state.type;
  const prompt = state.prompt.trim();
  state = generationReducer(state, { type: 'start' });
  beginClock();
  paint();
  requestAnimationFrame(() => {
    document.getElementById('generation-live')?.scrollIntoView({ block: 'nearest' });
  });
  try {
    const result = await api.generateArtifact(artifactType, prompt, { language: 'en-US' });
    if (state.status === 'cancelled') return;
    stopClock();
    state = generationReducer(state, { type: 'success', result });
    paint();
    await openResult(artifactType, result);
  } catch (error) {
    if (state.status === 'cancelled') return;
    const message = String(error?.message ?? error);
    if (/another generation is already running/i.test(message)) {
      const refreshed = await api.generationInfo().catch(() => null);
      if (refreshed?.active_job) {
        info = refreshed;
        adoptActiveJob(
          refreshed.active_job,
          'An earlier generation is still running. Cancel it to start another.',
        );
        toast('A previous generation is still running. Use Cancel to stop it.');
        return;
      }
    }
    stopClock();
    state = generationReducer(state, { type: 'error', message });
    paint();
  }
}

async function cancel() {
  if (!isBusy() || !state.jobId) return;
  try {
    const cancelled = await api.cancelGeneration(state.jobId);
    info = { ...(info || {}), active_job: null };
    if (!cancelled) {
      const refreshed = await api.generationInfo().catch(() => null);
      if (refreshed) info = refreshed;
      if (info?.active_job) {
        adoptActiveJob(info.active_job);
        toast('That generation is still running. Try Cancel again.');
        return;
      }
      stopClock();
      state = { ...state, status: 'idle', jobId: null, progress: [], error: '' };
      paint();
      toast('That generation is no longer running.');
      return;
    }
    stopClock();
    state = generationReducer(state, { type: 'cancel' });
    paint();
    toast('Generation cancelled. You can start another.');
  } catch (error) {
    toast(`Could not cancel: ${error?.message ?? error}`);
  }
}

function onProgress(event) {
  const payload = event?.payload ?? event ?? {};
  if (state.status !== 'generating') return;
  if (payload.jobId && state.jobId && payload.jobId !== state.jobId) return;
  state = generationReducer(state, {
    type: 'progress',
    jobId: payload.jobId,
    phase: payload.phase,
    message: payload.message,
    at: payload.at,
  });
  paint();
}

function close() {
  if (isBusy()) {
    toast('Cancel the generation before closing.');
    return;
  }
  stopClock();
  dialog()?.close();
}

function openNvidiaSettings() {
  if (isBusy()) return;
  close();
  selectSettingsCategory('ai');
  void openInternalPage('settings');
}

async function openResult(artifactType, result) {
  if (!result?.path) return;
  if (artifactType === 'website') {
    const folder = folderOf(result.path);
    const opened = await api.openExternal(folder).catch(() => false);
    toast(opened === false ? 'Website generated, but its folder could not be opened.' : 'Website generated. Opened its folder.');
    return;
  }
  dialog()?.close();
  try {
    await openInternalPage('viewer');
    await openViewerPath(result.path);
  } catch (error) {
    toast(`Generated ${typeLabel(artifactType)}, but it could not be opened: ${error?.message ?? error}`);
  }
}
