// ROT cold-start verification v2 for the tab-0 fix (PLAN.md item 10).
// Picks the CHROME webview by exact URL (v1 grabbed the content webview),
// checks the strip shows a selected tab at startup, then drives a real
// omnibox submit WITHOUT any click - the exact path that failed live.
const port = process.argv[2] || "9336";
let list = null;
for (let i = 0; i < 25 && !list; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
  catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!list) { console.log("FAIL: no CDP endpoint"); process.exit(1); }
const chrome = list.find((t) => t.url === "http://tauri.localhost/" || t.url === "http://tauri.localhost/index.html");
if (!chrome) { console.log("no chrome target; targets:", list.map((t) => t.url)); process.exit(1); }
const ws = new WebSocket(chrome.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

const strip = await ev(`[...document.querySelectorAll('#tabs .tab')].map(t => ({ id: t.dataset.tabId, sel: t.getAttribute('aria-selected') }))`);
console.log("strip:", JSON.stringify(strip));
console.log(Array.isArray(strip) && strip.some((t) => t.sel === "true")
  ? "PASS: a tab is selected at startup"
  : "FAIL: no selected tab (stale activeTabId still live)");

console.log("== drive submit WITHOUT clicking (the original failing path) ==");
await ev(`(() => { const o = document.getElementById("omnibox"); o.value = "example.com"; document.getElementById("omnibox-form").requestSubmit(); return true; })()`);
let ok = false;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await ev(`({ status: document.getElementById("status").textContent, omni: document.getElementById("omnibox").value })`);
  console.log(`t+${(i + 1) * 2}s: ${JSON.stringify(s)}`);
  if (s && s.status && s.status.startsWith("Loading")) { ok = true; break; }
  if (s && s.status && s.status.includes("tab_not_found")) { console.log("FAIL: tab_not_found still reproduced"); break; }
}
console.log(ok ? "PASS: navigation started from cold start with no click" : "FAIL: navigation did not start");
console.log("tab_list:", JSON.stringify(await ev(`window.__TAURI__.core.invoke("tab_list")`)));
ws.close();
process.exit(0);
