import test from 'node:test';
import assert from 'node:assert/strict';

const {
  filterRequests, formatMs, headerPairs, headersObject, prettyBody, statusTone, toCurl, toFetch,
} = await import('../ui/js/lib/inspector.js');

const request = {
  id: 'req-1',
  kind: 'fetch',
  method: 'POST',
  url: 'https://api.example.com/users?id=7',
  status: 201,
  duration_ms: 42,
  request_headers: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'X-Trace', value: "it's a trace" },
  ],
  request_body: '{"name":"Ada"}',
  response_headers: [{ name: 'Content-Type', value: 'application/json' }],
  response_body: '{"id":7}',
  content_type: 'application/json',
};

test('header helpers normalise pairs and objects', () => {
  assert.deepEqual(headerPairs([{ name: 'A', value: '1' }, { name: '', value: 'x' }]), [
    { name: 'A', value: '1' },
  ]);
  assert.deepEqual(headerPairs({ 'X-One': 1 }), [{ name: 'X-One', value: '1' }]);
  assert.deepEqual(headersObject([{ name: 'A', value: '1' }]), { A: '1' });
  assert.deepEqual(headerPairs(null), []);
});

test('cURL export quotes values safely', () => {
  const curl = toCurl(request);
  assert.ok(curl.startsWith("curl 'https://api.example.com/users?id=7'"));
  assert.ok(curl.includes('--request POST'));
  assert.ok(curl.includes("--header 'Content-Type: application/json'"));
  // The embedded apostrophe is shell-escaped, not left to break the command.
  assert.ok(curl.includes("--header 'X-Trace: it'\\''s a trace'"));
  assert.ok(curl.includes('--data-raw'));
});

test('cURL export omits the method and body for a GET', () => {
  const curl = toCurl({ method: 'GET', url: 'https://example.com/a', request_headers: [] });
  assert.equal(curl, "curl 'https://example.com/a'");
});

test('Fetch export is valid JavaScript with headers and body', () => {
  const code = toFetch(request);
  assert.ok(code.startsWith('fetch("https://api.example.com/users?id=7", {'));
  assert.ok(code.includes('"method": "POST"'));
  assert.ok(code.includes('"Content-Type": "application/json"'));
  assert.ok(code.includes('"body": "{\\"name\\":\\"Ada\\"}"'));
  // Compiling without calling it proves the generated snippet is valid JS.
  assert.doesNotThrow(() => new Function(code));
});

test('Fetch export skips a body on GET', () => {
  const code = toFetch({ method: 'GET', url: 'https://example.com', request_body: 'x' });
  assert.ok(!code.includes('"body"'));
});

test('JSON bodies are prettified and other bodies are untouched', () => {
  assert.equal(prettyBody('{"a":1}', 'application/json'), '{\n  "a": 1\n}');
  assert.equal(prettyBody('[1,2]', 'text/plain'), '[\n  1,\n  2\n]');
  assert.equal(prettyBody('<html><body>x</body></html>', 'text/html'), '<html><body>x</body></html>');
  assert.equal(prettyBody('not json', 'application/json'), 'not json');
  assert.equal(prettyBody('', 'application/json'), '');
});

test('request filtering matches URL, method and error status', () => {
  const rows = [
    request,
    { ...request, id: 'req-2', method: 'GET', url: 'https://cdn.example.com/logo.png', status: 0 },
    { ...request, id: 'req-3', url: 'https://api.example.com/broken', status: 500 },
  ];
  assert.equal(filterRequests(rows, { query: 'logo' }).length, 1);
  assert.equal(filterRequests(rows, { method: 'POST' }).length, 2);
  assert.equal(filterRequests(rows, { errorsOnly: true }).length, 1);
  assert.equal(filterRequests(rows, { query: 'broken', method: 'POST', errorsOnly: true }).length, 1);
  assert.equal(filterRequests(rows, { query: 'nothing' }).length, 0);
});

test('status tones and durations are stable', () => {
  assert.equal(statusTone(204), 'ok');
  assert.equal(statusTone(301), 'redirect');
  assert.equal(statusTone(404), 'warn');
  assert.equal(statusTone(503), 'bad');
  assert.equal(statusTone(0), 'muted');
  assert.equal(formatMs(42), '42 ms');
  assert.equal(formatMs(1500), '1.50 s');
});
