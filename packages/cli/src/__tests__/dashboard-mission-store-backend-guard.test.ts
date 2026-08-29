/**
 * FNXC:MissionStore 2026-06-27-16:15:
 * Regression test for the dashboard boot blocker (VAL-CROSS-001/002/005/006).
 *
 * packages/cli/src/commands/dashboard.ts eagerly constructed MissionAutopilot
 * and MissionExecutionLoop by calling `store.getMissionStore()` at startup.
 * Originally `getMissionStore()` reached `store.db` which threw
 * "SQLite Database is not available in backend mode", crashing the entire
 * `fn dashboard` / `fn serve` boot before the HTTP server could serve.
 *
 * After the MissionStore async migration (getMissionStoreImpl now returns the
 * AsyncDataLayer-backed AsyncMissionStore in backend mode), the call no longer
 * throws. The dashboard guard was updated to key off `instanceof MissionStore`:
 * in backend mode the returned AsyncMissionStore is CRUD-only and is NOT the
 * sync EventEmitter MissionStore that MissionAutopilot/MissionExecutionLoop are
 * coupled to, so the guard degrades missionAutopilotImpl /
 * missionExecutionLoopImpl to undefined. The createServer proxy objects already
 * route through optional chaining, so undefined disables mission lifecycle
 * features without breaking dashboard boot.
 *
 * This test asserts the invariant the guard relies on: a backend-mode store's
 * getMissionStore() returns an AsyncMissionStore (not a sync MissionStore) AND
 * isBackendMode() returns true, so the `instanceof MissionStore` guard is both
 * necessary (without it, autopilot would be constructed against the wrong store
 * shape) and sufficient (the ternary yields undefined rather than a crash).
 *
 * Note (VAL-REMOVAL-005): this test deliberately does NOT call the removed sync
 * `new TaskStore().init()` SQLite path. It stubs `asyncLayer` to flip the store
 * into backend mode — a pure construction-time property that does not require a
 * live PostgreSQL connection or allocator reconciliation.
 */
import { describe, expect, it } from "vitest";
import { TaskStore, MissionStore, AsyncMissionStore } from "@fusion/core";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Builds a backend-mode TaskStore WITHOUT booting a real PostgreSQL instance.
 * We only need the store to report isBackendMode() === true and to resolve
 * getMissionStore() to the AsyncMissionStore — both are pure construction-time
 * properties that do not require a live database connection. The asyncLayer
 * stub is enough to flip the store into backend mode.
 */
async function createBackendModeStore(): Promise<TaskStore> {
  const rootDir = await mkdtemp(join(tmpdir(), "dashboard-ms-guard-"));
  // A minimal AsyncDataLayer stub: the store only needs the layer to be
  // non-null so backendMode flips to true in the constructor. We deliberately
  // do NOT call store.init() — the properties under test (isBackendMode() and
  // the getMissionStore() return value) are construction-time and do not
  // require a live database connection or allocator reconciliation.
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

  it("getMissionStore() returns AsyncMissionStore, not the sync MissionStore, in backend mode", async () => {
    const store = await createBackendModeStore();
    // The dashboard guard keys off `instanceof MissionStore`: in backend mode
    // getMissionStoreImpl returns the AsyncMissionStore (CRUD-only). It does
    // NOT throw, and the result is not the sync EventEmitter MissionStore that
    // MissionAutopilot/MissionExecutionLoop are coupled to — so the guard
    // degrades mission autopilot to undefined.
    const missionStore = store.getMissionStore();
    expect(missionStore).toBeInstanceOf(AsyncMissionStore);
    expect(missionStore).not.toBeInstanceOf(MissionStore);
  });

  it("the instanceof guard degrades to undefined instead of booting autopilot", async () => {
    // This mirrors the exact guard now in packages/cli/src/commands/dashboard.ts
    // (the `instanceof MissionStore` ternary, updated FNXC:MissionStore
    // 2026-06-27-16:15 after the getMissionStore() async migration).
    const store = await createBackendModeStore();
    const resolvedMissionStore = store.getMissionStore();
    // `resolvedMissionStore instanceof MissionStore ? resolvedMissionStore : undefined`
    const missionStore = resolvedMissionStore instanceof MissionStore ? resolvedMissionStore : undefined;
    // missionAutopilotImpl / missionExecutionLoopImpl are gated on `missionStore ?`
    // (dashboard.ts:1554), so undefined disables mission lifecycle features and the
    // createServer proxy optional-chaining degrades safely.
    expect(missionStore).toBeUndefined();
  });
});
