#!/usr/bin/env node
// Ritam Browser - CDP capture probe (ROT, scripts/).
//
// Question this answers (before any app code claims it): can the UI transport
// (obscura serve + CDP) produce the SAME bytes as the CLI truth-source for the
// operation "give me this page"? Specifically:
//   1. `--dump html`  vs  CDP-captured doctype + document.documentElement.outerHTML
//   2. `--eval <EXPR>` vs  the identical expression over Runtime.evaluate
//   3. does performance navigation `responseStatus` exist in-page (real status
//      reachable from BOTH paths, so parity can cover it)?
//
// Usage: node scripts/probe-cdp-html.mjs [stageName ...]
// Read-only w.r.t. obscura-benchmark: fixtures are served over loopback.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN =
  process.env.OBSCURA_BIN ?? path.join(ROOT, "tools", "obscura-bin", "obscura.exe");
const FIXTURES = path.join(ROOT, "obscura-benchmark", "obstacle-course", "fixtures");
const MANIFEST = path.join(ROOT, "obscura-benchmark", "obstacle-course", "manifest.json");

// The candidate adapter expression: one eval, one navigation, everything the UI
// needs. Returns a STRING so both paths JSON-encode it identically.
const EXPR = `(function(){
  var nav = null;
  try { nav = performance.getEntriesByType('navigation')[0] || null; } catch (e) {}
  var dt = document.doctype;
  var doctype = dt ? ('<!DOCTYPE ' + dt.name
    + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : '')
    + (dt.systemId ? ' "' + dt.systemId + '"' : '')
    + '>') : '';
  return JSON.stringify({
    title: document.title,
    url: location.href,
    status: nav ? (nav.responseStatus === undefined ? null : nav.responseStatus) : null,
    html: doctype + document.documentElement.outerHTML
  });
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
};

function serveFixtures(port) {
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, "http://x").pathname);
    const file = path.join(FIXTURES, name);
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

async function startServe(port) {
  const child = spawn(BIN, ["serve", "--port", String(port), "--allow-private-network"], {
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return child;
    } catch {}
    await sleep(500);
  }
  child.kill();
  throw new Error("obscura serve did not become ready");
}

function connectCDP(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    const call = (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const mid = ++id;
        const timer = setTimeout(() => {
          pending.delete(mid);
          rej(new Error(`${method} timed out`));
        }, 30000);
        pending.set(mid, { res, rej, timer });
        const msg = { id: mid, method, params };
        if (sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
      });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });
    ws.addEventListener("open", () => resolve({ ws, call, onEvent: (fn) => listeners.push(fn) }), {
      once: true,
    });
    ws.addEventListener("error", reject, { once: true });
  });
}

function cli(args) {
  return new Promise((resolve) => {
    const proc = spawn(BIN, args, { encoding: "utf8" });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr.on("data", (d) => (err += d.toString("utf8")));
    const killer = setTimeout(() => proc.kill(), 60000);
    proc.on("close", () => {
      clearTimeout(killer);
      resolve({ out, err });
    });
  });
}

// --- main ------------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const wanted = process.argv.slice(2);
const stages = (manifest.stages ?? manifest).filter(
  (s) => wanted.length === 0 ? ["extract-html", "static", "url"].includes(s.name) : wanted.includes(s.name),
);
if (!stages.length) {
  console.error("no matching stages");
  process.exit(2);
}

const httpPort = await freePort();
const cdpPort = await freePort();
const httpServer = await serveFixtures(httpPort);
const serve = await startServe(cdpPort);
const cdp = await connectCDP(cdpPort);

let allOk = true;
for (const stage of stages) {
  const url = `http://127.0.0.1:${httpPort}/${stage.file}`;
  const label = stage.name;

  // Path 1: CLI truth-source
  const dump = await cli(["fetch", url, "--allow-private-network", "--quiet",
    "--timeout", "20", "--wait", "3", "--dump", "html"]);
  const ev = await cli(["fetch", url, "--allow-private-network", "--quiet",
    "--timeout", "20", "--wait", "3", "--eval", EXPR]);

  // Path 2: CDP transport
  const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
  const events = [];
  const off = (m) => cdp.onEvent((msg) => { if (msg.sessionId === sessionId) events.push(msg); });
  off();
  await cdp.call("Page.enable", {}, sessionId);
  await cdp.call("Network.enable", {}, sessionId);
  events.length = 0;
  const nav = await cdp.call("Page.navigate", { url }, sessionId);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (events.some((e) => e.method === "Page.loadEventFired")) break;
    if (nav.errorText) break;
    await sleep(100);
  }
  await sleep(3000); // settle floor (same policy as CLI --wait 3)

  const docResponses = events
    .filter((e) => e.method === "Network.responseReceived" && e.params?.type === "Document")
    .map((e) => ({ url: e.params.response?.url, status: e.params.response?.status, frameId: e.params.frameId }));
  const evRes = await cdp.call(
    "Runtime.evaluate",
    { expression: EXPR, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  const cdpValue = evRes?.result?.value;
  await cdp.call("Target.closeTarget", { targetId }).catch(() => {});

  // --- comparisons
  let parsed = null;
  try { parsed = JSON.parse(cdpValue); } catch {}
  const cdpJsonEncoded = JSON.stringify(cdpValue); // what CLI --eval prints
  const evalOk = ev.out.trim() === cdpJsonEncoded;
  const htmlOk = parsed ? parsed.html === dump.out : false;

  console.log(`--- ${label} (${stage.file})`);
  console.log(`  eval byte-parity (CLI vs CDP) : ${evalOk ? "IDENTICAL" : "DIFFER"}`);
  if (!evalOk) {
    console.log(`    cli: ${JSON.stringify(ev.out.slice(0, 160))}`);
    console.log(`    cdp: ${JSON.stringify(cdpJsonEncoded.slice(0, 160))}`);
  }
  console.log(`  dump html vs CDP html         : ${htmlOk ? "IDENTICAL" : "DIFFER"}`);
  if (!htmlOk && parsed) {
    console.log(`    cli len=${dump.out.length} cdp len=${parsed.html.length}`);
    for (let i = 0; i < Math.min(dump.out.length, parsed.html.length); i++) {
      if (dump.out[i] !== parsed.html[i]) {
        console.log(`    first diff at ${i}: cli=${JSON.stringify(dump.out.slice(i, i + 60))} cdp=${JSON.stringify(parsed.html.slice(i, i + 60))}`);
        break;
      }
    }
  }
  console.log(`  title: ${JSON.stringify(parsed?.title)}  url: ${JSON.stringify(parsed?.url)}`);
  console.log(`  status in-page(responseStatus): ${JSON.stringify(parsed?.status)}  | CDP Document responses: ${JSON.stringify(docResponses)}`);
  console.log(`  Page.navigate result: ${JSON.stringify(nav)}`);
  if (!evalOk || !htmlOk) allOk = false;
}

cdp.ws.close();
serve.kill();
httpServer.close();
console.log(allOk ? "\nPROBE OK: CDP path byte-identical to CLI on all probed stages" : "\nPROBE DIFFERS: see above");
process.exit(allOk ? 0 : 1);
