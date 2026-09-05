#!/usr/bin/env node
/*
FNXC:TaskLifecycleConsumerIdleBackoff 2026-08-13-08:00 (RUFU-074) — OPERATOR deploy/verify handoff.

RUFU-074 reduces production CPU (70-98% → <50%) and health-API latency on idle/paused projects by
making TaskDeletedOutboxConsumer self-reschedule with idle backoff + ±20% jitter instead of polling a
fixed 5s setInterval forever. With ~44 per-project dashboard/engine consumers backing off toward a 60s
cap when a project is idle/paused, task_lifecycle_consumer_cursors idx_scan drops from ~26/s to <5/s.

WHY THIS IS HANDED OFF TO THE OPERATOR: the production :4040 daemon is the Fusion host this agent runs
inside. Restarting it terminates this session across the shutdown boundary, and the embedded
PostgreSQL global dir is privilege-fenced from agent sessions. So the code is landed on local `main`
and verified green; the live restart + `pg_stat_user_tables` verification is an OPERATOR action, staged
by this script.

USAGE (run from a terminal as the operator, after the agent session is done):
  node scripts/deploy-rufu-074.mjs            # build main's dist + print report (NO restart)
  node scripts/deploy-rufu-074.mjs --restart  # build + controlled engine restart + verify
  node scripts/deploy-rufu-074.mjs --debug    # verbose

STEPS:
  1. BEFORE baseline  : health latency + daemon CPU + pg_stat idx_scan (current OLD build).
  2. checkout main    : put the production checkout on local `main` (which contains RUFU-074).
  3. pnpm build       : rebuild packages dist from main code.
  4. restart (opt-in) : stop the :4040 engine child so Fusion's supervisor respawns it from the
                        newly-built dist. `--restart` only. Port 4040 is never force-killed outside
                        this controlled engine re-supervision.
  5. AFTER baseline   : same three measures; prints PASS/FAIL vs RUFU-074 targets
                        (task_lifecycle_consumer_cursors idx_scan < 5/s, health < 0.5s, CPU < 50%).
*/

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import net from "node:net";
import process from "node:process";

const REPO = "/home/schindler/git/Fusion";
const PORT = 4040;
const PG_PORT = 43477;
const TASK_START_COMMIT = "a989b3c5c"; // first RUFU-074 fix commit (the idle-backoff fix)
const ARGS = new Set(process.argv.slice(2));
const DEBUG = ARGS.has("--debug");
const DO_RESTART = ARGS.has("--restart");

const log = (...a) => console.log("▶", ...a);
const ok = (...a) => console.log("✓", ...a);
const warn = (...a) => console.warn("!", ...a);
const fail = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const sh = (cmd, opts = {}) => execFileSync("bash", ["-lc", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

function assertMainHasRufu074() {
  const git = (args) => execFileSync("git", args, { encoding: "utf8", cwd: REPO, stdio: ["ignore", "pipe", "inherit"] }).trim();
  const mainSha = git(["rev-parse", "short", "main"]);
  const inMain = git(["merge-base", "--is-ancestor", TASK_START_COMMIT, "main"]) ? "yes" : "no";
  log(`local main = ${mainSha}; RUFU-074 fix ${TASK_START_COMMIT} present in main: ${inMain}`);
  if (inMain !== "yes") fail(`RUFU-074 is not on local main — land it first (fast-forward main to the rufu branch).`);
  return mainSha;
}

function healthLatency() {
  try { return Number(execFileSync("curl", ["-s","-o","/dev/null","-w","%{time_total}",`http://127.0.0.1:${PORT}/api/health`], { encoding: "utf8" })); }
  catch { return -1; }
}

function daemonCpu() {
  try {
    const out = execFileSync("bash", ["-lc", `ss -ltnp 2>/dev/null | grep -E ':${PORT}\\b' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2`], { encoding: "utf8" }).trim();
    if (!out) return -1;
    return Number(execFileSync("ps", ["-o","%cpu=","-p",out], { encoding: "utf8" }).trim());
  } catch { return -1; }
}

function pgIdxScan(table) {
  try {
    // Embedded PG on 43477. Auth: operator supplies FUSION_DB_URL / PG* env, or pg_hba local trust.
    const url = process.env.FUSION_DB_URL || `postgres://schindler@127.0.0.1:${PG_PORT}/fusion`;
    return Number(execFileSync("psql", [url, "-tA", "-c", `SELECT idx_scan FROM pg_stat_user_tables WHERE relname='${table}';`], { encoding: "utf8" }).trim());
  } catch (e) { console.error(`  (psql unavailable/blocked: ${String(e.message).split("\n")[0]})`); return -1; }
}

function dbSnapshot() {
  return {
    lifecycleCursors: pgIdxScan("task_lifecycle_consumer_cursors"),
    t: Date.now(),
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findEnginePid() {
  const out = execFileSync("bash", ["-lc", `ss -ltnp 2>/dev/null | grep -E ':${PORT}\\b' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2`], { encoding: "utf8" }).trim();
  return out ? Number(out) : -1;
}

async function main() {
  console.log("\n=== RUFU-074 production deploy/verify (operator-run) ===\n");
  if (DEBUG) log("debug", { REPO, PORT, PG_PORT, DO_RESTART });
  assertMainHasRufu074();

  const portFree = await new Promise((res) => { const s = net.connect({ port: PORT, host: "127.0.0.1" }); s.on("connect", () => { s.destroy(); res(false); }); s.on("error", () => res(true)); });
  if (portFree && !DEBUG && !DO_RESTART) {
    // Nothing on 4040 — nothing to benchmark. Just build + note.
    warn(`nothing listening on :${PORT} (perhaps the daemon is already down). Building main dist only.`);
  }

  // ---- BEFORE baseline (old build) ----
  log("BEFORE baseline (current OLD build)...");
  const preHealth = healthLatency();
  const preCpu = daemonCpu();
  const pre1 = dbSnapshot();
  await sleep(5000);
  const pre2 = dbSnapshot();
  const preScan = (pre2.lifecycleCursors - pre1.lifecycleCursors) / 5; // per-second growth
  ok(`health: ${preHealth < 0 ? "N/A" : preHealth.toFixed(3) + "s"}`);
  ok(`daemon CPU: ${(preCpu < 0 ? "N/A" : preCpu.toFixed(1) + "%")}`);
  ok(`task_lifecycle_consumer_cursors idx_scan growth: ${preScan < 0 ? "unmeasurable (DB access needed)" : preScan.toFixed(1) + " q/s"}`);

  // ---- Build from main ----
  log(`rebuilding dist from local main...`);
  sh(`cd ${REPO} && git checkout main && pnpm build`, { stdio: DEBUG ? "inherit" : ["ignore","pipe","inherit"] });
  ok("built main dist");

  if (!DO_RESTART) {
    warn("did not restart (no --restart). Re-run with --restart to apply and verify.");
    process.exit(0);
  }

  // ---- Controlled restart (opt-in) ----
  log(`restarting :${PORT} engine (supervisor respawn)...`);
  const enginePid = findEnginePid();
  if (enginePid < 0) warn("no engine on :4040 to restart");
  else {
    // Graceful: SIGTERM the engine child; Fusion's own supervisor (FUSION_RESTART_SUPERVISED) respawns it.
    execFileSync("bash", ["-lc", `kill -TERM ${enginePid}`]);
    ok(`sent SIGTERM to engine pid ${enginePid}; waiting for supervisor respawn`);
  }
  let up = false;
  for (let i = 0; i < 60; i++) { await sleep(2000); if (healthLatency() >= 0) { up = true; break; } }
  if (!up) warn("health did not come up within 120s — check the daemon log.");
  else ok(`:${PORT} is healthy after restart`);

  // Give the lifecycle consumers a couple of poll/backoff cycles to settle.
  await sleep(30_000);

  // ---- AFTER baseline (new build) ----
  log("AFTER baseline (new RUFU-074 build)...");
  const postHealth = healthLatency();
  const postCpu = daemonCpu();
  const p1 = dbSnapshot();
  await sleep(5000);
  const p2 = dbSnapshot();
  const postScan = (p2.lifecycleCursors - p1.lifecycleCursors) / 5;

  ok(`health: ${postHealth < 0 ? "N/A" : postHealth.toFixed(3) + "s"}`);
  ok(`daemon CPU: ${(postCpu < 0 ? "N/A" : postCpu.toFixed(1) + "%")}`);
  ok(`task_lifecycle_consumer_cursors idx_scan growth: ${postScan < 0 ? "unmeasurable" : postScan.toFixed(1) + " q/s"}`);

  // ---- Report vs targets ----
  console.log("\n=== RESULT vs RUFU-074 targets ===");
  const target = [
    ["health < 0.5s", postHealth >= 0 && postHealth < 0.5],
    ["CPU < 50%", postCpu >= 0 && postCpu < 50],
    ["idx_scan growth < 5 q/s", postScan >= 0 && postScan < 5],
  ];
  for (const [name, pass] of target) console.log(pass ? `  PASS  ${name}` : `  FAIL  ${name} (target unmet)`);
  console.log(preScan >= 0 && postScan >= 0 && preScan > postScan
    ? `  PASS  idx_scan growth dropped ${preScan.toFixed(1)} -> ${postScan.toFixed(1)} q/s`
    : `  CHECK idx_scan before ${preScan < 0 ? "N/A" : preScan.toFixed(1)} -> after ${postScan < 0 ? "N/A" : postScan.toFixed(1)} q/s`);
}