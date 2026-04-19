/**
 * Vitest globalSetup hook. The returned function runs once after the entire
 * test run completes, regardless of whether individual workers exited cleanly.
 * Wipes the shared FUSION_TEST_WORKER_ROOT directory that holds per-worker
 * temp dirs created by vitest-setup.ts.
 */

import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKER_ROOT = join(tmpdir(), "fusion-test-workers");

export default function setup(): () => Promise<void> {
  // Set the env var here too so vitest-setup.ts workers pick it up even if
  // their own mkdir runs after globalSetup.
  process.env.FUSION_TEST_WORKER_ROOT = WORKER_ROOT;

  return async function teardown() {
    // IMPORTANT: do not remove WORKER_ROOT recursively here.
    // In some Vitest pool modes, global setup/teardown can run in multiple
    // processes. If one process deletes the shared root while another process
    // is still running with cwd inside it, the other process will fail with
    // ENOENT uv_cwd.
    //
    // Instead, clean up only this process's worker dirs. Other processes clean
    // up their own dirs via their exit hooks.
    const ownPrefix = `w-${process.pid}-`;
    try {
      const entries = readdirSync(WORKER_ROOT, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(ownPrefix)) continue;
        try {
          rmSync(join(WORKER_ROOT, entry.name), { recursive: true, force: true });
        } catch {
          // Ignore per-dir cleanup errors.
        }
      }
    } catch {
      // Ignore — OS cleans /tmp eventually.
    }
  };
}
