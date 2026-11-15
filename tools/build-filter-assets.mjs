#!/usr/bin/env node
// Regenerates the ad-blocker assets bundled into the app.
//
//   node tools/build-filter-assets.mjs
//
// The output lives in src-tauri/filter-assets/ and is compiled into the binary
// (`include_str!` / `include_bytes!`), so a fresh install blocks ads before it
// ever reaches the network. The app still refreshes these files at runtime;
// this script is only needed to update the built-in snapshot.
//
// Upstream licenses are retained in the manifest and in each list's comments:
//   - EasyList / EasyPrivacy: CC BY-SA 3.0 or GPLv3
//   - uBlock Origin filters and scriptlets: GPLv3
//   - adblock-rust engine: MPL-2.0

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'filter-assets');
const UBLOCK_TARBALL = 'https://codeload.github.com/gorhill/uBlock/tar.gz/refs/heads/master';
const UBLOCK_COMMIT_API = 'https://api.github.com/repos/gorhill/uBlock/commits/master';
const USER_AGENT = 'GovindBrowser/0.1 (filter-asset builder)';

const LISTS = [
  {
    file: 'easylist.txt',
    url: 'https://easylist.to/easylist/easylist.txt',
    title: 'EasyList',
    needle: 'easylist',
    license: 'CC BY-SA 3.0 / GPLv3',
  },
  {
    file: 'easyprivacy.txt',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    title: 'EasyPrivacy',
    needle: 'easyprivacy',
    license: 'CC BY-SA 3.0 / GPLv3',
  },
  {
    file: 'ublock-filters.txt',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/filters.min.txt',
    title: 'uBlock filters – Ads',
    needle: 'ublock filters',
    license: 'GPLv3',
    trusted: true,
  },
  {
    file: 'ublock-quick-fixes.txt',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/quick-fixes.min.txt',
    title: 'uBlock filters – Quick fixes',
    needle: 'quick fixes',
    license: 'GPLv3',
    trusted: true,
  },
  {
    file: 'ublock-unbreak.txt',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/unbreak.min.txt',
    title: 'uBlock filters – Unbreak',
    needle: 'unbreak',
    license: 'GPLv3',
    trusted: true,
  },
  {
    file: 'ublock-badware.txt',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/badware.min.txt',
    title: 'uBlock filters – Badware risks',
    needle: 'badware',
    license: 'GPLv3',
    trusted: true,
  },
  {
    file: 'ublock-privacy.txt',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/privacy.min.txt',
    title: 'uBlock filters – Privacy',
    needle: 'privacy',
    license: 'GPLv3',
    trusted: true,
  },
  {
    file: 'ublock-resource-abuse.txt',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt',
    title: 'uBlock filters – Resource abuse',
    needle: 'resource abuse',
    license: 'GPLv3',
    trusted: true,
    minRules: 40,
  },
];

function log(message) {
  console.log(`[filter-assets] ${message}`);
}

async function download(url, what) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function validateList(buffer, list) {
  const text = buffer.toString('utf8');
  if (text.length < 1000 || text.length > 20 * 1024 * 1024) {
    throw new Error(`${list.file}: unexpected size ${text.length}`);
  }
  if (/^\s*<(!doctype|html)/i.test(text.slice(0, 200))) {
    throw new Error(`${list.file}: got an HTML error page`);
  }
  const header = text.slice(0, 4000).toLowerCase();
  if (!header.includes(list.needle)) {
    throw new Error(`${list.file}: missing expected title marker "${list.needle}"`);
  }
  const rules = text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('!')).length;
  if (rules < (list.minRules ?? 100)) {
    throw new Error(`${list.file}: only ${rules} rules`);
  }
  return { text, rules };
}

function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.js':
      return { mime: 'application/javascript' };
    case '.css':
      return { mime: 'text/css' };
    case '.gif':
      return { mime: 'image/gif' };
    case '.png':
      return { mime: 'image/png' };
    case '.html':
      return { mime: 'text/html' };
    case '.json':
      return { mime: 'application/json' };
    case '.mp3':
      return { mime: 'audio/mp3' };
    case '.mp4':
      return { mime: 'video/mp4' };
    case '.xml':
      return { mime: 'text/xml' };
    default:
      return { mime: 'text/plain' };
  }
}

async function extractUblock() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'govind-ubo-'));
  log('downloading uBlock Origin source snapshot');
  await fs.writeFile(
    path.join(temp, 'ublock.tar.gz'),
    await download(UBLOCK_TARBALL, 'uBlock Origin tarball'),
  );
  const sourceDir = path.join(temp, 'src');
  await fs.mkdir(sourceDir, { recursive: true });
  execFileSync('tar', ['-xzf', 'ublock.tar.gz', '-C', 'src', '--strip-components=1'], {
    cwd: temp,
    stdio: 'inherit',
  });
  return { temp, root: sourceDir };
}

// adblock-rust only invokes scriptlet resources that start with a named
// `function` declaration (it extracts the name and appends `(...)`). uBlock
// Origin also ships `async function` scriptlets and class-style helpers.
// Classes are dependency-only and are emitted verbatim; async functions are
// wrapped so they keep a named, synchronous entry point.
function normalizeScriptletSource(raw) {
  const source = raw.trimStart();
  if (/^function\s+[^\s({]+\s*\(/.test(source)) {
    return { source, helper: false };
  }
  if (/^class\s+[^\s({]+/.test(source)) {
    return { source, helper: true };
  }
  const asyncMatch = /^async\s+function\s+([^\s({]+)\s*\(/.exec(source);
  if (!asyncMatch) return null;

  const openParen = asyncMatch[0].lastIndexOf('(');
  let depth = 0;
  let closeParen = -1;
  let quote = '';
  let escaped = false;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) { closeParen = i; break; }
    }
  }
  if (closeParen < 0) return null;
  const openBrace = source.indexOf('{', closeParen);
  if (openBrace < 0) return null;
  const closeBrace = source.lastIndexOf('}');
  if (closeBrace <= openBrace) return null;

  const header = source.slice(0, openBrace).replace(/^async\s+/, '');
  const body = source.slice(openBrace + 1, closeBrace);
  return {
    source: `${header} { return (async () => {${body}})(); }`,
    helper: false,
  };
}

async function buildResources(uboRoot) {
  const scriptletsPath = path.join(uboRoot, 'src', 'js', 'resources', 'scriptlets.js');
  const redirectsPath = path.join(uboRoot, 'src', 'js', 'redirect-resources.js');
  const resources = new Map();

  const scriptletsModule = await import(pathToFileURL(scriptletsPath).href);
  const scriptlets = scriptletsModule.builtinScriptlets ?? [];
  let skippedFunctions = 0;
  let helperResources = 0;
  for (const scriptlet of scriptlets) {
    if (!scriptlet?.name || typeof scriptlet.fn !== 'function') continue;
    const normalized = normalizeScriptletSource(scriptlet.fn.toString());
    if (normalized === null) {
      // adblock-rust can only invoke named function-style scriptlet resources.
      skippedFunctions++;
      log(`skipping non-function scriptlet ${scriptlet.name}`);
      continue;
    }
    if (normalized.helper) helperResources++;
    resources.set(scriptlet.name, {
      name: scriptlet.name,
      aliases: Array.isArray(scriptlet.aliases) ? scriptlet.aliases : [],
      kind: 'template',
      content: Buffer.from(normalized.source, 'utf8').toString('base64'),
      dependencies: Array.isArray(scriptlet.dependencies) ? scriptlet.dependencies : [],
      permission: scriptlet.requiresTrust ? 1 : 0,
    });
  }

  const redirectsModule = await import(pathToFileURL(redirectsPath).href);
  const redirectMap = redirectsModule.default;
  if (!(redirectMap instanceof Map)) {
    throw new Error('uBlock redirect-resources.js did not export a Map');
  }
  for (const [file, properties] of redirectMap) {
    if (properties?.params) continue; // adblock-rust does not support parameterized resources yet
    const content = await fs.readFile(path.join(uboRoot, 'src', 'web_accessible_resources', file));
    const alias = properties?.alias;
    resources.set(file, {
      name: file,
      aliases: Array.isArray(alias) ? alias : alias ? [alias] : [],
      kind: mimeFor(file),
      content: content.toString('base64'),
      dependencies: [],
      permission: 0,
    });
  }

  const sorted = [...resources.values()].sort((a, b) => a.name.localeCompare(b.name));
  const json = JSON.stringify(sorted);
  log(`${sorted.length} resources (${skippedFunctions} scriptlets skipped, ${helperResources} class helpers)`);
  return { json, count: sorted.length };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const manifest = {
    generatedAt: new Date().toISOString(),
    engine: 'adblock-rust 0.13.5 (MPL-2.0)',
    lists: [],
    resources: null,
  };

  for (const list of LISTS) {
    log(`downloading ${list.title}`);
    const buffer = await download(list.url, list.title);
    const { rules } = validateList(buffer, list);
    const target = path.join(OUT_DIR, list.file);
    await fs.writeFile(target, buffer);
    const text = buffer.toString('utf8');
    const modified = /^!\s*(?:Last modified|TimeUpdated):\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
    manifest.lists.push({
      file: list.file,
      title: list.title,
      url: list.url,
      license: list.license,
      trusted: Boolean(list.trusted),
      rules,
      modified,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    });
    log(`  ${list.file}: ${rules} rules`);
  }

  const ubo = await extractUblock();
  try {
    const commit = await fetch(UBLOCK_COMMIT_API, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data?.sha ?? '')
      .catch(() => '');
    const { json, count } = await buildResources(ubo.root);
    await fs.writeFile(path.join(OUT_DIR, 'resources.json'), json);
    manifest.resources = {
      url: `https://github.com/gorhill/uBlock${commit ? `/commit/${commit}` : ''}`,
      license: 'GPLv3',
      count,
      sha256: createHash('sha256').update(json).digest('hex'),
    };
    log(`${count} resources written`);
  } finally {
    await fs.rm(ubo.temp, { recursive: true, force: true });
  }

  await fs.writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  log(`done → ${path.relative(ROOT, OUT_DIR)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
