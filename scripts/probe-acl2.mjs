// ROT security probe part 2: with `awaitPromise`, invoke is the top-level
// expression so its resolved value (ALLOWED/DENIED) is captured. Targets the
// content webview, which was left on https://example.com by probe-acl.mjs.
const port = process.argv[2] || "9336";
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = list.find((t) => t.url.includes("example.com"));
if (!tab) { console.log("no content webview on example.com; targets:", list.map(t => t.url)); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evFull = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result;
const ev = async (e) => (await evFull(e))?.result?.value;

console.log("url:", await ev(`location.href`));
console.log("typeof __TAURI__:", await ev(`typeof window.__TAURI__`));
console.log("invoke tab_list from REMOTE page:", JSON.stringify(await ev(
  `window.__TAURI__.core.invoke("tab_list").then(r => "ALLOWED active=" + r.active_tab_id).catch(e => "DENIED " + (e.code || e.message || JSON.stringify(e)))`
)));
console.log("invoke external_open from REMOTE page (must stay denied):", JSON.stringify(await ev(
  `window.__TAURI__.core.invoke("external_open", { url: "https://example.org" }).then(() => "ALLOWED (!!)").catch(e => "DENIED " + (e.code || e.message || JSON.stringify(e)))`
)));
ws.close();
process.exit(0);
