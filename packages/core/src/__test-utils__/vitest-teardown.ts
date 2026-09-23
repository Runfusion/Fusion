/**
 * Vitest globalSetup hook.
 *
 * We publish a per-invocation worker-root env var. Teardown removes that private
 * root after the project finishes so workspace isolation checks do not report
 * the run-local worker/home directories as leaks.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const WORKER_ROOT_OWNER_FILE = ".fusion-test-worker-root-owner";
const FUSION_TEST_RUN_TOKEN_ENV = "FUSION_TEST_RUN_TOKEN";
const LEGACY_TEST_HOME_PREFIX = "fn-test-home-";

let workerRootRmSync = rmSync;
let workerRootSleepMsSync = sleepMsSync;

export function __setWorkerRootRmSyncForTests(nextRmSync: typeof rmSync): void {
  workerRootRmSync = typeof nextRmSync === "function" ? nextRmSync : rmSync;
}

export function __setWorkerRootSleepMsSyncForTests(nextSleep: (ms: number) => void): void {
  workerRootSleepMsSync = typeof nextSleep === "function" ? nextSleep : sleepMsSync;
}

function sleepMsSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/*
FNXC:TestTeardownOwnership 2026-09-23-01:55:
FN-9349's ownership proof originally required the marker file to EXACTLY equal the
`${pid}\nrunToken=...` string globalSetup wrote. In real forked-worker runs that check never
passes: each worker fork re-writes the marker with its OWN pid via vitest-setup's ensureWorkerRoot(),
so by teardown the marker carries a worker pid, never the main pid globalSetup captured. Teardown
then skipped removal and leaked one fusion-test-workers-* root per vitest invocation (106 stale roots
accumulated, tripping check-test-isolation). The single-process unit tests masked it because pid is
constant there. The durable ownership signal is the RUN TOKEN, which is shared across a run's main
process and all its worker forks (env-inherited) and differs only for a genuine successor invocation.
Prove ownership by run token, not by the pid-bearing full string.
*/
export function parseWorkerRootOwnerRunToken(markerContent: string): string {
  for (const line of markerContent.split(/\r?\n/)) {
    if (line.startsWith("runToken=")) return line.slice("runToken=".length);
  }
  return "";
}

export function removeLegacyTopLevelHomeRoots(tempRoot = tmpdir()): void {
  /*
  FNXC:TestIsolation 2026-06-14-00:36:
  FN-6430 found stale top-level `fn-test-home-*` roots after CLI package-load runs; current workers create HOME under `fusion-test-workers-*`, so top-level homes are legacy leftovers that can bleed settings/cache state into nested lanes.
  Sweep only a single temp-root level by prefix during setup/teardown, never a recursive temp-tree walk.
  */
  let entries: string[] = [];
  try {
    entries = readdirSync(tempRoot);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(LEGACY_TEST_HOME_PREFIX)) continue;
    try {
      workerRootRmSync(join(tempRoot, entry), { recursive: true, force: true });
    } catch {
      // Best effort only. A future invocation will retry the bounded prefix sweep.
    }
  }
}

export function removeWorkerRootWithRetry(workerRoot: string, retries = 8, delayMs = 75): void {
  /*
  FNXC:TestIsolation 2026-06-17-19:02:
  Broad core/package runs can finish workers while macOS still drains redirected temp files or SQLite WAL handles under `fusion-test-workers-*`.
  Keep teardown bounded but long enough to absorb transient ENOTEMPTY/EBUSY cleanup races rather than leaking a per-invocation worker root.
  */
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      workerRootRmSync(workerRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (isEnoent(error)) return;
      lastError = error;
      if (attempt < retries) {
        workerRootSleepMsSync(delayMs);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.warn(`[vitest-teardown] failed to remove worker root ${workerRoot} after ${retries} attempts: ${message}`);
}

export default function setup(): () => Promise<void> {
  removeLegacyTopLevelHomeRoots();
  // Use a fresh root for each Vitest invocation. A static shared root makes the
  // setup-time redirect sweep proportional to stale directories left by every
  // prior interrupted run.
  const workerRoot = resolve(mkdtempSync(join(tmpdir(), "fusion-test-workers-")));
  const runToken = process.env[FUSION_TEST_RUN_TOKEN_ENV];
  const ownerRunToken = runToken && runToken.trim().length > 0 ? runToken : "";
  const tokenLine = ownerRunToken ? `runToken=${ownerRunToken}\n` : "";
  const ownerMarker = `${process.pid}\n${tokenLine}`;
  let ownsWorkerRoot = false;
  try {
    writeFileSync(join(workerRoot, WORKER_ROOT_OWNER_FILE), ownerMarker);
    ownsWorkerRoot = true;
  } catch {
    // A teardown without its marker cannot prove ownership. Preserve the root
    // rather than letting a partially initialized invocation delete a future
    // successor that has claimed the same path.
  }
  process.env.FUSION_TEST_WORKER_ROOT = workerRoot;
  /*
  FNXC:PgTestTemplateDb 2026-07-19-17:20:
  Publish the vitest MAIN-process pid so every fork resolves the SAME run-shared
  "golden" PostgreSQL schema template (see pg-test-harness.ts). Forks inherit
  this env at spawn (globalSetup runs before workers start), and the pid segment
  keeps the existing dead-pid template sweep able to reclaim the golden once this
  run's main process exits.
  */
  process.env.FUSION_PG_TEMPLATE_OWNER_PID = String(process.pid);

  return async function teardown() {
    try {
      process.chdir(tmpdir());
    } catch {
      // Ignore — cleanup below is best-effort and uses an absolute path.
    }
    /*
    FNXC:TestIsolation 2026-07-14-21:40:
    Prefer injectable in-process removeWorkerRootWithRetry so unit tests can assert EBUSY/ENOTEMPTY retry semantics via __setWorkerRootRmSyncForTests.
    Dashboard hang root causes were open SSE/undici handles (fixed via __resetSseBus + quarantines), not rmSync itself — restore sync cleanup for deterministic isolation and test hooks.
    */
    /*
    FNXC:TestTeardownOwnership 2026-09-21-10:23:
    FN-9349 requires teardown to prove the marker it created still owns this
    root. A partial startup or stale teardown must not delete a root claimed by
    a live successor, even when its path was retained or reused by a runner.
    */
    if (ownsWorkerRoot) {
      try {
        // Match on the run token (shared across this run's main process and its
        // worker forks) rather than the pid-bearing full marker, which workers
        // legitimately rewrite with their own pid during the run.
        const markerRunToken = parseWorkerRootOwnerRunToken(
          readFileSync(join(workerRoot, WORKER_ROOT_OWNER_FILE), "utf8"),
        );
        if (markerRunToken === ownerRunToken) {
          removeWorkerRootWithRetry(workerRoot);
        }
      } catch {
        // Missing/unreadable ownership proof is a safe no-op; later bounded
        // cleanup can reclaim only a root whose owner it can establish.
      }
    }
    removeLegacyTopLevelHomeRoots();
  };
}
