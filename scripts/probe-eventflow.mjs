// ROT event-flow verification (contract §10 fix): navigate the CONTENT
// webview directly over CDP - no chrome command runs - so the only way the
// chrome can update (omnibox, back button) is by receiving real `nav:state`
// events. Proves the previously-dead event channel actually works now.
const port = process.argv[2] || "9338";
let list = null;
for (let i = 0; i < 25 && !list; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
  catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!list) { console.log("FAIL: no CDP endpoint"); process.exit(1); }
const chromeT = list.find((t) => t.url === "http://tauri.localhost/" || t.url === "http://tauri.localhost/index.html");
const contentT = list.find((t) => t.url.includes("newtab"));
if (!chromeT || !contentT) { console.log("targets missing:", list.map((t) => t.url)); process.exit(1); }

const open = (t) => new Promise((res, rej) => { const w = new WebSocket(t.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
const mk = (ws) => {
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
};
const chrome = mk(await open(chromeT));
const content = mk(await open(contentT));

console.log("before:", JSON.stringify(await chrome(`({ omni: document.getElementById("omnibox").value, back: document.getElementById("back").disabled, status: document.getElementById("status").textContent })`)));
console.log("navigating CONTENT webview directly (no chrome command)...");
await content(`location.href = "https://example.com"`);
let ok = false;
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const s = await chrome(`({ omni: document.getElementById("omnibox").value, back: document.getElementById("back").disabled, status: document.getElementById("status").textContent })`);
  console.log(`t+${(i + 1) * 1.5}s:`, JSON.stringify(s));
  if (s && s.omni && s.omni.includes("example.com") && s.back === false) { ok = true; break; }
}
console.log(ok
  ? "PASS: chrome updated from nav:state events alone (omnibox + back button)"
  : "FAIL: chrome did not reflect the content navigation - events still not arriving");
process.exit(ok ? 0 : 1);
