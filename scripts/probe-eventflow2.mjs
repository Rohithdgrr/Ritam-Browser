// ROT event-flow verification part 2: a SECOND in-content navigation must
// produce can_go_back=true (real history entry), which can only reach the
// chrome via nav:state events. Distinguishes "newtab replace is not history"
// (correct) from "can_go_back never updates" (bug).
const port = process.argv[2] || "9338";
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const chromeT = list.find((t) => t.url === "http://tauri.localhost/" || t.url === "http://tauri.localhost/index.html");
const contentT = list.find((t) => t.url.includes("example.com"));
if (!chromeT || !contentT) { console.log("targets:", list.map((t) => t.url)); process.exit(1); }
const open = (t) => new Promise((res, rej) => { const w = new WebSocket(t.webSocketDebuggerUrl); w.onopen = () => res(w); w.onerror = rej; });
const mk = (ws) => {
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
};
const chrome = mk(await open(chromeT));
const content = mk(await open(contentT));

console.log("before:", JSON.stringify(await chrome(`({ omni: document.getElementById("omnibox").value, back: document.getElementById("back").disabled })`)));
await content(`location.href = "https://example.org"`);
let ok = false;
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const s = await chrome(`({ omni: document.getElementById("omnibox").value, back: document.getElementById("back").disabled })`);
  console.log(`t+${(i + 1) * 1.5}s:`, JSON.stringify(s));
  if (s && s.omni.includes("example.org") && s.back === false) { ok = true; break; }
}
console.log(ok
  ? "PASS: nav:state events update omnibox AND can_go_back (real history)"
  : "FAIL: can_go_back still not reflected after a real history entry");
process.exit(ok ? 0 : 1);
