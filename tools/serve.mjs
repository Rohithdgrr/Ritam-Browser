#!/usr/bin/env node
/** Zero-dependency static file server for previewing the UI (no build step). */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../ui', import.meta.url));
const port = Number(process.env.PORT || 8081);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let rel = normalize(urlPath).replace(/^([/\\])+/, '');
    if (rel.startsWith('..')) throw new Error('path traversal blocked');
    if (rel === '' || rel.endsWith('/')) rel = join(rel, 'index.html');
    const file = join(root, rel);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Govind UI preview → http://0.0.0.0:${port}/`);
});
