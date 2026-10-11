// ROT cold-start verification for the tab-0 fix (PLAN.md item 10):
// launch the app fresh, then WITHOUT any click, inspect the strip and drive
// a real omnibox submit. Pass = selected tab at startup + navigation starts.
const port = process.argv[2] || "9333";
let list = null;
for (let i = 0; i < 20 && !list; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!list) { console.log("FAIL: no CDP endpoint"); process.exit(1); }
const chrome = list.find((t) => t.url.startsWith("http://tauri.localhost"));
const ws = new WebSocket(chrome.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

const strip = await evaluate(`[...document.querySelectorAll('#tabs .tab')].map(t => ({ id: t.dataset.tabId, sel: t.getAttribute('aria-selected') }))`);
console.log("strip at cold start:", JSON.stringify(strip));
const selected = strip.some((t) => t.sel === "true");
console.log(selected ? "PASS: a tab is selected at startup" : "FAIL: no selected tab (bug still live)");

console.log("== drive submit WITHOUT clicking (the original failing path) ==");
await evaluate(`(() => { const o = document.getElementById("omnibox"); o.value = "example.com"; document.getElementById("omnibox-form").requestSubmit(); return true; })()`);
let ok = false;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await evaluate(`({ status: document.getElementById("status").textContent, omni: document.getElementById("omnibox").value })`);
  console.log(`t+${(i + 1) * 2}s: ${JSON.stringify(s)}`);
  if (s && s.status && s.status.startsWith("Loading")) { ok = true; break; }
  if (s && s.status && s.status.includes("tab_not_found")) { console.log("FAIL: tab_not_found still reproduced"); break; }
}
console.log(ok ? "PASS: navigation started from a cold start with no click" : "FAIL: navigation did not start");
console.log("tab_list:", JSON.stringify(await evaluate(`window.__TAURI__.core.invoke("tab_list")`)));
ws.close();
process.exit(0);
