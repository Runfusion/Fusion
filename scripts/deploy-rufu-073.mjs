#!/usr/bin/env node
/*
FNXC:WorkflowScheduling 2026-08-12-21:22 (RUFU-073) — OPERATOR deploy/verify handoff.

RUFU-073 reduces production CPU (62-70% → <40%) and health-API latency by threading a strictly
per-tick workflow-selection cache through the scheduler's `resolveTaskParkedColumns` call sites, so
each task's `task_workflow_selection` is read at most once per poll tick instead of ~6x (killing the
Drizzle SQL-query storm).

WHY THIS IS HANDED OFF TO THE OPERATOR: the production :4040 daemon is the Fusion host this agent runs
inside. Restarting it terminates this session across the shutdown boundary, and the embedded
PostgreSQL global dir is privilege-fenced from agent sessions. So the code is landed on local `main`
and verified green; the live restart + `pg_stat_user_tables` verification is an OPERATOR action, staged
by this script.

USAGE (run from a terminal as the operator, after the agent session is done):
  node scripts/deploy-rufu-073.mjs            # build main's dist + print report (NO restart)
  node scripts/deploy-rufu-073.mjs --restart  # build + controlled engine restart + verify
  node scripts/deploy-rufu-073.mjs --debug    # verbose

STEPS:
  1. BEFORE baseline  : health latency + daemon CPU + pg_stat idx_scan (current OLD build).
  2. checkout main    : put the production checkout on local `main` (which contains RUFU-073).
  3. pnpm build       : rebuild packages/engine/dashboard/cli dist from main code.
  4. restart (opt-in) : stop the :4040 engine child so Fusion's supervisor respawns it from the
                        newly-built dist. `--restart` only. Port 4040 is RESERVED: the script only
                        SIGTERMs a pid it can PROVE is the deployed Fusion dashboard/engine daemon
                        (cmdline references the Fusion checkout root + a Fusion entrypoint). A
                        foreign process on :4040 is refused with a non-zero exit and never signaled;
                        a gone/unreadable pid is skipped with a warning.
  5. AFTER baseline   : same three measures; prints PASS/FAIL vs RUFU-073 targets
                        (idx_scan growth < 30 q/s, health < 0.5s, CPU < 40%).
*/

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import process from "node:process";

const REPO = "/home/schindler/git/Fusion";
const PORT = 4040;
const PG_PORT = 43477;
const TASK_START_COMMIT = "18a86ea3e"; // first RUFU-073 fix commit (fix heading)
const ARGS = new Set(process.argv.slice(2));
const DEBUG = ARGS.has("--debug");
const DO_RESTART = ARGS.has("--restart");

const log = (...a) => console.log("▶", ...a);
const ok = (...a) => console.log("✓", ...a);
const warn = (...a) => console.warn("!", ...a);
const fail = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const sh = (cmd, opts = {}) => execFileSync("bash", ["-lc", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

/*
FNXC:DeployPreflight 2026-08-16-22:29 (RUFU-106 resolving RUFU-073 Greptile P1 #1):
The preflight broke on EVERY documented invocation: `git rev-parse short main` parsed `short` as a
subcommand (`fatal: ambiguous argument 'short'`), and `merge-base --is-ancestor` threw via
`execFileSync` on the not-ancestor exit code 1, so the "RUFU-073 is not on local main" failure branch
never ran. `isAncestorCmd`/`shortSha` are the pure, testable decision helpers behind the fixed
preflight; their temp-repo assertions live in scripts/__tests__/deploy-rufu-073.test.mjs.
*/
/**
 * Pure: `git merge-base --is-ancestor <ancestor> <descendant>` -> boolean.
 *
 * exit 0 => true (ancestor); exit 1 => false (NOT an ancestor — the documented
 * failure branch); any other exit (a genuine ref error) throws. This fixes the
 * P1 preflight bug where `execFileSync` threw on the not-ancestor exit code 1,
 * so the intended "RUFU-073 is not on local main" failure message was never
 * reached (the ternary's "no" branch was dead).
 */
export function isAncestorCmd(gitBin, ancestor, descendant, cwd) {
  const res = spawnSync(gitBin, ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, encoding: "utf8" });
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor exited ${res.status}: ${String(res.stderr ?? "").trim()}`);
}

/**
 * Pure: the short SHA of `ref` for `gitBin` in `cwd`. Uses `--short` (the
 * correct flag); the P1 bug ran `git rev-parse short main` which parsed `short`
 * as a subcommand and aborted EVERY documented invocation with
 * `fatal: ambiguous argument 'short'`.
 */
export function shortSha(gitBin, ref, cwd) {
  return execFileSync(gitBin, ["rev-parse", "--short", ref], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function assertMainHasRufu073() {
  const mainSha = shortSha("git", "main", REPO);
  const inMain = isAncestorCmd("git", TASK_START_COMMIT, "main", REPO) ? "yes" : "no";
  log(`local main = ${mainSha}; RUFU-073 fix ${TASK_START_COMMIT} present in main: ${inMain}`);
  if (inMain !== "yes") fail(`RUFU-073 is not on local main — land it first (fast-forward main to the rufu branch).`);
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
    wfSelection: pgIdxScan("task_workflow_selection"),
    promptOverrides: pgIdxScan("config"),
    t: Date.now(),
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findEnginePid() {
  const out = execFileSync("bash", ["-lc", `ss -ltnp 2>/dev/null | grep -E ':${PORT}\\b' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2`], { encoding: "utf8" }).trim();
  return out ? Number(out) : -1;
}

/**
 * Pure: is `cmdline` (the pid owning the reserved port) provably the deployed Fusion
 * dashboard/engine daemon? True ONLY when the command line references the Fusion checkout root AND a
 * real Fusion engine/dashboard/cli entrypoint. This is the identity gate for the reserved port-4040
 * restart: a foreign node/other process on :4040 must NEVER be signaled.
 */
export function isProvenFusionDaemon(cmdline, repoRoot) {
  if (typeof cmdline !== "string" || cmdline.length === 0) return false;
  const lower = cmdline.toLowerCase();
  if (!repoRoot || !lower.includes(String(repoRoot).toLowerCase())) return false;
  return [
    ".fusion",
    "packages/engine/dist",
    "packages/dashboard/dist",
    "packages/cli/dist",
    "@runfusion/fusion",
  ].some((marker) => lower.includes(marker));
}

/**
 * Pure: what should the `--restart` branch do for a pid owning the reserved port?
 *   - "skip":   no cmdline read (pid gone / unreadable) — warn, do NOT signal.
 *   - "refuse": a process IS present but NOT provably Fusion — NEVER signal; refuse with a
 *               non-zero exit.
 *   - "signal": provably the deployed Fusion daemon — SIGTERM + health-wait.
 * Making this a pure decision lets scripts/__tests__/deploy-rufu-073.test.mjs pin all three
 * branches deterministically without ever touching a live pid.
 */
export function resolveRestartAction(cmdline, repoRoot) {
  if (typeof cmdline !== "string" || cmdline.length === 0) return "skip";
  return isProvenFusionDaemon(cmdline, repoRoot) ? "signal" : "refuse";
}

/** Best-effort read of a pid's command line via /proc (POSIX) then `ps -o args=`. Null when unreadable. */
export function readCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const data = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (data) return data.replace(/\u0000/g, " ").trim();
    return null;
  } catch {
    try {
      return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
    } catch {
      return null;
    }
  }
}

async function main() {
  console.log("\n=== RUFU-073 production deploy/verify (operator-run) ===\n");
  if (DEBUG) log("debug", { REPO, PORT, PG_PORT, DO_RESTART });
  assertMainHasRufu073();

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
  const preScan = (pre2.wfSelection - pre1.wfSelection) / 5; // per-second growth
  ok(`health: ${preHealth < 0 ? "N/A" : preHealth.toFixed(3) + "s"}`);
  ok(`daemon CPU: ${(preCpu < 0 ? "N/A" : preCpu.toFixed(1) + "%")}`);
  ok(`task_workflow_selection idx_scan growth: ${preScan < 0 ? "unmeasurable (DB access needed)" : preScan.toFixed(1) + " q/s"}`);

  // ---- Build from main ----
  log(`rebuilding dist from local main...`);
  sh(`cd ${REPO} && git checkout main && pnpm build`, { stdio: DEBUG ? "inherit" : ["ignore","pipe","inherit"] });
  ok("built main dist");

  if (!DO_RESTART) {
    warn("did not restart (no --restart). Re-run with --restart to apply and verify.");
    process.exit(0);
  }

  // ---- Controlled restart (opt-in) ----
  /*
  FNXC:DeployRestart 2026-08-16-22:29 (RUFU-106 resolving RUFU-073 Greptile P1 #2):
  Port 4040 is reserved. `--restart` must NEVER signal an unproven process: `findEnginePid()` returns
  whichever pid owns :4040, so the previous code SIGTERMed a foreign process with no identity check.
  Now the restart resolves the pid's cmdline and only signals when it is provably the deployed Fusion
  dashboard/engine daemon (cmdline references the Fusion checkout root + a Fusion entrypoint); an
  unprovable process is refused with a non-zero exit, and a gone/unreadable pid is skipped with a
  warning — a foreign process on the reserved port is never killed.
  */
  log(`restarting :${PORT} engine (supervisor respawn)...`);
  const enginePid = findEnginePid();
  if (enginePid < 0) {
    warn(`no process on :${PORT} to restart — nothing to signal`);
  } else {
    const cmdline = readCmdline(enginePid);
    const action = resolveRestartAction(cmdline ?? "", REPO);
    if (action === "refuse") {
      fail(`refusing to signal pid ${enginePid} on reserved port ${PORT}: cmdline "${cmdline ?? "unreadable"}" is not a provably-Fusion dashboard/engine daemon. Port ${PORT} is reserved — only a proven Fusion daemon may be restarted here.`);
    }
    if (action === "skip") {
      warn(`could not read cmdline for pid ${enginePid}; skipping the signal (process may have exited).`);
    }
    if (action === "signal") {
      // Graceful: SIGTERM the proven Fusion engine child; Fusion's own supervisor
      // (FUSION_RESTART_SUPERVISED) respawns it from the newly-built dist.
      execFileSync("bash", ["-lc", `kill -TERM ${enginePid}`]);
      ok(`sent SIGTERM to proven Fusion daemon pid ${enginePid}; waiting for supervisor respawn`);
    }
  }
  let up = false;
  for (let i = 0; i < 60; i++) { await sleep(2000); if (healthLatency() >= 0) { up = true; break; } }
  if (!up) warn("health did not come up within 120s — check the daemon log.");
  else ok(`:${PORT} is healthy after restart`);

  // Give the scheduler a couple of poll cycles to settle.
  await sleep(30_000);

  // ---- AFTER baseline (new build) ----
  log("AFTER baseline (new RUFU-073 build)...");
  const postHealth = healthLatency();
  const postCpu = daemonCpu();
  const p1 = dbSnapshot();
  await sleep(5000);
  const p2 = dbSnapshot();
  const postScan = (p2.wfSelection - p1.wfSelection) / 5;

  ok(`health: ${postHealth < 0 ? "N/A" : postHealth.toFixed(3) + "s"}`);
  ok(`daemon CPU: ${(postCpu < 0 ? "N/A" : postCpu.toFixed(1) + "%")}`);
  ok(`task_workflow_selection idx_scan growth: ${postScan < 0 ? "unmeasurable" : postScan.toFixed(1) + " q/s"}`);

  // ---- Report vs targets ----
  console.log("\n=== RESULT vs RUFU-073 targets ===");
  const target = [
    ["health < 0.5s", postHealth >= 0 && postHealth < 0.5],
    ["CPU < 40%", postCpu >= 0 && postCpu < 40],
    ["idx_scan growth < 30 q/s", postScan >= 0 && postScan < 30],
  ];
  for (const [name, pass] of target) console.log(pass ? `  PASS  ${name}` : `  FAIL  ${name} (target unmet)`);
  console.log(preScan >= 0 && postScan >= 0 && preScan > postScan
    ? `  PASS  idx_scan growth dropped ${preScan.toFixed(1)} -> ${postScan.toFixed(1)} q/s`
    : `  CHECK idx_scan before ${preScan < 0 ? "N/A" : preScan.toFixed(1)} -> after ${postScan < 0 ? "N/A" : postScan.toFixed(1)} q/s`);
}
/*
FNXC:DeployPreflight 2026-08-16-22:29:
Run the deploy/verify flow only when executed directly (never on import, so
scripts/__tests__/deploy-rufu-073.test.mjs can import the pure helpers without triggering a run).
Previously the file defined `main()` but never invoked it, so every documented invocation was a no-op
that reached no preflight at all; this guard makes the documented invocations actually run the flow.
*/
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
