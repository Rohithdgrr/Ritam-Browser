/**
 * `govind://ai` — the fixed AI Workspace tab.
 *
 * It is a launcher, not a second generation implementation: the cards open the
 * existing WorkAny dialog with the chosen artifact type, and web search uses the
 * normal address-bar search path in a new tab.
 */

import { $, escapeHtml, toast } from '../lib/dom.js';
import * as api from '../services/ipc.js';
import { createTab, navigate } from '../state/store.js';
import { DEFAULT_NVIDIA_MODEL, nvidiaModelLabel, nvidiaModelOptions } from '../lib/nvidia.js';
import { openGenerationDialog } from './generation.js';

const ARTIFACTS = [
  { type: 'pptx', badge: 'PPT', label: 'Slides', hint: 'Decks, pitches and explainers' },
  { type: 'docx', badge: 'DOC', label: 'Document', hint: 'Reports, briefs and notes' },
  { type: 'xlsx', badge: 'XLS', label: 'Spreadsheet', hint: 'Tables, trackers and plans' },
  { type: 'website', badge: 'WEB', label: 'Website', hint: 'A static site saved to disk' },
];

let draft = '';

export function renderAiWorkspace(host) {
  if (!host) return;
  host.innerHTML = `
    <div class="ai-workspace">
      <header class="ai-hero">
        <span class="ai-eyebrow">Ritam AI Workspace</span>
        <h1>Make something.</h1>
        <p>Describe what you need, then choose Slides, a Document, a Spreadsheet, a Website or a web search.</p>
      </header>

      <label class="ai-prompt" for="ai-prompt">
        <span class="ai-prompt-label">What should the AI make?</span>
        <textarea id="ai-prompt" rows="4" maxlength="8000" spellcheck="true"
          placeholder="Create a six-slide deck about local-first browsing…"></textarea>
      </label>

      <section class="ai-key-card" aria-labelledby="ai-key-title">
        <div class="ai-key-copy">
          <strong id="ai-key-title">Connect NVIDIA NIM</strong>
          <span id="ai-key-status" role="status">Checking the API key…</span>
        </div>
        <div class="ai-key-controls">
          <select id="ai-nvidia-model" aria-label="NVIDIA model">${nvidiaModelOptions()}</select>
          <input id="ai-nvidia-key" type="password" maxlength="512" autocomplete="off" spellcheck="false"
            placeholder="nvapi-..." aria-label="NVIDIA API key"/>
          <button class="btn-primary" id="ai-save-nvidia-key" type="button">Save &amp; verify</button>
          <button class="btn-secondary" id="ai-test-nvidia-models" type="button">Test models</button>
        </div>
      </section>

      <div class="ai-grid" role="group" aria-label="AI actions">
        ${ARTIFACTS.map((item) => `
          <button class="ai-card" type="button" data-ai-type="${item.type}">
            <span class="ai-card-badge">${escapeHtml(item.badge)}</span>
            <strong>${escapeHtml(item.label)}</strong>
            <span>${escapeHtml(item.hint)}</span>
            <em>Generate →</em>
          </button>`).join('')}
        <button class="ai-card ai-card-search" type="button" data-ai-search>
          <span class="ai-card-badge">SRCH</span>
          <strong>Web search</strong>
          <span>Search the web with your current engine</span>
          <em>Open results →</em>
        </button>
      </div>

      <p class="ai-engine" id="ai-engine">Checking for the generation engine…</p>
      <p class="ai-note">Generated files stay on this machine. Provider usage is billed by your configured model provider.</p>
    </div>`;

  const prompt = $('#ai-prompt');
  if (prompt) {
    prompt.value = draft;
    prompt.addEventListener('input', () => { draft = prompt.value; });
    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        openGenerationDialog({ type: 'docx', prompt: prompt.value });
      }
    });
    prompt.focus();
  }

  host.querySelectorAll('[data-ai-type]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.getAttribute('data-ai-type');
      openGenerationDialog({ type, prompt: $('#ai-prompt')?.value ?? '' });
    });
  });
  host.querySelector('[data-ai-search]')?.addEventListener('click', searchWeb);

  const keyInput = $('#ai-nvidia-key');
  const keyButton = $('#ai-save-nvidia-key');
  const testButton = $('#ai-test-nvidia-models');
  const modelSelect = $('#ai-nvidia-model');
  const keyStatus = $('#ai-key-status');
  let currentInfo = null;

  const applyEngineInfo = (info) => {
    currentInfo = info;
    if (modelSelect) {
      const selected = info?.model || modelSelect.value || DEFAULT_NVIDIA_MODEL;
      modelSelect.innerHTML = nvidiaModelOptions(info?.models, selected);
    }
    const status = $('#ai-engine');
    if (status) {
      status.classList.toggle('ready', !!info?.supported);
      status.textContent = info?.supported
        ? 'Generation engine ready.'
        : (info?.detail || 'Generation engine not available yet — cards explain what is missing.');
    }
    if (keyStatus) {
      keyStatus.textContent = info?.api_key_configured
        ? 'A verified NVIDIA key is saved for this profile.'
        : 'Paste an NVIDIA API key from build.nvidia.com.';
    }
    if (keyInput) {
      keyInput.placeholder = info?.api_key_configured
        ? 'Saved key — paste a new one to replace it'
        : 'nvapi-...';
    }
  };

  const saveKey = async () => {
    const key = keyInput?.value.trim() ?? '';
    if (!key && !currentInfo?.api_key_configured) {
      toast('Paste an NVIDIA API key first.');
      keyInput?.focus();
      return;
    }
    if (key && !/^nvapi-[A-Za-z0-9_-]{10,}$/.test(key)) {
      toast('Paste a complete NVIDIA API key starting with nvapi-.');
      keyInput?.focus();
      return;
    }
    const model = modelSelect?.value || currentInfo?.model || DEFAULT_NVIDIA_MODEL;
    const label = keyButton?.textContent ?? 'Save & verify';
    if (keyButton) {
      keyButton.disabled = true;
      keyButton.textContent = 'Verifying…';
    }
    try {
      const result = await api.saveNvidiaKey(key, model);
      if (keyInput) keyInput.value = '';
      toast(result?.detail ?? 'NVIDIA key verified and saved.');
      const info = await api.generationInfo().catch(() => null);
      if (info) applyEngineInfo(info);
      else if (keyStatus) keyStatus.textContent = 'NVIDIA key verified and saved.';
    } catch (error) {
      toast(`NVIDIA key not saved: ${error?.message ?? error}`);
    } finally {
      if (keyButton) {
        keyButton.disabled = false;
        keyButton.textContent = label;
      }
    }
  };

  keyButton?.addEventListener('click', saveKey);
  testButton?.addEventListener('click', async () => {
    const key = keyInput?.value.trim() ?? '';
    if (!key && !currentInfo?.api_key_configured) {
      toast('Paste an NVIDIA API key first.');
      keyInput?.focus();
      return;
    }
    if (key && !/^nvapi-[A-Za-z0-9_-]{10,}$/.test(key)) {
      toast('Paste a complete NVIDIA API key starting with nvapi-.');
      keyInput?.focus();
      return;
    }
    const label = testButton.textContent;
    testButton.disabled = true;
    testButton.textContent = 'Testing…';
    try {
      const results = await api.testNvidiaModels(key);
      const working = results.filter((result) => result.ok);
      if (working.length > 0) {
        if (modelSelect) modelSelect.value = working[0].model;
        if (keyStatus) {
          keyStatus.textContent = `Responding: ${working.map((result) => nvidiaModelLabel(result.model)).join(', ')}`;
        }
        toast(`${working.length} NVIDIA model${working.length === 1 ? '' : 's'} responded.`);
      } else {
        const first = results[0]?.detail || 'No NVIDIA model responded.';
        if (keyStatus) keyStatus.textContent = first;
        toast('No NVIDIA model responded. Check the API key.');
      }
    } catch (error) {
      toast(`Model test failed: ${error?.message ?? error}`);
    } finally {
      testButton.disabled = false;
      testButton.textContent = label;
    }
  });
  keyInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    saveKey();
  });

  api.generationInfo()
    .then(applyEngineInfo)
    .catch(() => {
      const status = $('#ai-engine');
      if (status) status.textContent = 'Generation is available in the installed app.';
      if (keyStatus) keyStatus.textContent = 'Paste an NVIDIA API key from build.nvidia.com.';
    });
}

async function searchWeb() {
  const query = $('#ai-prompt')?.value.trim() ?? '';
  if (!query) {
    toast('Type what you want to search for first.');
    $('#ai-prompt')?.focus();
    return;
  }
  await createTab();
  await navigate(query);
  document.dispatchEvent(new CustomEvent('govind:render'));
}
