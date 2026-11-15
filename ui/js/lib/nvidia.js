/** NVIDIA NIM model choices shared by the AI workspace and settings. */

import { escapeHtml } from './dom.js';

export const DEFAULT_NVIDIA_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

export const NVIDIA_MODELS = [
  { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B' },
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B Instruct' },
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 Lightning 30B' },
  { id: 'nvidia/llama-3.1-nemotron-51b-instruct', label: 'Nemotron 51B Instruct' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
];

export function nvidiaModelLabel(id) {
  return NVIDIA_MODELS.find((model) => model.id === id)?.label ?? id;
}

/** Build `<option>` markup; the backend list wins, unknown ids fall back to the id. */
export function nvidiaModelOptions(models, selected) {
  const ids = Array.isArray(models) && models.length
    ? [...models]
    : NVIDIA_MODELS.map((model) => model.id);
  if (selected && !ids.includes(selected)) ids.unshift(selected);
  return ids.map((id) => `
    <option value="${escapeHtml(id)}" ${id === selected ? 'selected' : ''}>${escapeHtml(nvidiaModelLabel(id))}</option>
  `).join('');
}
