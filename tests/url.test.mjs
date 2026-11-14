import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInput, hostOf, originOf, schemeOf, displayUrl, monogram, searchEngineById,
} from '../ui/js/lib/url.js';

test('empty input → null', () => {
  assert.equal(normalizeInput(''), null);
  assert.equal(normalizeInput('   '), null);
  assert.equal(normalizeInput(null), null);
});

test('explicit https url passes through unchanged', () => {
  assert.deepEqual(normalizeInput('https://example.com/a?b=c'), { type: 'url', url: 'https://example.com/a?b=c' });
});

test('explicit http url is upgraded to https by default (https-first)', () => {
  assert.equal(normalizeInput('http://example.com').url, 'https://example.com');
});

test('explicit http url is kept when httpsFirst=false', () => {
  assert.equal(normalizeInput('http://example.com', { httpsFirst: false }).url, 'http://example.com');
});

test('localhost and IPs stay http', () => {
  assert.equal(normalizeInput('http://localhost:3000').url, 'http://localhost:3000');
  assert.equal(normalizeInput('localhost:3000').url, 'http://localhost:3000');
  assert.equal(normalizeInput('127.0.0.1:8080/path').url, 'http://127.0.0.1:8080/path');
});

test('bare domain gets https and preserves path', () => {
  assert.equal(normalizeInput('example.com').url, 'https://example.com');
  assert.equal(normalizeInput('docs.mozilla.org/en-US/docs').url, 'https://docs.mozilla.org/en-US/docs');
  assert.equal(normalizeInput('sub.domain.co.uk:8443/x').url, 'https://sub.domain.co.uk:8443/x');
});

test('queries with spaces become searches', () => {
  const out = normalizeInput('how do browsers work');
  assert.equal(out.type, 'search');
  assert.ok(out.url.startsWith('https://duckduckgo.com/?q='));
  assert.ok(out.url.includes('how%20do%20browsers%20work'));
});

test('single-word input becomes a search', () => {
  const out = normalizeInput('wikipedia');
  assert.equal(out.type, 'search');
});

test('selected search engine is honored', () => {
  const out = normalizeInput('tauri', { searchEngine: 'google' });
  assert.ok(out.url.startsWith('https://www.google.com/search?q='));
});

test('javascript: and file: schemes are never navigated — they become searches', () => {
  const js = normalizeInput('javascript:alert(1)');
  assert.equal(js.type, 'search');
  const file = normalizeInput('file:///etc/passwd');
  assert.equal(file.type, 'search');
});

test('about:blank is allowed, other about: are searched', () => {
  assert.equal(normalizeInput('about:blank').url, 'about:blank');
  assert.equal(normalizeInput('about:config').type, 'search');
});

test('govind://home internal route is preserved', () => {
  assert.equal(normalizeInput('govind://home').url, 'govind://home');
  assert.equal(normalizeInput('GOVIND://home/').url, 'govind://home');
});

test('hostOf / originOf / schemeOf', () => {
  assert.equal(hostOf('https://a.b.com/x'), 'a.b.com');
  assert.equal(hostOf('not a url'), null);
  assert.equal(originOf('https://a.b.com:8443/x?y'), 'https://a.b.com:8443');
  assert.equal(schemeOf('HTTPS://x.com'), 'https');
  assert.equal(schemeOf('govind://home'), 'govind');
});

test('displayUrl trims scheme and trailing slash', () => {
  assert.equal(displayUrl('https://example.com/'), 'example.com');
  assert.equal(displayUrl('govind://home'), '');
});

test('monogram produces a single uppercase letter', () => {
  assert.equal(monogram('https://www.github.com/'), 'G');
  assert.match(monogram('govind://home'), /^[A-Z?]$/);
});

test('searchEngineById falls back to duckduckgo', () => {
  assert.equal(searchEngineById('nope').id, 'duckduckgo');
});
