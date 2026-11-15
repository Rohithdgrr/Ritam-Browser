/**
 * Pure state and validation for the WorkAny generation dialog.
 *
 * The native side owns the job and the files; this reducer only mirrors the
 * dialog transitions so they can be unit-tested without a DOM.
 */

export const MAX_PROMPT_CHARS = 8000;

export const GENERATION_TYPES = [
  { id: 'pptx', label: 'Slides', hint: 'PowerPoint (.pptx)' },
  { id: 'xlsx', label: 'Sheet', hint: 'Excel workbook (.xlsx)' },
  { id: 'docx', label: 'Document', hint: 'Word document (.docx)' },
  { id: 'website', label: 'Website', hint: 'Static site folder' },
];

export const INITIAL_GENERATION_STATE = Object.freeze({
  status: 'idle',
  type: 'docx',
  prompt: '',
  jobId: null,
  progress: [],
  result: null,
  error: '',
});

export function generationReducer(state, action) {
  switch (action?.type) {
    case 'type':
      return GENERATION_TYPES.some((item) => item.id === action.value)
        ? { ...state, type: action.value, error: '' }
        : state;
    case 'prompt':
      return { ...state, prompt: String(action.value ?? '').slice(0, MAX_PROMPT_CHARS) };
    case 'start':
      return {
        ...state,
        status: 'generating',
        jobId: null,
        progress: [],
        result: null,
        error: '',
      };
    case 'progress': {
      const line = {
        phase: String(action.phase ?? 'working'),
        message: String(action.message ?? ''),
        at: Number(action.at) || Date.now(),
      };
      const progress = [...state.progress, line].slice(-12);
      return {
        ...state,
        jobId: action.jobId ? String(action.jobId) : state.jobId,
        progress,
      };
    }
    case 'success':
      return { ...state, status: 'success', result: action.result ?? null, error: '' };
    case 'error':
      return {
        ...state,
        status: 'error',
        error: String(action.message ?? 'Generation failed.'),
      };
    case 'cancel':
      return {
        ...state,
        status: 'cancelled',
        error: '',
        jobId: state.jobId,
      };
    case 'reset':
      return { ...INITIAL_GENERATION_STATE, type: state.type };
    default:
      return state;
  }
}

/** `null` when valid, otherwise a user-facing message. */
export function validatePrompt(value) {
  const prompt = String(value ?? '').trim();
  if (!prompt) return 'Write a prompt before generating.';
  if (prompt.length > MAX_PROMPT_CHARS) {
    return `Keep the prompt under ${MAX_PROMPT_CHARS} characters.`;
  }
  return null;
}

export function typeLabel(type) {
  return GENERATION_TYPES.find((item) => item.id === type)?.label ?? 'Document';
}

/** Elapsed milliseconds → `m:ss`, or `h:mm:ss` past an hour. */
export function formatElapsed(milliseconds) {
  const total = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Folder containing a generated website entry file. */
export function folderOf(path) {
  const value = String(path ?? '');
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return index > 0 ? value.slice(0, index) : value;
}
