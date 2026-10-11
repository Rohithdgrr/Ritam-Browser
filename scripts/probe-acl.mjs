// ROT security probe: can a content webview (and a REMOTE page inside it)
// invoke privileged commands? Contract §1 + capabilities/chrome.json say no.
// Evidence-gathering only; does not modify app state beyond one navigation.
const port = process.argv[2] || "9333";
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = list.find((t) => t.url.includes("newtab"));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

const TEST = `window.__TAURI__ ? window.__TAURI__.core.invoke("tab_list").then(r => "ALLOWED active=" + r.active_tab_id).catch(e => "DENIED " + (e.code || e.message || JSON.stringify(e))) : "no __TAURI__ global"`;

console.log("app-origin content webview (newtab.html):", JSON.stringify(await ev(`({ tauri: typeof window.__TAURI__, invoke: ${TEST} })`)));
await ev(`location.href = "https://example.com"`);
await new Promise((r) => setTimeout(r, 6000));
console.log("navigated to:", JSON.stringify(await ev(`location.href`)));
console.log("REMOTE page in content webview:", JSON.stringify(await ev(`({ tauri: typeof window.__TAURI__, invoke: ${TEST} })`)));
ws.close();
process.exit(0);
