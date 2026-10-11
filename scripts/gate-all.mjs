#!/usr/bin/env node
/**
 * gate-all.mjs — ROT's single entry point for the accuracy + test gates
 * (AGENTS.md §6, §7; ROT.md "Definition of done").
 *
 * Runs, in order (cheapest first):
 *   1. build    cargo check --manifest-path src-tauri/Cargo.toml
 *   2. store    cargo nextest run  crates/ritam-store      (Phase 3 gate)
 *   3. core     cargo nextest run  crates/ritam-browser    (nav policy)
 *   4. app      cargo nextest run  src-tauri               (state/runtime)
 *   5. parity   node scripts/parity-check.mjs              (rule 3)
 *   6. obstacle PYTHONUTF8=1 obstacle-course run.py        (rule 7)
 *
 * Usage:
 *   node scripts/gate-all.mjs                 # everything
 *   node scripts/gate-all.mjs --skip=obstacle # all but the slow harness
 *   node scripts/gate-all.mjs --only=parity   # one gate
 *
 * Exit code 0 only if every selected gate passed. Results are printed as a
 * table; ROT pastes the table into PLAN.md/BASELINE_REPORT.md as evidence.
 * Never weaken a step here: a failing gate fails the run, full stop.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "tools", "obscura-bin", "obscura.exe");
const nextestBin = path.join(root, "tools", "nextest");

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const skip = (args.find((a) => a.startsWith("--skip="))?.slice(7) ?? "")
  .split(",")
  .filter(Boolean);

function run(cmd, opts = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
    shell: true,
    timeout: opts.timeout ?? 15 * 60 * 1000,
  });
  return {
    ok: res.status === 0,
    ms: Date.now() - started,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim(),
    status: res.status,
  };
}

const gates = [
  {
    name: "ui-contract",
    why: "chrome UI, runtime, and contracts/ipc.md agree (static conformance)",
    run: () => run(`node "${path.join(root, "tests", "ui-contract.test.mjs")}"`),
  },
  {
    name: "build",
    why: "src-tauri compiles (compile errors are a failed gate, not a warning)",
    run: () => run(`cargo check --manifest-path "${path.join(root, "src-tauri", "Cargo.toml")}"`),
  },
  {
    name: "store",
    why: "Phase 3 persistence: nextest in crates/ritam-store (spawns the pinned binary)",
    run: () =>
      run(`cargo nextest run --manifest-path "${path.join(root, "crates", "ritam-store", "Cargo.toml")}"`, {
        env: { PATH: `${nextestBin};${process.env.PATH}` },
      }),
  },
  {
    name: "core",
    why: "navigation policy + engine adapter tests in crates/ritam-browser",
    run: () =>
      run(`cargo nextest run --manifest-path "${path.join(root, "crates", "ritam-browser", "Cargo.toml")}"`, {
        env: { PATH: `${nextestBin};${process.env.PATH}` },
      }),
  },
  {
    name: "app",
    why: "src-tauri unit tests (state, history, runtime)",
    run: () =>
      run(`cargo nextest run --manifest-path "${path.join(root, "src-tauri", "Cargo.toml")}"`, {
        env: { PATH: `${nextestBin};${process.env.PATH}` },
      }),
  },
  {
    name: "parity",
    why: "rule 3: CLI-vs-CDP byte parity on the fixture set",
    run: () => run(`node "${path.join(root, "scripts", "parity-check.mjs")}"`),
  },
  {
    name: "obstacle",
    why: "rule 7: obstacle course vs the pinned binary (needs 33/33; R11 tz caveat)",
    run: () =>
      run(`python obstacle-course\\run.py --runs 1 --warmup 0`, {
        cwd: path.join(root, "obscura-benchmark"),
        env: { OBSCURA_BIN: bin, PYTHONUTF8: "1", TZ: "Europe/Berlin" },
      }),
    // Prints its own PASS/FAIL table; grep the summary line for evidence.
    expect: (out) => /correctness:\s*33\/33/.test(out) ? { ok: true }
      : { ok: false, note: /correctness:\s*(\d+)\/33/.exec(out)?.[0] ?? "no summary line" },
  },
];

const selected = gates.filter(
  (g) => (!only || g.name === only) && !skip.includes(g.name),
);

console.log(`ROT gate run — ${new Date().toISOString()} — ${selected.length} gate(s)\n`);
let failed = 0;
const rows = [];
for (const g of selected) {
  process.stdout.write(`→ ${g.name} … `);
  const r = g.run();
  // The process exit code is authoritative: an expect() hook may only add
  // evidence text or fail the gate further — it can never upgrade a
  // non-zero exit to PASS (no gate weakening, ever).
  const e = g.expect ? g.expect(r.out) : null;
  const ok = r.ok && (e?.ok ?? true);
  const note = e?.note ?? (ok ? "" : `exit ${r.status}`);
  if (!ok) failed++;
  rows.push({ gate: g.name, result: ok ? "PASS" : "FAIL", time: `${(r.ms / 1000).toFixed(1)}s`, note: note || (ok ? "" : `exit ${r.status}`) });
  console.log(ok ? "PASS" : "FAIL");
  if (!ok) {
    console.log(`  why: ${g.why}`);
    console.log(`  tail: ${r.out.split(/\r?\n/).slice(-6).join("\n         ")}`);
  }
}

console.log("\n| gate | result | time | note |");
console.log("|---|---|---|---|");
for (const r of rows) console.log(`| ${r.gate} | ${r.result} | ${r.time} | ${r.note} |`);
console.log(`\n${failed === 0 ? "ALL GATES PASS" : `${failed} GATE(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
