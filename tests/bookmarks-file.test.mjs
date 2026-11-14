import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBookmarksHtml, buildBookmarksHtml } from '../ui/js/lib/bookmarks-file.js';

const SAMPLE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<DL><p>
    <DT><A HREF="https://example.com/">Example — &amp; Co</A>
    <DT><A HREF='https://quoted.org/x'>Single quoted</A>
    <DT><A HREF="https://dup.com/a">First</A>
    <DT><A HREF="https://dup.com/a">Second</A>
    <DT><A HREF="javascript:void(0)">Evil</A>
    <DT><A HREF="https://nested.com">Some <b>bold</b> title</A>
</DL><p>`;

test('parses a browser-exported bookmarks html file', () => {
  const items = parseBookmarksHtml(SAMPLE);
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], { title: 'Example — & Co', url: 'https://example.com/' });
  assert.equal(items[1].url, 'https://quoted.org/x');
});

test('dedupes by url, keeps the first title, skips non-http urls', () => {
  const items = parseBookmarksHtml(SAMPLE);
  assert.equal(items[2].title, 'First');
  assert.ok(!items.some((i) => i.url.startsWith('javascript:')));
});

test('strips nested markup from titles', () => {
  const items = parseBookmarksHtml(SAMPLE);
  assert.equal(items[3].title, 'Some bold title');
});

test('round-trips through the export format', () => {
  const bookmarks = [
    { title: 'Govind & friends <3', url: 'https://govind.test/' },
    { title: 'x', url: 'file:///nope' },
  ];
  const html = buildBookmarksHtml(bookmarks);
  const parsed = parseBookmarksHtml(html);
  assert.deepEqual(parsed, [{ title: 'Govind & friends <3', url: 'https://govind.test/' }]);
});

test('parses empty input to []', () => {
  assert.deepEqual(parseBookmarksHtml(''), []);
  assert.deepEqual(parseBookmarksHtml(null), []);
});
