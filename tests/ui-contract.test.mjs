#!/usr/bin/env node
/**
 * tests/ui-contract.test.mjs — ROT: the chrome UI, the runtime, and
 * contracts/ipc.md must agree (contract §0: "nothing crosses a boundary
 * that is not named here").
 *
 * Checks (static, no build needed):
 *   C1  every command a chrome UI invokes is declared in contract §3/§8.2
 *   C2  every event a chrome UI listens for is named somewhere in the contract
 *   C3  every event the Rust runtime emits is named somewhere in the contract
 *   C4  honesty greps on every chrome UI: no alert()-toasts, no fabricated
 *       security verdicts, no localStorage persistence
 *
 * Both UIs are scanned (existence-guarded): the interim `shell/shell.js`
 * (current frontendDist) and the real `browser/ui/chrome.js` (G-3 flip).
 * Known limitation: commands passed to a wrapper as a variable (not a
 * string literal) are invisible to this scan — it can only prove breaches,
 * never certify their absence.
 *
 * Run: node tests/ui-contract.test.mjs     (exit 0 = conformant)
 * Also run as the "ui-contract" gate in scripts/gate-all.mjs.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

const contract = read("contracts/ipc.md");
const mainRs = read("src-tauri/src/main.rs");
const runtimeRs = read("src-tauri/src/runtime.rs");

const failures = [];
const check = (id, ok, detail) => {
  if (!ok) failures.push(`${id}: ${detail}`);
};

// --- declared commands: contract §3 table + §8.2 addendum table ----------
function section(from, to) {
  const a = contract.indexOf(from);
  const b = contract.indexOf(to, a + 1);
  if (a < 0) throw new Error(`contract section missing: ${from}`);
  return contract.slice(a, b < 0 ? contract.length : b);
}
const cmdSections = section("## 3. Commands", "## 4. URL policy") +
  section("### 8.2 Additive commands", "### 8.3");
const declaredCommands = new Set(
  [...cmdSections.matchAll(/\|\s*`([a-z_]+)`\s*\|/g)].map((m) => m[1]),
);

// --- declared events: any dotted/colon event name mentioned in the contract
const declaredEvents = new Set(
  [...contract.matchAll(/`([a-z][a-z0-9_]*[.:][a-z_]+)`/g)].map((m) => m[1]),
);

// Tauri 2.12 validates event names to [alnum / : _] - dotted names are
// rejected on both emit and listen (contract §10). A name containing "."
// can therefore never cross the wire; this check pins that mechanically.
const TAURI_EVENT_NAME = /^[A-Za-z0-9/_:-]+$/;

// --- the chrome UIs (existence-guarded so the G-3 flip cannot break this)
const uis = [
  {
    file: "src-tauri/shell/shell.js",
    cmd: [/\brun\(\s*"([a-z_]+)"/g, /\binvoke\(\s*"([a-z_]+)"/g],
    evt: [/\blisten\(\s*"([a-z_]+[.:][a-z_]+)"/g],
  },
  {
    file: "browser/ui/chrome.js",
    cmd: [/\bcmd\(\s*"([a-z_]+)"/g, /\binvoke\(\s*"([a-z_]+)"/g],
    evt: [/\bonEvent\(\s*"([a-z_]+[.:][a-z_]+)"/g, /\blisten\(\s*"([a-z_]+[.:][a-z_]+)"/g],
  },
];
const present = uis.filter((u) => existsSync(path.join(root, u.file)));
if (present.length === 0) {
  console.log("FAIL — no chrome UI found (neither shell.js nor chrome.js)");
  process.exit(1);
}

let uiCmdTotal = 0;
let uiEvtTotal = 0;
for (const ui of present) {
  const js = read(ui.file);
  const name = ui.file.split("/").pop();

  // C1: UI invokes
  const uiCommands = new Set(ui.cmd.flatMap((re) => [...js.matchAll(re)].map((m) => m[1])));
  uiCmdTotal += uiCommands.size;
  for (const c of uiCommands)
    check("C1", declaredCommands.has(c),
      `${name} invokes \`${c}\` which is not declared in contract §3/§8.2 (declare it, see PLAN Govinda G-2)`);

  // C2: UI listeners (declared AND wire-legal per contract §10)
  const uiEvents = new Set(ui.evt.flatMap((re) => [...js.matchAll(re)].map((m) => m[1])));
  uiEvtTotal += uiEvents.size;
  for (const e of uiEvents) {
    check("C2", TAURI_EVENT_NAME.test(e),
      `${name} listens for \`${e}\` - Tauri 2 rejects dotted event names on both ends (contract §10), so this listener can never receive`);
    check("C2", declaredEvents.has(e),
      `${name} listens for \`${e}\` which the contract never names (declare it in contracts/ipc.md)`);
  }

  // C4: honesty greps per UI
  check("C4", !/\balert\(/.test(js),
    `${name} uses alert(): toasts/alerts are not a feature surface (AGENTS.md §6)`);
  check("C4", !/Peer Reviewed|verified|trusted badge/i.test(js),
    `${name} contains a fabricated security/credibility claim (AGENTS.md §6: no security verdicts)`);
  check("C4", !/localStorage\.(get|set)Item/.test(js),
    `${name} touches localStorage: persistence goes through the store IPC only (Devi's request)`);
}

// --- C3: runtime emissions (declared AND wire-legal per contract §10) -----
const rustEmissions = new Set(
  [...`${mainRs}\n${runtimeRs}`.matchAll(/\bemit\(\s*"([a-z_]+[.:][a-z_]+)"/g)].map((m) => m[1]),
);
for (const e of rustEmissions) {
  check("C3", TAURI_EVENT_NAME.test(e),
    `runtime emits \`${e}\` - Tauri 2 rejects dotted event names; emit would fail (contract §10)`);
  check("C3", declaredEvents.has(e),
    `runtime emits \`${e}\` which the contract never names (declare it in contracts/ipc.md)`);
}

// --- report ----------------------------------------------------------------
console.log(`ui-contract: ${declaredCommands.size} commands / ${declaredEvents.size} events declared in contract`);
console.log(`             UIs scanned: ${present.map((u) => u.file.split("/").pop()).join(", ")} — invokes ${uiCmdTotal}, listens ${uiEvtTotal}; runtime emits ${rustEmissions.size} event(s)`);
if (failures.length) {
  console.log(`FAIL — ${failures.length} conformance breach(es):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("PASS — UIs, runtime, and contract agree");
