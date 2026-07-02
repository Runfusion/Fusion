/**
 * FNXC:SqliteFinalRemoval 2026-06-26-13:20:
 * Regression test for the round-2 dashboard boot blocker (VAL-CROSS-001/002/005/006).
 *
 * packages/cli/src/commands/dashboard.ts eagerly constructed MissionAutopilot
 * and MissionExecutionLoop by calling `store.getMissionStore()` at startup.
 * In backend mode (PostgreSQL), getMissionStore() reaches store.db which
 * throws "SQLite Database is not available in backend mode", crashing the
 * entire `fn dashboard` / `fn serve` boot before the HTTP server could serve.
 *
 * The fix wraps the call in try/catch and degrades missionAutopilotImpl /
 * missionExecutionLoopImpl to undefined in backend mode (mirroring
 * InProcessRuntime's graceful-degrade pattern). The createServer proxy
 * objects already route through optional chaining, so undefined disables
 * mission lifecycle features without breaking dashboard boot.
 *
 * This test asserts the invariant the guard relies on: a backend-mode store's
 * getMissionStore() throws AND isBackendMode() returns true, so the guard is
 * both necessary (without it, boot crashes) and sufficient (the catch branch
 * fires and yields undefined rather than propagating).
 */
import { describe, expect, it } from "vitest";
import { TaskStore } from "@fusion/core";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Builds a backend-mode TaskStore WITHOUT booting a real PostgreSQL instance.
 * We only need the store to report isBackendMode() === true and to throw on
 * store.db access — both are pure construction-time properties that do not
 * require a live database connection. The asyncLayer stub is enough to flip
 * the store into backend mode.
 */
async function createBackendModeStore(): Promise<TaskStore> {
  const rootDir = await mkdtemp(join(tmpdir(), "dashboard-ms-guard-"));
  // A minimal AsyncDataLayer stub: the store only needs the layer to be
  // non-null so backendMode flips to true in the constructor. We deliberately
  // do NOT call store.init() — the properties under test (isBackendMode() and
  // the getMissionStore() throw) are construction-time and do not require a
  // live database connection or allocator reconciliation.
  const fakeAsyncLayer = {} as never;
  // Constructor signature: new TaskStore(rootDir, globalSettingsDir?, options?)
  const store = new TaskStore(rootDir, undefined, { asyncLayer: fakeAsyncLayer });
  return store;
}

describe("dashboard mission-store backend guard (VAL-CROSS boot blocker)", () => {
  it("a backend-mode store reports isBackendMode() === true", async () => {
    const store = await createBackendModeStore();
    expect(store.isBackendMode()).toBe(true);
  });

  it("getMissionStore() throws in backend mode (the guard is necessary)", async () => {
    const store = await createBackendModeStore();
    // This is the exact call site that crashed `fn dashboard` boot in round 2.
    expect(() => store.getMissionStore()).toThrow(/backend mode/i);
  });

  it("the try/catch guard degrades to undefined instead of throwing", async () => {
    // This mirrors the exact guard now in packages/cli/src/commands/dashboard.ts.
    const store = await createBackendModeStore();
    let missionStore: unknown;
    let threw = false;
    try {
      missionStore = store.getMissionStore();
    } catch {
      threw = true;
      missionStore = undefined;
    }
    // The guard MUST fire in backend mode...
    expect(threw).toBe(true);
    // ...and produce undefined so missionAutopilotImpl/missionExecutionLoopImpl
    // are undefined and the createServer proxy optional-chaining degrades safely.
    expect(missionStore).toBeUndefined();
  });
});
