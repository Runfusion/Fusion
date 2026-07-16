/**
 * Vitest globalSetup hook.
 *
 * We publish a per-invocation worker-root env var. Teardown removes that private
 * root after the project finishes so workspace isolation checks do not report
 * the run-local worker/home directories as leaks.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  try {
    const runToken = process.env[FUSION_TEST_RUN_TOKEN_ENV];
    const tokenLine = runToken && runToken.trim().length > 0 ? `runToken=${runToken}\n` : "";
    writeFileSync(join(workerRoot, WORKER_ROOT_OWNER_FILE), `${process.pid}\n${tokenLine}`);
  } catch {
    // Best effort only. The marker protects active roots from external orphan
    // pruning; FN-6396 adds the runner token so stale pid reuse cannot keep an
    // orphaned root alive. Teardown still owns this root by absolute path.
  }
  process.env.FUSION_TEST_WORKER_ROOT = workerRoot;

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
    removeWorkerRootWithRetry(workerRoot);
    removeLegacyTopLevelHomeRoots();
  };
}
