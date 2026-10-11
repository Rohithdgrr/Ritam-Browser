// ROT probe 2 (read-mostly): against the running instance. Confirms whether
// the stale-UI-activeTabId bug is repaired by a real tab_select, and whether
// navigation then works end-to-end. Evidence for the PLAN.md launch-blocker.
const port = process.argv[2] || "9333";
let list = null;
for (let i = 0; i < 15 && !list; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
  catch { await new Promise((r) => setTimeout(r, 1000)); }
}
const chrome = list.find((t) => t.url === "http://tauri.localhost/" || t.url === "http://tauri.localhost/index.html");
const ws = new WebSocket(chrome.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

console.log("== click the real tab (selectTab path) ==");
console.log(JSON.stringify(await evaluate(`(() => { document.querySelector('#tabs .tab').click(); return 'clicked'; })()`)));
await new Promise((r) => setTimeout(r, 1200));
console.log("== status after click ==");
console.log(JSON.stringify(await evaluate(`document.getElementById("status").textContent`)));

console.log("== drive real navigation (omnibox -> example.com) ==");
await evaluate(`(() => { const o = document.getElementById("omnibox"); o.value = "example.com"; document.getElementById("omnibox-form").requestSubmit(); return true; })()`);
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await evaluate(`({ status: document.getElementById("status").textContent, title: document.title, omni: document.getElementById("omnibox").value, sel: document.querySelector('#tabs .tab')?.getAttribute('aria-selected') })`);
  console.log(`t+${(i + 1) * 2}s: ${JSON.stringify(s)}`);
  if (s && s.status && s.status.startsWith("Loading")) break;
}
console.log("== tab_list after ==");
console.log(JSON.stringify(await evaluate(`window.__TAURI__.core.invoke("tab_list")`)));
console.log("== content webview targets ==");
console.log(JSON.stringify((await (await fetch(`http://127.0.0.1:${port}/json`)).json()).map((t) => ({ title: t.title, url: t.url })), null, 1));
ws.close();
process.exit(0);
