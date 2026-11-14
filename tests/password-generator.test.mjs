import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../ui/js/lib/password-generator.js', import.meta.url), 'utf8');

test('generates a 24-character password using the secure random API', () => {
  const context = { window: { crypto: webcrypto } };
  runInNewContext(`${source}\nglobalThis.result = generateStrongPassword();`, context);
  assert.match(context.result, /^[A-Za-z0-9!@#$%&*+=?_\\-]{24}$/);
});

test('does not fall back when secure randomness is unavailable', () => {
  const context = { window: { crypto: {} } };
  assert.throws(
    () => runInNewContext(`${source}\ngenerateStrongPassword();`, context),
    /getRandomValues/,
  );
});
