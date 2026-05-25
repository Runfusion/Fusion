#!/usr/bin/env node
import { readdirSync, statSync, existsSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

function stableCwd() {
  try {
    return realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
}

// Namespace the baseline by cwd so concurrent worktrees don't clobber each
// other's baseline. Without this, running `--before` in worktree A and the
// post-test check in worktree B reads a baseline that doesn't include B's
// `.fusion`, which then trips the "live data changed" failure path.
const cwdHash = createHash("sha1").update(stableCwd()).digest("hex").slice(0, 12);
const BASELINE_FILE = join(tmpdir(), `.fusion-isolation-baseline-${cwdHash}`);

const TRACKED_PREFIXES = [
  "fusion-worker-",
  "fusion-test-",
  "fusion-test-cwd-",
  "fusion-provider-settings-",
  "fusion-provider-auth-",
  "fusion-provider-auth-oauth-",
  "fusion-agent-dir-",
  "kb-db-test-",
  "kb-backup-test-",
  "kb-migration-test-",
  "kb-fresh-",
  "kb-needs-migration-",
  "kb-compat-test-",
  "kb-first-run-test-",
];

function stablePath(pathValue) {
  try {
    return realpathSync(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

function snapshotTmp() {
  const entries = readdirSync(tmpdir());
  const matching = [];
  for (const name of entries) {
    if (!TRACKED_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = join(tmpdir(), name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) matching.push({ name, mtime: stat.mtimeMs });
    } catch {
      // Ignore transient file-system races while scanning /tmp.
    }
  }
  return matching;
}

function listProtectedFusionDirs() {
  const dirs = new Set();
  dirs.add(stablePath(join(process.cwd(), ".fusion")));
  dirs.add(stablePath(join(process.env.HOME || process.env.USERPROFILE || homedir(), ".fusion")));
  return [...dirs];
}

// Paths inside a protected .fusion root that a concurrently-running fusion app
// is expected to mutate. Tests still must not write to these — the filter only
// suppresses noise from a live app sharing the same HOME during local dev.
const RUNTIME_IGNORE_PATTERNS = [
  /^agent(?:[/\\]|$)/,
  /^agents(?:[/\\]|$)/,
  /^agent-memory(?:[/\\]|$)/,
  /^automations(?:[/\\]|$)/,
  /^backups(?:[/\\]|$)/,
  /^plugins(?:[/\\]|$)/,
  /^cache(?:[/\\]|$)/,
  /^config\.json$/,
  /^fusion-central\.db(?:-wal|-shm|-journal)?$/,
  /^fusion\.db(?:-wal|-shm|-journal)?(?:\.backup-[\w-]+)?(?:\.pre-[\w-]+)?$/,
  /^archive\.db(?:-wal|-shm|-journal)?(?:\.backup-[\w-]+)?$/,
  /^kb\.db(?:-wal|-shm|-journal)?(?:\.backup-[\w-]+)?$/,
  /^activity-log\.jsonl$/,
  /^settings\.json$/,
  /^logs(?:[/\\]|$)/,
  /^tasks(?:[/\\]|$)/,
  /^memory(?:[/\\]|$)/,
  /^messages(?:[/\\]|$)/,
  /^memory-insights\.md$/,
  /^test-cache\.json$/,
  /^HEARTBEAT\.md$/,
  /^MEMORY\.md$/,
  /^DREAMS\.md$/,
  /^\d{4}-\d{2}-\d{2}\.md$/,
  /^scripts\.json$/,
  /^update-check\.json$/,
  /^disabled-auto-extension-discovery$/,
  // Engine singleton lock (proper-lockfile creates `engine.lock.lock/` while
  // held; `engine.lock` is the sentinel file). Their entries appear/disappear
  // as the local dashboard starts/stops, which is not test pollution.
  /^engine\.lock$/,
  /^engine\.lock\.lock(?:[/\\]|$)/,
];

function isRuntimePath(relPath) {
  return RUNTIME_IGNORE_PATTERNS.some((re) => re.test(relPath));
}

// A .fusion dir is "engine-active" when an engine process currently holds the
// singleton lock. proper-lockfile materializes this as `engine.lock.lock/`
// being present alongside the `engine.lock` sentinel. This is a deterministic
// signal — no timing/probe required — so we use it to auto-skip live-engine
// dirs instead of relying on the post-run mutability burst landing inside
// our 2-second probe window.
function isFusionEngineActive(fusionDir) {
  if (!existsSync(fusionDir)) return false;
  try {
    const lockHeldDir = join(fusionDir, "engine.lock.lock");
    const stat = statSync(lockHeldDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function collectFusionSignature(rootDir, out = []) {
  if (!existsSync(rootDir)) return out;
  let stat;
  try {
    stat = statSync(rootDir);
  } catch {
    return out;
  }
  if (!stat.isDirectory()) return out;

  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    const relPath = fullPath.slice(rootDir.length + (rootDir.endsWith(sep) ? 0 : 1));
    if (isRuntimePath(relPath)) continue;
    try {
      statSync(fullPath);
    } catch {
      continue;
    }
    // Track only path + kind. Size/mtime would flip every time the live app
    // touches an existing file (fusion.db-wal heartbeats, settings.json saves),
    // producing false-positive "leak" failures. New files still get detected
    // because they add a new entry to the set; tests are independently blocked
    // from writing to the real .fusion via the fs guards in vitest-setup.ts.
    out.push(`${relPath}|${entry.isDirectory() ? "d" : "f"}`);
    if (entry.isDirectory()) collectFusionSignature(fullPath, out);
  }
  return out;
}

function snapshotProtectedFusion() {
  return listProtectedFusionDirs().map((dir) => ({
    dir,
    exists: existsSync(dir),
    entries: collectFusionSignature(dir).sort(),
  }));
}

function sleepMs(ms) {
  // Cross-platform enough for CI and local dev; fall back to best-effort no-op.
  spawnSync(process.platform === "win32" ? "powershell" : "sleep", process.platform === "win32" ? ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`] : [String(ms / 1000)], { stdio: "ignore" });
}

function recordBaseline() {
  const samples = [snapshotProtectedFusion()];
  for (let i = 0; i < 4; i++) {
    sleepMs(500);
    samples.push(snapshotProtectedFusion());
  }

  const latestProtected = samples[samples.length - 1];
  const unstableProtectedDirs = [];
  const firstProtected = samples[0];
  for (const first of firstProtected) {
    // Live engine lock present → auto-mark unstable. Same outcome as the
    // mutability probe below would (eventually) reach, but deterministic and
    // immune to write-cadence gaps.
    if (isFusionEngineActive(first.dir)) {
      unstableProtectedDirs.push(first.dir);
      continue;
    }
    let unstable = false;
    for (let i = 1; i < samples.length; i++) {
      const current = samples[i].find((entry) => entry.dir === first.dir);
      if (!current) continue;
      if (JSON.stringify(first.entries) !== JSON.stringify(current.entries)) {
        unstable = true;
        break;
      }
    }
    if (unstable) unstableProtectedDirs.push(first.dir);
  }

  const payload = {
    tmpNames: snapshotTmp().map((e) => e.name),
    protectedFusion: latestProtected,
    unstableProtectedDirs,
  };
  writeFileSync(BASELINE_FILE, JSON.stringify(payload));
  console.log(`[test-isolation] Baseline recorded: ${payload.tmpNames.length} temp dir(s), ${payload.protectedFusion.length} protected .fusion root(s).`);
  if (unstableProtectedDirs.length > 0) {
    console.log(`[test-isolation] Ignoring ${unstableProtectedDirs.length} externally-active protected dir(s):`);
    for (const dir of unstableProtectedDirs) console.log(`  ${dir}`);
  }
}

function checkAgainstBaseline() {
  let baseline = { tmpNames: [], protectedFusion: [] };
  if (existsSync(BASELINE_FILE)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
    } catch {
      // Ignore malformed baseline payloads and treat as empty baseline.
    }
  }

  const baselineNames = new Set(baseline.tmpNames ?? []);
  // Caller (scripts/test-changed.mjs) tells us which fusion-test-home-root-*
  // basenames it minted this run. We allow-list them unconditionally so a
  // transient cleanup failure or a rotated baseline file can't masquerade as
  // a real test leak.
  const callerIgnoreNames = (process.env.FUSION_TEST_ISOLATION_IGNORE_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of callerIgnoreNames) baselineNames.add(name);
  const leaks = snapshotTmp().filter((e) => {
    if (baselineNames.has(e.name)) {
      return false;
    }
    if (e.name.startsWith("fusion-test-home-root-")) {
      return false;
    }
    return true;
  });

  const baselineByDir = new Map((baseline.protectedFusion ?? []).map((entry) => [entry.dir, entry]));
  const unstableProtectedDirs = new Set(baseline.unstableProtectedDirs ?? []);
  const currentProtected = snapshotProtectedFusion();
  const candidateViolations = [];
  const skippedUnknownDirs = [];
  for (const current of currentProtected) {
    if (unstableProtectedDirs.has(current.dir)) continue;
    const base = baselineByDir.get(current.dir);
    if (!base) {
      // No baseline for this dir — the `--before` step ran from a different
      // cwd (or never ran). We can't distinguish pre-existing entries from
      // test-created ones, so warn and skip instead of false-failing.
      skippedUnknownDirs.push(current.dir);
      continue;
    }
    const changedExistence = Boolean(base.exists) !== Boolean(current.exists);
    const changedEntries = JSON.stringify(base.entries) !== JSON.stringify(current.entries);
    if (changedExistence || changedEntries) {
      candidateViolations.push(current.dir);
    }
  }

  const protectedViolations = [];
  if (candidateViolations.length > 0) {
    // First: skip any candidate dir where an engine is currently holding the
    // singleton lock. This is the dominant local-dev case (`fn` dashboard
    // running while tests are invoked) and the engine-lock signal is
    // race-free, unlike the post-test mutability probe.
    const remainingCandidates = candidateViolations.filter((dir) => !isFusionEngineActive(dir));

    if (remainingCandidates.length > 0) {
      // A live local app can write in bursts (e.g. heartbeat every few seconds),
      // so do a short mutability probe before blaming tests. Retained as a
      // backstop for dirs that don't have an engine lock but do have an
      // external writer (e.g. an `fn` process that crashed mid-run and left
      // the lock stale).
      const postSamples = [currentProtected];
      for (let i = 0; i < 4; i++) {
        sleepMs(500);
        postSamples.push(snapshotProtectedFusion());
      }

      for (const dir of remainingCandidates) {
        let externallyActive = false;
        for (let i = 1; i < postSamples.length; i++) {
          const prev = postSamples[i - 1].find((entry) => entry.dir === dir);
          const next = postSamples[i].find((entry) => entry.dir === dir);
          if (!prev || !next) continue;
          if (JSON.stringify(prev.entries) !== JSON.stringify(next.entries)) {
            externallyActive = true;
            break;
          }
        }

        if (!externallyActive) {
          protectedViolations.push(dir);
        }
      }
    }
  }

  if (skippedUnknownDirs.length > 0) {
    console.warn(`[test-isolation] WARN: ${skippedUnknownDirs.length} protected dir(s) absent from baseline (was \`--before\` run from a different cwd?):`);
    for (const dir of skippedUnknownDirs) console.warn(`  ${dir}`);
  }

  if (leaks.length === 0 && protectedViolations.length === 0) {
    console.log("[test-isolation] No temp leaks or live .fusion mutations detected.");
    process.exit(0);
  }

  if (leaks.length > 0) {
    console.error(`[test-isolation] FAIL: ${leaks.length} leaked temp director${leaks.length === 1 ? "y" : "ies"}:`);
    for (const leak of leaks) console.error(`  ${join(tmpdir(), leak.name)}`);
    console.error("");
  }

  if (protectedViolations.length > 0) {
    console.error("[test-isolation] FAIL: protected live .fusion data changed during tests:");
    for (const dir of protectedViolations) console.error(`  ${dir}`);
    console.error("Tests must use temp HOME / temp workspaces and never write repo or user .fusion data.");
  }

  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--before")) {
  recordBaseline();
} else {
  checkAgainstBaseline();
}