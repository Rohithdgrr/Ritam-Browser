// ROT verification probe: inspect + drive the running Ritam chrome webview
// over CDP (WebView2 remote debugging). Read-only inspection plus one real
// nav_submit, to reproduce the `tab_not_found: tab 0` bug with evidence.
const port = process.argv[2] || "9333";
let list = null;
for (let i = 0; i < 25 && !list; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
  catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!list) { console.log(`no CDP endpoint on ${port}`); process.exit(1); }
const chrome = list.find((t) => t.url.endsWith("/") && !t.url.includes("newtab"));
if (!chrome) { console.log("no chrome target"); process.exit(1); }

const ws = new WebSocket(chrome.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result;
};

console.log("== tab_list (runtime's own answer) ==");
console.log(JSON.stringify(await evaluate(`window.__TAURI__.core.invoke("tab_list")`), null, 1));

console.log("== chrome DOM state ==");
console.log(JSON.stringify(await evaluate(`({
  status: document.getElementById("status")?.textContent,
  tabsStrip: [...document.querySelectorAll("#tabs .tab")].map(t => ({ id: t.dataset.tabId, sel: t.getAttribute("aria-selected"), title: t.textContent })),
  omnibox: document.getElementById("omnibox")?.value,
  enginePill: document.getElementById("engine-pill")?.textContent,
})`), null, 1));

console.log("== drive: real nav_submit via the omnibox form ==");
await evaluate(`(() => {
  const o = document.getElementById("omnibox");
  o.value = "example.com";
  document.getElementById("omnibox-form").requestSubmit();
  return true; })()`);
await new Promise((r) => setTimeout(r, 8000));
console.log(JSON.stringify(await evaluate(`({
  status: document.getElementById("status")?.textContent,
  omnibox: document.getElementById("omnibox")?.value,
  title: document.title,
  tabList: null,
})`), null, 1));
console.log("== tab_list after submit ==");
console.log(JSON.stringify(await evaluate(`window.__TAURI__.core.invoke("tab_list")`), null, 1));
ws.close();
process.exit(0);
