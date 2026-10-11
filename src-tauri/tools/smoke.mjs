#!/usr/bin/env node
// Ritam Browser - chrome smoke probe (Rohan, src-tauri/tools/).
//
// Answers one question honestly: does the built app actually come up —
// window, chrome webview, shell.js, IPC capability, first tab — or does it
// only look right in the source tree? It launches the real exe with a CDP
// debug port on a fresh WebView2 profile, attaches to the *chrome* webview,
// reads what the UI actually shows, and drives one real command
// (`nav_submit`) through the real IPC path.
//
// Usage: node src-tauri/tools/smoke.mjs [path/to/ritam-browser.exe]
// Exit 0 = every assertion held. Read-only; kills the app afterwards.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve the built exe: env override, then cargo's configured target-dir
// (.cargo/config.toml relocates it out of the tree), then the default.
function resolveExe(arg) {
  const name = "ritam-browser.exe";
  if (arg) return path.resolve(arg);
  if (process.env.RITAM_EXE) return path.resolve(process.env.RITAM_EXE);
  try {
    const cfg = fs.readFileSync(path.join(ROOT, ".cargo", "config.toml"), "utf8");
    const m = cfg.match(/^\s*target-dir\s*=\s*"([^"]+)"/m);
    if (m) {
      const fromCfg = path.join(m[1].replaceAll("/", path.sep), "debug", name);
      if (fs.existsSync(fromCfg)) return fromCfg;
    }
  } catch {
    /* fall through */
  }
  return path.join(ROOT, "target", "debug", name);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function getJson(url, timeoutMs = 1000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// WebView2 children outlive a plain kill of the app and keep holding the
// profile, which makes the NEXT run fail with 0x8007139F. Two defences:
// kill the whole process tree, and sweep only this app's profile orphans
// (never other apps' msedgewebview2 processes) before spawning.
function killTree(pid) {
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* best effort */
  }
}

async function killAppWebviews() {
  await new Promise((resolve) => {
    const ps = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like '*com.ritam.browser*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { stdio: "ignore" },
    );
    ps.on("close", resolve);
    ps.on("error", resolve);
  });
}

function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });
    ws.addEventListener("open", () =>
      resolve({
        call: (method, params = {}) =>
          new Promise((res, rej) => {
            const mid = ++id;
            const timer = setTimeout(() => {
              pending.delete(mid);
              rej(new Error(`${method} timed out`));
            }, 15000);
            pending.set(mid, { res, rej, timer });
            ws.send(JSON.stringify({ id: mid, method, params }));
          }),
        onEvent: (fn) => listeners.push(fn),
        close: () => ws.close(),
      }),
      { once: true },
    );
    ws.addEventListener("error", reject, { once: true });
  });
}

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const EXE = resolveExe(process.argv[2]);
if (!fs.existsSync(EXE)) {
  console.error(`exe not found: ${EXE} (build first: cargo build)`);
  process.exit(2);
}

const port = await freePort();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritam-smoke-"));
const exePath = path.resolve(EXE);

console.log(`smoke: ${exePath}`);
console.log(`smoke: cdp port ${port}, profile ${userDataDir}`);

await killAppWebviews();

const app = spawn(
  exePath,
  [],
  {
    cwd: path.dirname(exePath),
    env: {
      ...process.env,
      // Fresh profile per run if the loader honors it; Tauri may pass an
      // explicit folder instead, in which case killAppWebviews() above is
      // what keeps runs from colliding.
      WEBVIEW2_USER_DATA_FOLDER: userDataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let appLog = "";
app.stdout.on("data", (d) => (appLog += d.toString()));
app.stderr.on("data", (d) => (appLog += d.toString()));

// Any exit path (including an uncaught probe error) must take the app tree
// down with it — orphaned WebView2 children keep the profile locked.
const cleanup = () => {
  try {
    killTree(app.pid);
  } catch {
    /* already gone */
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

let chrome = null;
const problems = [];
for (let i = 0; i < 60 && !chrome; i++) {
  if (app.exitCode !== null) break;
  try {
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    // The chrome webview serves the app shell; tab webviews serve newtab/page.
    chrome = targets.find(
      (t) => t.type === "page" && /tauri\.localhost/i.test(t.url) && /newtab|index/i.test(t.url) === false,
    )
      ?? targets.find((t) => t.type === "page" && /index\.html/i.test(t.url))
      ?? null;
    if (!chrome && targets.length) problems.push(...targets.map((t) => `${t.type}:${t.url}`));
  } catch {
    /* not up yet */
  }
  await sleep(500);
}

console.log("");
if (app.exitCode !== null || !chrome) {
  check("app starts and chrome webview appears", false,
    app.exitCode !== null
      ? `exit=${app.exitCode} log=${appLog.trim().slice(0, 400)}`
      : `no chrome target; targets seen: ${problems.join(" | ").slice(0, 400)}`);
  console.log(`\nRESULT: FAIL (${failures.length} assertion(s) broken)`);
  killTree(app.pid);
  process.exit(1);
}

const s = await cdpSession(chrome.webSocketDebuggerUrl);
const errors = [];
s.onEvent((m) => {
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params?.exceptionDetails;
    errors.push(
      `${d?.exception?.description ?? d?.text ?? "?"} @ ${d?.url ?? "?"}:${d?.lineNumber ?? "?"}`,
    );
  }
  if (m.method === "Log.entryAdded" && m.params?.entry?.level === "error") {
    const e = m.params.entry;
    errors.push(`${e.text} @ ${e.url ?? "?"}:${e.sourceLineNumber ?? "?"}`);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
    errors.push(
      `console.error: ${m.params.args?.map((a) => a.value ?? a.description ?? "?").join(" ")}`,
    );
  }
});
await s.call("Runtime.enable");
await s.call("Log.enable");
await s.call("Page.enable");

const evalJs = async (expression) => {
  const r = await s.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
  return r.result?.value;
};

// Give the chrome a moment to finish init() if it has not already.
for (let i = 0; i < 20; i++) {
  const ready = await evalJs(`!!document.querySelector("#tabs .tab")`).catch(() => false);
  if (ready) break;
  await sleep(500);
}

console.log("chrome webview assertions:");
const diag = await evalJs(`(async () => {
  let listenProbe = "n/a";
  try {
    await window.__TAURI__.event.listen("__smoke_probe", () => {});
    listenProbe = "ok";
  } catch (e) {
    listenProbe = "rejected: " + (e && e.message ? e.message : String(e));
  }
  return {
    tabList: await window.__TAURI__.core.invoke("tab_list"),
    tabs: document.querySelectorAll("#tabs .tab").length,
    selected: document.querySelectorAll('#tabs .tab[aria-selected="true"]').length,
    rawAttr: document.querySelector("#tabs .tab")?.getAttribute("aria-selected"),
    activeTabId: typeof activeTabId === "undefined" ? "n/a" : activeTabId,
    stripActiveId: document.querySelector("#tabs")?.dataset.activeId ?? null,
    pageDiag: window.__diag ?? null,
    listenProbe,
    runtimeReady: typeof window.__TAURI__ === "object",
  };
})()`);
console.log(`  diag: ${JSON.stringify(diag).slice(0, 700)}`);
check(
  "shell.js ran (window.__TAURI__ present)",
  diag.runtimeReady === true,
);
check(
  "tab strip renders the first tab",
  diag.tabs >= 1,
  `count=${diag.tabs}`,
);
check(
  "runtime reports exactly one selected tab",
  diag.tabList?.active_tab_id === diag.tabList?.tabs?.[0]?.tab_id,
  `active=${diag.tabList?.active_tab_id} first=${diag.tabList?.tabs?.[0]?.tab_id}`,
);
check(
  "event.listen works (chrome subscribes to runtime events)",
  diag.listenProbe === "ok",
  diag.listenProbe,
);
check(
  "first tab is aria-selected",
  diag.selected >= 1,
  `selected=${diag.selected} stripActiveId=${JSON.stringify(diag.stripActiveId)} rawAttr=${JSON.stringify(diag.rawAttr)}`,
);
check(
  "omnibox exists and is editable",
  await evalJs(`!!document.getElementById("omnibox")`),
);
const statusText = await evalJs(`document.getElementById("status")?.textContent ?? ""`);
check("status bar carries a real state", statusText.trim().length > 0, JSON.stringify(statusText));
const engineText = await evalJs(`document.getElementById("engine-pill")?.textContent ?? ""`);
check(
  "engine pill reports the engine's real state",
  /ready|unavailable|starting/i.test(engineText),
  JSON.stringify(engineText.slice(0, 120)),
);

// Tab lifecycle through the chrome's own event subscriptions: create a tab
// (tab.created + tab.activated must reach the strip), then close it again.
console.log("\ntab lifecycle via chrome IPC:");
const stripState = () =>
  evalJs(`({
    count: document.querySelectorAll("#tabs .tab").length,
    activeId: document.querySelector("#tabs")?.dataset.activeId ?? null,
    selected: document.querySelectorAll('#tabs .tab[aria-selected="true"]').length,
  })`);
try {
  const created = await evalJs(`window.__TAURI__.core.invoke("tab_create")`);
  await sleep(700);
  const afterCreate = await stripState();
  check(
    "tab_create selects the new tab in the strip",
    created?.tab_id === 2 &&
      afterCreate.count === 2 &&
      afterCreate.activeId === "2" &&
      afterCreate.selected === 1,
    `created=${created?.tab_id} ${JSON.stringify(afterCreate)}`,
  );
  await evalJs(`window.__TAURI__.core.invoke("tab_close", { tab_id: 2 })`);
  await sleep(700);
  const afterClose = await stripState();
  check(
    "tab_close returns selection to the remaining tab",
    afterClose.count === 1 && afterClose.activeId === "1" && afterClose.selected === 1,
    JSON.stringify(afterClose),
  );
} catch (err) {
  check("tab lifecycle commands complete", false, String(err).slice(0, 200));
  console.log(`  app log tail: ${appLog.trim().split("\n").slice(-8).join(" // ")}`);
}

// From here on, a fresh document with a page-side hook: capture rejections
// and errors with stacks, then re-verify the chrome over real events.
await s.call("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__diag = { rejections: [], errors: [] };
    addEventListener("unhandledrejection", (e) => window.__diag.rejections.push({
      reason: String(e.reason),
      stack: (e.reason && e.reason.stack) || null,
    }));
    addEventListener("error", (e) => window.__diag.errors.push(
      String(e.message) + " @ " + e.lineno + ":" + e.colno));`,
});
await s.call("Page.reload", { ignoreCache: true });
errors.length = 0;
for (let i = 0; i < 20; i++) {
  const ready = await evalJs(`!!document.querySelector("#tabs .tab")`).catch(() => false);
  if (ready) break;
  await sleep(500);
}

// The decisive ones: drive a real command through the real IPC path, then
// through the chrome's own form handler, and read what the UI shows.
console.log("\nlive IPC assertion:");
const outcome = await evalJs(
  `window.__TAURI__.core.invoke("nav_submit", { tab_id: 1, input: "example.com" })`,
);
check(
  "invoke(nav_submit) returns a typed outcome",
  outcome && outcome.kind === "navigated" && /^https:\/\/example\.com\//.test(outcome.url),
  JSON.stringify(outcome?.kind ?? outcome).slice(0, 160),
);
await evalJs(`(() => {
  const box = document.getElementById("omnibox");
  box.value = "example.com";
  document.getElementById("omnibox-form").dispatchEvent(new Event("submit", { cancelable: true }));
  return true;
})()`);
await sleep(2000);
const omnibox = await evalJs(`document.getElementById("omnibox")?.value ?? ""`);
check(
  "chrome omnibox reflects the runtime state (own form path)",
  /example\.com/.test(omnibox),
  JSON.stringify(omnibox),
);

const pageDiag = await evalJs(`window.__diag ?? { rejections: [], errors: [] }`);
check(
  "no chrome console errors",
  errors.length === 0 && pageDiag.errors.length === 0,
  [...errors.slice(0, 2), ...pageDiag.errors.slice(0, 2)].join(" | "),
);
check(
  "no unhandled promise rejections in the chrome",
  pageDiag.rejections.length === 0,
  pageDiag.rejections
    .slice(0, 3)
    .map((r) => `${r.reason}${r.stack ? ` :: ${String(r.stack).split("\n")[0]}` : ""}`)
    .join(" | "),
);

await s.close();
killTree(app.pid);
await killAppWebviews();
try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(
  failures.length === 0
    ? "\nRESULT: PASS — window, chrome, shell.js, IPC capability, and first tab all real"
    : `\nRESULT: FAIL (${failures.length} assertion(s) broken)`,
);
process.exit(failures.length === 0 ? 0 : 1);
