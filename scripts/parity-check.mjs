#!/usr/bin/env node
// Ritam Browser - accuracy parity harness (AGENTS.md rule 3, ROT-owned).
//
// Proves that the CDP path (the transport the UI will use from Phase 2)
// returns byte-identical results to `obscura fetch --eval` directly.
// Any diff is a rule-3 violation: fix the integration, never the engine.
//
// Usage:
//   OBSCURA_BIN=tools/obscura-bin/obscura.exe node scripts/parity-check.mjs
//
// No dependencies. Node 21+ (native WebSocket + fetch).
// Read-only w.r.t. obscura-benchmark: serves its fixtures over a local
// loopback HTTP server; modifies nothing.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN =
  process.env.OBSCURA_BIN ?? path.join(ROOT, "tools", "obscura-bin", "obscura.exe");
const FIXTURES = path.join(
  ROOT, "obscura-benchmark", "obstacle-course", "fixtures",
);
const MANIFEST = path.join(
  ROOT, "obscura-benchmark", "obstacle-course", "manifest.json",
);

// Fixed fixture set: representative eval stages across capability / web-api /
// scraping. Adding to this set is a ROT decision recorded in BASELINE_REPORT.
const STAGE_ALLOWLIST = [
  "timers", "spa-router", "web-component", "async-render",
  "url", "textdecoder", "fileapi", "selection", "dialog", "cookies",
];

const CLI_WAIT_SECS = 3;      // matches obstacle-course manifest wait policy
const CDP_SETTLE_MS = 3500;   // >= CLI wait, so both paths see the same settle
const CDP_POLL_MS = 8000;     // poll window for window.__obstacle to appear

const freePort = async () => {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- local fixture server (raw bytes: charset fixtures depend on it) -------
function serveFixtures(port) {
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, "http://x").pathname);
    const file = path.join(FIXTURES, name);
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(file)); // raw bytes, no re-encoding
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// --- obscura serve (CDP) ---------------------------------------------------
async function startServe(port) {
  const child = spawn(
    BIN,
    ["serve", "--port", String(port), "--allow-private-network"],
    { stdio: "ignore" },
  );
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

// --- minimal CDP client ----------------------------------------------------
function connectCDP(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`);
    let id = 0;
    const pending = new Map();
    const call = (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const mid = ++id;
        const timer = setTimeout(() => {
          pending.delete(mid);
          rej(new Error(`${method} timed out`));
        }, 20000);
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
      }
    });
    ws.addEventListener("open", () => resolve({ ws, call }), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

// --- path 1: CLI (the engine truth-source) ---------------------------------
function cliEval(url, check) {
  return new Promise((resolve) => {
    const proc = spawn(
      BIN,
      ["fetch", url, "--allow-private-network", "--quiet",
       "--timeout", "20", "--wait", String(CLI_WAIT_SECS), "--eval", check],
      { encoding: "utf8" },
    );
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString("utf8")));
    const killer = setTimeout(() => proc.kill(), 40000);
    proc.on("close", () => {
      clearTimeout(killer);
      resolve(out.trim());
    });
  });
}

// --- path 2: CDP (the UI transport) ----------------------------------------
async function cdpEval({ call }, httpPort, stage, check) {
  const url = `http://127.0.0.1:${httpPort}/${stage.file}`;
  const { targetId } = await call("Target.createTarget", { url });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  try {
    await call("Page.enable", {}, sessionId);
    // poll until the fixture writes its result, then apply the settle floor
    const t0 = Date.now();
    const deadline = t0 + CDP_POLL_MS;
    let value = null;
    while (Date.now() < deadline) {
      const r = await call(
        "Runtime.evaluate",
        { expression: check, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      value = r?.result?.value;
      if (value !== null && value !== "" && value !== "undefined") break;
      await sleep(250);
    }
    // settle floor: both paths must observe the same post-load settle window
    const remain = CDP_SETTLE_MS - (Date.now() - t0);
    if (remain > 0) await sleep(remain);
    const fin = await call(
      "Runtime.evaluate",
      { expression: check, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    return String(fin?.result?.value ?? "");
  } finally {
    await call("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// --- main ------------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
// manifest stages omit `type` when it is "eval" (run.py defaults it), so the
// filter must default too - otherwise the parity set silently shrinks.
const stageType = (s) => s.type ?? "eval";
const stages = (manifest.stages ?? manifest)
  .filter((s) => stageType(s) === "eval" && STAGE_ALLOWLIST.includes(s.name));
if (!stages.length) {
  console.error("no allowlisted eval stages found in manifest");
  process.exit(2);
}

const httpPort = await freePort();
const cdpPort = await freePort();
const httpServer = await serveFixtures(httpPort);
const serve = await startServe(cdpPort);
const cdp = await connectCDP(cdpPort);

console.log(`parity set: ${stages.length} stages | bin=${path.basename(BIN)}`);
let pass = 0;
const failures = [];
for (const stage of stages) {
  const cli = await cliEval(`http://127.0.0.1:${httpPort}/${stage.file}`, stage.check);
  const cdpOut = await cdpEval(cdp, httpPort, stage, stage.check);
  const ok = cli === cdpOut && cli.length > 0;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${stage.name.padEnd(14)} cli=${JSON.stringify(cli.slice(0, 60))} cdp=${JSON.stringify(cdpOut.slice(0, 60))}`,
  );
  if (ok) pass++;
  else failures.push({ name: stage.name, cli, cdp: cdpOut });
}

cdp.ws.close();
serve.kill();
httpServer.close();

console.log(`\nparity: ${pass}/${stages.length} byte-identical`);
if (failures.length) {
  for (const f of failures) {
    console.log(`MISMATCH ${f.name}\n  cli: ${JSON.stringify(f.cli)}\n  cdp: ${JSON.stringify(f.cdp)}`);
  }
  process.exit(1);
}
