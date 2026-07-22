/*
FNXC:LegacyAdoption 2026-07-22-10:15:
#2387 only reproduced after startup re-bound TaskStore to fusion_runtime. Unit
fakes cannot prove the public-schema grant or SECURITY DEFINER boundary, so this
PG integration test exercises the same restricted role and proves a clean
second store-open sweep short-circuits instead of recreating CLI warn spam.
*/
import {expect, it, vi} from "vitest";
import {sql} from "drizzle-orm";
import {TaskStore} from "../../store.js";
import {createConnectionSetFromUrl} from "../../postgres/connection.js";
import {createAsyncDataLayer} from "../../postgres/data-layer.js";
import {
  LEGACY_ADOPTION_DRAINED_MARKER,
  LEGACY_ADOPTION_DRAINED_MARKER_FUNCTION,
  MIGRATION_BOOKKEEPING_TABLE,
} from "../../postgres/schema-applier.js";
import {createTaskStoreForTest, pgDescribe} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("legacy-adoption drained marker: fusion_runtime integration (#2387)", () => {
  it("reads and writes the marker under fusion_runtime, then short-circuits a second clean sweep", async () => {
    const harness = await createTaskStoreForTest({prefix: "legacy_adoption_runtime_marker", copyFromGolden: true});
    const createRuntimeLayer = async () => {
      const connections = await createConnectionSetFromUrl(
        {
          mode: "external",
          runtimeUrl: harness.testUrl,
          migrationUrl: harness.testUrl,
          migrationUrlOverridden: false,
        },
        {poolMax: 1, connectTimeoutSeconds: 5, projectId: "legacy-marker-test", useRuntimeRole: true},
      );
      return createAsyncDataLayer(connections, {projectId: "legacy-marker-test"});
    };
    let firstStore: TaskStore | undefined;
    let secondStore: TaskStore | undefined;
    let runtimeLayer: ReturnType<typeof createAsyncDataLayer> | undefined;
    let stderr: ReturnType<typeof vi.spyOn> | undefined;
    let warnings: ReturnType<typeof vi.spyOn> | undefined;
    try {
      runtimeLayer = await createRuntimeLayer();
      await harness.adminDb.execute(sql`DELETE FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} WHERE version = ${LEGACY_ADOPTION_DRAINED_MARKER}`);

      // Direct role proof: no broad INSERT is granted, but SELECT and the restricted helper work.
      await expect(runtimeLayer.db.execute(sql`SELECT current_user`)).resolves.toEqual([{current_user: "fusion_runtime"}]);
      await expect(runtimeLayer.db.execute(
        sql`SELECT version FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} WHERE version = ${LEGACY_ADOPTION_DRAINED_MARKER}`,
      )).resolves.toEqual([]);
      await expect(runtimeLayer.db.execute(sql`SELECT public.${sql.identifier(LEGACY_ADOPTION_DRAINED_MARKER_FUNCTION)}()`)).resolves.toBeDefined();
      await expect(runtimeLayer.db.execute(
        sql`SELECT version FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} WHERE version = ${LEGACY_ADOPTION_DRAINED_MARKER}`,
      )).resolves.toEqual([{version: LEGACY_ADOPTION_DRAINED_MARKER}]);
      await runtimeLayer.close();
      runtimeLayer = undefined;

      // FNXC:LegacyAdoption 2026-07-22-16:10:
      // #2387 must be proven through TaskStore.init(), the production store-open hook.
      // Two independently runtime-bound stores model two CLI opens: the first scans and
      // writes the marker; the second must read it before listTasks can start a census.
      stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await harness.adminDb.execute(sql`DELETE FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} WHERE version = ${LEGACY_ADOPTION_DRAINED_MARKER}`);

      firstStore = new TaskStore(harness.rootDir, undefined, {asyncLayer: await createRuntimeLayer()});
      const firstListTasks = vi.spyOn(firstStore, "listTasks");
      await firstStore.init();
      expect(firstListTasks).toHaveBeenCalled();
      await expect(harness.adminDb.execute(
        sql`SELECT version FROM public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} WHERE version = ${LEGACY_ADOPTION_DRAINED_MARKER}`,
      )).resolves.toEqual([{version: LEGACY_ADOPTION_DRAINED_MARKER}]);
      await firstStore.close();
      firstStore = undefined;

      secondStore = new TaskStore(harness.rootDir, undefined, {asyncLayer: await createRuntimeLayer()});
      const secondListTasks = vi.spyOn(secondStore, "listTasks");
      await secondStore.init();
      expect(secondListTasks).not.toHaveBeenCalled();
      expect([...stderr.mock.calls, ...warnings.mock.calls].filter(([message]) =>
        String(message).includes("Legacy-adoption drained-marker"),
      )).toEqual([]);
    } finally {
      stderr?.mockRestore();
      warnings?.mockRestore();
      if (firstStore) await firstStore.close();
      if (secondStore) await secondStore.close();
      if (runtimeLayer) await runtimeLayer.close();
      await harness.teardown();
    }
  });
});
