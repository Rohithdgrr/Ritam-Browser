import test from 'node:test';
import assert from 'node:assert/strict';

const {
  GENERATION_TYPES,
  INITIAL_GENERATION_STATE,
  folderOf,
  formatElapsed,
  generationReducer,
  typeLabel,
  validatePrompt,
} = await import('../ui/js/lib/generation.js');

test('generation types mirror the backend allowlist', () => {
  assert.deepEqual(GENERATION_TYPES.map((item) => item.id), ['pptx', 'xlsx', 'docx', 'website']);
  assert.equal(typeLabel('website'), 'Website');
  assert.equal(typeLabel('unknown'), 'Document');
});

test('prompts are required, trimmed and bounded', () => {
  assert.match(validatePrompt('   '), /Write a prompt/);
  assert.match(validatePrompt('x'.repeat(8001)), /under 8000/);
  assert.equal(validatePrompt('A short deck'), null);
});

test('a generation run tracks progress, job id and success', () => {
  let state = generationReducer(INITIAL_GENERATION_STATE, { type: 'type', value: 'pptx' });
  assert.equal(state.type, 'pptx');
  state = generationReducer(state, { type: 'prompt', value: ' Make slides ' });
  state = generationReducer(state, { type: 'start' });
  assert.equal(state.status, 'generating');
  assert.equal(state.jobId, null);

  state = generationReducer(state, {
    type: 'progress', jobId: 'job-1', phase: 'engine', message: 'ready', at: 1,
  });
  state = generationReducer(state, {
    type: 'progress', jobId: 'job-1', phase: 'model', message: 'thinking', at: 2,
  });
  assert.equal(state.jobId, 'job-1');
  assert.deepEqual(state.progress.map((line) => line.message), ['ready', 'thinking']);

  state = generationReducer(state, { type: 'success', result: { path: 'C:\\out\\deck.pptx' } });
  assert.equal(state.status, 'success');
  assert.equal(state.result.path, 'C:\\out\\deck.pptx');
});

test('progress history is capped for the dialog', () => {
  let state = generationReducer(INITIAL_GENERATION_STATE, { type: 'start' });
  for (let index = 0; index < 20; index += 1) {
    state = generationReducer(state, {
      type: 'progress', jobId: 'job-1', phase: 'step', message: `line ${index}`, at: index,
    });
  }
  assert.equal(state.progress.length, 12);
  assert.equal(state.progress.at(-1).message, 'line 19');
});

test('cancel and error are terminal dialog states; reset keeps the chosen type', () => {
  let state = generationReducer(INITIAL_GENERATION_STATE, { type: 'type', value: 'xlsx' });
  state = generationReducer(state, { type: 'start' });
  state = generationReducer(state, { type: 'cancel' });
  assert.equal(state.status, 'cancelled');

  state = generationReducer(state, { type: 'error', message: 'boom' });
  assert.equal(state.error, 'boom');

  state = generationReducer(state, { type: 'reset' });
  assert.equal(state.status, 'idle');
  assert.equal(state.type, 'xlsx');
  assert.equal(state.prompt, '');
});

test('the live generation clock formats seconds, minutes and hours', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(5_400), '0:05');
  assert.equal(formatElapsed(65_000), '1:05');
  assert.equal(formatElapsed(3_725_000), '1:02:05');
  assert.equal(formatElapsed(-1), '0:00');
});

test('website folders are derived for both path separators', () => {
  assert.equal(folderOf('C:\\Users\\me\\generations\\site\\index.html'), 'C:\\Users\\me\\generations\\site');
  assert.equal(folderOf('/home/me/generations/site/index.html'), '/home/me/generations/site');
  assert.equal(folderOf('index.html'), 'index.html');
  assert.equal(folderOf(''), '');
});
