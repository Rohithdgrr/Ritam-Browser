import test from 'node:test';
import assert from 'node:assert/strict';
import {
  viewerKindFor,
  kindLabel,
  mimeFor,
  parseCsv,
  tableHtml,
  markdownToHtml,
  unzip,
} from '../ui/js/lib/file-preview.js';

test('formats are detected from the file extension', () => {
  assert.equal(viewerKindFor('holiday.JPG'), 'image');
  assert.equal(viewerKindFor('clip.webm'), 'video');
  assert.equal(viewerKindFor('notes.md'), 'markdown');
  assert.equal(viewerKindFor('report.docx'), 'docx');
  assert.equal(viewerKindFor('sheet.xlsx'), 'xlsx');
  assert.equal(viewerKindFor('pitch.pptx'), 'pptx');
  assert.equal(viewerKindFor('data.json'), 'json');
  assert.equal(viewerKindFor('README'), null);
  assert.equal(viewerKindFor('setup.exe'), null);
  assert.equal(kindLabel('pdf'), 'PDF');
  assert.equal(mimeFor('a.png'), 'image/png');
  assert.equal(mimeFor('a.exe'), null);
});

test('csv parses quotes, embedded newlines and CRLF', () => {
  const rows = parseCsv('name,note\r\n"Ada","two, commas"\r\n"Lin","line\nbreak"\r\n"Quo","say ""hi"""\r\n');
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['Ada', 'two, commas'],
    ['Lin', 'line\nbreak'],
    ['Quo', 'say "hi"'],
  ]);
});

test('csv keeps empty trailing fields and blank input', () => {
  assert.deepEqual(parseCsv('a,b,\n1,2,'), [['a', 'b', ''], ['1', '2', '']]);
  assert.deepEqual(parseCsv(''), []);
});

test('table markup escapes cell content', () => {
  const html = tableHtml([['<img src=x onerror=alert(1)>'], ['<script>']]);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('markdown escapes raw html and keeps the supported subset', () => {
  const html = markdownToHtml([
    '# Title',
    '',
    'Hello **bold** and *soft*.',
    '',
    '- one',
    '- two',
    '',
    '> quote',
    '',
    '```',
    '<b>code</b>',
    '```',
  ].join('\n'));

  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>soft</em>'));
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<li>one</li>'));
  assert.ok(html.includes('<blockquote>quote</blockquote>'));
  assert.ok(html.includes('&lt;b&gt;code&lt;/b&gt;'));
  assert.ok(!html.includes('<b>'));
});

test('markdown links stay limited to http(s)', () => {
  const safe = markdownToHtml('[site](https://example.com/a)');
  assert.ok(safe.includes('<a href="https://example.com/a"'));

  const unsafe = markdownToHtml('[x](javascript:alert(1))');
  assert.ok(!unsafe.includes('<a'));
  assert.ok(unsafe.includes('x'));
});

test('unzip reads a stored zip archive', async () => {
  const entries = await unzip(storedZip('word/document.xml', '<w:document/>'));
  assert.equal(new TextDecoder().decode(entries.get('word/document.xml')), '<w:document/>');
});

/** Minimal single-entry, stored (uncompressed) zip for the reader test. */
function storedZip(name, content) {
  const data = new TextEncoder().encode(content);
  const nameBytes = new TextEncoder().encode(name);

  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, data.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);

  const archive = new Uint8Array(local.length + central.length + end.length);
  archive.set(local, 0);
  archive.set(central, local.length);
  archive.set(end, local.length + central.length);
  return archive;
}
