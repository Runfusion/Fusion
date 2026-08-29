/**
 * FNXC:PostgresOnlyDataAccess 2026-07-16-11:45:
 * Regression: the merger's deterministic-verification cache ops used the sync
 * SQLite `store.db` unguarded, so the cache read threw "SQLite Database is not
 * available in backend mode" on every merge with a resolvable tree sha (and
 * cache writes were silently swallowed by the merger's try/catch). Both ops now
 * route to the project-schema verification_cache table in backend mode.
 */
import { describe, it, expect } from "vitest";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("verification cache backend mode (PostgreSQL)", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_verif_cache" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("records and reads back a verification pass in backend mode", async () => {
    const h = await makeHarness();
    try {
      const treeSha = "a".repeat(40);

      expect(await h.store.getVerificationCacheHit(treeSha, "pnpm test", "pnpm build")).toBeNull();

      await h.store.recordVerificationCachePass(treeSha, "pnpm test", "pnpm build", "FN-1");
      const hit = await h.store.getVerificationCacheHit(treeSha, "pnpm test", "pnpm build");
      expect(hit).not.toBeNull();
      expect(hit!.taskId).toBe("FN-1");
      expect(typeof hit!.recordedAt).toBe("string");

      // Different command set is a distinct cache key.
      expect(await h.store.getVerificationCacheHit(treeSha, "pnpm test", "")).toBeNull();

      // Re-recording the same key updates in place (upsert, no conflict throw).
      await h.store.recordVerificationCachePass(treeSha, "pnpm test", "pnpm build", "FN-2");
      const updated = await h.store.getVerificationCacheHit(treeSha, "pnpm test", "pnpm build");
      expect(updated!.taskId).toBe("FN-2");
    } finally {
      await teardown();
    }
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;
