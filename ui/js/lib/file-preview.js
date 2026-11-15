/**
 * Local file preview helpers for `govind://viewer`.
 *
 * Everything here parses bytes already selected by the user, in the renderer.
 * HTML is built from escaped text only — file content is never injected as
 * markup, and raw HTML inside Markdown is passed through as text.
 */

import { escapeHtml } from './dom.js';

// ── Format detection ─────────────────────────────────────────────────

const VIEWER_KINDS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'ogv'],
  pdf: ['pdf'],
  docx: ['docx'],
  xlsx: ['xlsx'],
  pptx: ['pptx'],
  csv: ['csv'],
  json: ['json'],
  markdown: ['md', 'markdown'],
  text: ['txt', 'log'],
};

/** Flat allowlist used by the file picker and the Rust reader. */
export const VIEWER_EXTENSIONS = Object.values(VIEWER_KINDS).flat();

/** `<input accept>` value for the browser preview fallback. */
export const VIEWER_ACCEPT = VIEWER_EXTENSIONS.map((ext) => `.${ext}`).join(',');

const KIND_LABELS = {
  image: 'Image',
  video: 'Video',
  pdf: 'PDF',
  docx: 'Word document',
  xlsx: 'Excel workbook',
  pptx: 'Presentation',
  csv: 'CSV',
  json: 'JSON',
  markdown: 'Markdown',
  text: 'Text',
};

const MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function extensionOf(name) {
  const dot = String(name ?? '').lastIndexOf('.');
  return dot < 0 ? '' : String(name).slice(dot + 1).toLowerCase();
}

/** `'report.docx'` → `'docx'`; unknown formats return null. */
export function viewerKindFor(name) {
  const ext = extensionOf(name);
  if (!ext) return null;
  for (const [kind, extensions] of Object.entries(VIEWER_KINDS)) {
    if (extensions.includes(ext)) return kind;
  }
  return null;
}

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? 'File';
}

/** MIME type for blob URLs; `null` means "let the browser guess". */
export function mimeFor(name) {
  return MIME_TYPES[extensionOf(name)] ?? null;
}

// ── CSV ──────────────────────────────────────────────────────────────

/**
 * RFC 4180-style rows: quoted fields, doubled quotes, embedded newlines.
 * A lone `\r` (classic Mac) is treated as a separator too.
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    started = false;
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      started = true;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      started = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    field += char;
    started = true;
  }
  if (started || field !== '' || row.length) endRow();
  return rows;
}

/** Rows → table markup. Cells are escaped; sparse rows are padded. */
export function tableHtml(rows, { maxRows = 2000, maxColumns = 60 } = {}) {
  const visible = rows.slice(0, maxRows);
  const width = Math.min(maxColumns, visible.reduce((widest, row) => Math.max(widest, row.length), 0));
  const head = visible[0] ?? [];
  const body = visible.slice(1);
  const cell = (tag, value) => `<${tag}>${escapeHtml(value ?? '')}</${tag}>`;
  const headHtml = `<thead><tr>${Array.from({ length: width }, (_, i) => cell('th', head[i])).join('')}</tr></thead>`;
  const bodyHtml = `<tbody>${body
    .map((row) => `<tr>${Array.from({ length: width }, (_, i) => cell('td', row[i])).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<div class="viewer-table-wrap"><table class="viewer-table">${headHtml}${bodyHtml}</table></div>`;
}

// ── Markdown ─────────────────────────────────────────────────────────

/**
 * Inline formatting on top of an already-escaped line. Every branch inserts
 * only tags this function writes, so file text can never become markup.
 */
function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    if (!/^https?:\/\//i.test(href)) return label;
    return `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });
  return html;
}

/** Small, deliberate Markdown subset: headings, lists, code, quotes, tables not included. */
export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null;
  let inCode = false;
  let code = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushCode = () => {
    out.push(`<pre class="viewer-code"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    code = [];
    inCode = false;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) flushCode();
      else { flushParagraph(); flushList(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      out.push('<hr>');
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    if (ordered || /^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const wanted = ordered ? 'ol' : 'ul';
      if (list !== wanted) { flushList(); out.push(`<${wanted}>`); list = wanted; }
      out.push(`<li>${inlineMarkdown(line.replace(/^\s*(?:\d+[.)]|[-*+])\s+/, ''))}</li>`);
      continue;
    }
    paragraph.push(line.trim());
  }

  if (inCode) flushCode();
  flushParagraph();
  flushList();
  return out.join('\n');
}

// ── Zip reader (DOCX / XLSX containers) ──────────────────────────────

function findEndOfCentralDirectory(view) {
  const minimum = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error('This file is not a valid Office document (zip directory missing).');
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This platform cannot decompress Office documents.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Entries of a zip archive, keyed by their forward-slash path.
 * Only what DOCX/XLSX files need: stored and deflated entries, no zip64.
 */
export async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== 0x04034b50) break;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) entries.set(name, compressed.slice());
    else if (method === 8) entries.set(name, await inflateRaw(compressed));
    // Other methods never appear in Office files this viewer targets.

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

const decodeXml = (bytes) => new TextDecoder().decode(bytes);

function parseXml(bytes, label) {
  if (!bytes) throw new Error(`This Office document is missing its ${label}.`);
  const doc = new DOMParser().parseFromString(decodeXml(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error(`The ${label} of this document could not be parsed.`);
  }
  return doc;
}

// ── DOCX ─────────────────────────────────────────────────────────────

const isOn = (element) => {
  if (!element) return false;
  const value = element.getAttribute('w:val');
  return value !== '0' && value !== 'false' && value !== 'none';
};

function docxRunHtml(run) {
  const props = run.getElementsByTagName('w:rPr')[0];
  let inner = '';
  for (const part of run.childNodes) {
    if (part.nodeType !== 1) continue;
    switch (part.localName) {
      case 't':
        inner += escapeHtml(part.textContent);
        break;
      case 'br':
      case 'cr':
        inner += '<br>';
        break;
      case 'tab':
        inner += '&emsp;';
        break;
      case 'noBreakHyphen':
        inner += '-';
        break;
      default:
        break;
    }
  }
  if (!inner) return '';
  if (props && isOn(props.getElementsByTagName('w:b')[0])) inner = `<strong>${inner}</strong>`;
  if (props && isOn(props.getElementsByTagName('w:i')[0])) inner = `<em>${inner}</em>`;
  if (props && isOn(props.getElementsByTagName('w:u')[0])) inner = `<u>${inner}</u>`;
  return inner;
}

function docxInlineHtml(node) {
  let html = '';
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    switch (child.localName) {
      case 'r':
        html += docxRunHtml(child);
        break;
      case 'hyperlink':
      case 'smartTag':
      case 'ins':
      case 'fldSimple':
      case 'sdt':
      case 'sdtContent':
        html += docxInlineHtml(child);
        break;
      // w:del is intentionally dropped: tracked deletions are not shown.
      default:
        break;
    }
  }
  return html;
}

function docxParagraphHtml(paragraph) {
  const style = paragraph.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') ?? '';
  const heading = /^Heading([1-6])$/i.exec(style);
  const tag = heading ? `h${heading[1]}` : style === 'Title' ? 'h1' : 'p';
  const inList = paragraph.getElementsByTagName('w:numPr').length > 0;
  const className = inList ? ' class="viewer-doc-list-item"' : '';
  const content = docxInlineHtml(paragraph) || '&nbsp;';
  return `<${tag}${className}>${content}</${tag}>`;
}

function docxTableHtml(table) {
  const rows = [...table.getElementsByTagName('w:tr')].map((row) => {
    const cells = [...row.getElementsByTagName('w:tc')].map((cell) => {
      const content = [...cell.childNodes]
        .filter((node) => node.nodeType === 1 && node.localName === 'p')
        .map(docxParagraphHtml)
        .join('');
      return `<td>${content || '&nbsp;'}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<div class="viewer-table-wrap"><table class="viewer-table">${rows}</table></div>`;
}

function docxBlocksHtml(node) {
  let html = '';
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    switch (child.localName) {
      case 'p':
        html += docxParagraphHtml(child);
        break;
      case 'tbl':
        html += docxTableHtml(child);
        break;
      case 'sdt':
      case 'sdtContent':
        html += docxBlocksHtml(child);
        break;
      default:
        break;
    }
  }
  return html;
}

/** DOCX → article HTML. */
export async function renderDocx(bytes) {
  const entries = await unzip(bytes);
  const documentXml = entries.get('word/document.xml');
  if (!documentXml) throw new Error('This file is not a Word document.');
  const doc = parseXml(documentXml, 'document body');
  const body = doc.getElementsByTagName('w:body')[0] ?? doc.documentElement;
  const html = docxBlocksHtml(body);
  if (!html) throw new Error('This document appears to be empty.');
  return `<article class="viewer-doc">${html}</article>`;
}

// ── PPTX ─────────────────────────────────────────────────────────────

function slideNumber(path) {
  return Number(/slide(\d+)\.xml$/i.exec(path)?.[1] ?? 0);
}

/** Text runs from one slide's XML, in document order. */
export function slideTexts(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return [];
  return [...doc.getElementsByTagName('a:t')]
    .map((node) => (node.textContent ?? '').trim())
    .filter(Boolean)
    .map((text) => text.slice(0, 2_000));
}

/** PPTX → a slide-by-slide text outline. Images and animations are not rendered. */
export async function renderPptx(bytes) {
  const entries = await unzip(bytes);
  const slides = [...entries.keys()]
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
    .slice(0, 200);
  if (!slides.length) throw new Error('This file is not a PowerPoint presentation.');

  const html = slides.map((path, index) => {
    let texts = [];
    try {
      texts = slideTexts(decodeXml(entries.get(path)));
    } catch {
      texts = [];
    }
    const title = texts[0] ?? '';
    const body = texts.slice(1);
    return `<section class="viewer-slide">
      <h3>Slide ${index + 1}${title ? ` · ${escapeHtml(title)}` : ''}</h3>
      ${body.length
        ? `<ul>${body.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
        : '<p class="viewer-muted">No text on this slide.</p>'}
    </section>`;
  }).join('');

  return `<article class="viewer-doc viewer-slides">
    <p class="viewer-muted">Text outline only — open the file in PowerPoint for slide design.</p>
    ${html}
  </article>`;
}

// ── XLSX ─────────────────────────────────────────────────────────────

function columnIndex(reference) {
  const letters = /^[A-Z]+/i.exec(reference ?? '')?.[0]?.toUpperCase() ?? '';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function sharedStrings(entry) {
  if (!entry) return [];
  const doc = parseXml(entry, 'shared strings table');
  return [...doc.getElementsByTagName('si')].map((item) => item.textContent ?? '');
}

function workbookSheetNames(entry) {
  if (!entry) return [];
  const doc = parseXml(entry, 'workbook');
  return [...doc.getElementsByTagName('sheet')].map((sheet) => sheet.getAttribute('name') ?? '');
}

function cellValue(cell, strings) {
  const type = cell.getAttribute('t') ?? '';
  if (type === 'inlineStr') {
    return [...cell.getElementsByTagName('t')].map((node) => node.textContent ?? '').join('');
  }
  const raw = cell.getElementsByTagName('v')[0]?.textContent ?? '';
  if (type === 's') return strings[Number(raw)] ?? '';
  return raw;
}

/**
 * XLSX → `[{ name, rows }]`. Rows are arrays of display strings, already
 * padded by `columnIndex`, so empty cells stay aligned.
 */
export async function readXlsx(bytes) {
  const entries = await unzip(bytes);
  const strings = sharedStrings(entries.get('xl/sharedStrings.xml'));
  const names = workbookSheetNames(entries.get('xl/workbook.xml'));
  const sheetPaths = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));

  if (!sheetPaths.length) throw new Error('This file is not an Excel workbook.');

  const sheets = sheetPaths.map((path, index) => {
    const doc = parseXml(entries.get(path), `worksheet ${index + 1}`);
    const rows = [];
    for (const row of doc.getElementsByTagName('row')) {
      const cells = [];
      for (const cell of row.getElementsByTagName('c')) {
        cells[columnIndex(cell.getAttribute('r') ?? '')] = cellValue(cell, strings);
      }
      rows.push(cells);
    }
    return { name: names[index] || `Sheet ${index + 1}`, rows };
  });

  return { sheets };
}
