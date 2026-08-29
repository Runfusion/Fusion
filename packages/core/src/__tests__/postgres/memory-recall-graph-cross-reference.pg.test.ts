/*
FNXC:MemoryRecall 2026-08-11-10:15:
Cross-reference ids are merged under a per-record advisory transaction lock. The contention test
proves serialization only: PostgreSQL holds the lock until commit, so there is no stable A-only
state to observe after A settles and before B can write its union.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import {
  appendRecall,
  getRecallRecord,
  mergeRecallGraphNodeIds,
  setRecallGraphNodeIdsTestHooksForTest,
} from "../../memory/recall/recall-store.js";

pgDescribe("memory recall graph cross-references (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_memory_recall_xref", projectId: "xref-project-a", poolMax: 2,
  });
  const layerA = () => Object.assign(h.layer(), { projectId: "xref-project-a" });
  const layerB = () => ({ ...h.layer(), projectId: "xref-project-b" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(async () => {
    setRecallGraphNodeIdsTestHooksForTest(undefined);
    await h.afterEach();
  });
  afterAll(h.afterAll);

  async function record(): Promise<string> {
    const appended = await appendRecall(layerA(), {
      kind: "decision", content: "Cross-reference fixture", source: { origin: "manual" },
    });
    if (appended.status !== "created") throw new Error("Expected fixture record creation");
    return appended.record.id;
  }

  async function independentLayer(projectId: string): Promise<AsyncDataLayer> {
    const backend: ResolvedBackend = {
      mode: "external", runtimeUrl: h.testUrl(), migrationUrl: h.testUrl(), migrationUrlOverridden: false,
    };
    const connections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
    return createAsyncDataLayer(connections, { projectId });
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  }

  it("merges sorted ids without updating an unchanged record", async () => {
    const id = await record();
    expect(await mergeRecallGraphNodeIds(layerA(), id, [" b ", "a", "a", ""])).toEqual({ status: "updated" });
    const updated = await getRecallRecord(layerA(), id);
    expect(updated?.graphNodeIds).toEqual(["a", "b"]);
    const updatedAt = updated?.updatedAt;

    expect(await mergeRecallGraphNodeIds(layerA(), id, ["b", "a", "a"])).toEqual({ status: "unchanged" });
    const unchanged = await getRecallRecord(layerA(), id);
    expect(unchanged?.graphNodeIds).toEqual(["a", "b"]);
    expect(unchanged?.updatedAt).toBe(updatedAt);

    expect(await mergeRecallGraphNodeIds(layerA(), id, ["c"])).toEqual({ status: "updated" });
    expect((await getRecallRecord(layerA(), id))?.graphNodeIds).toEqual(["a", "b", "c"]);
  });

  it("serializes concurrent writers and retains their union", async () => {
    const id = await record();
    const firstLayer = await independentLayer("xref-project-a");
    const secondLayer = await independentLayer("xref-project-a");
    const enteredLock = deferred();
    const releaseFirst = deferred();
    let hooked = false;
    setRecallGraphNodeIdsTestHooksForTest({ afterRowRead: async () => {
      if (!hooked) {
        hooked = true;
        enteredLock.resolve();
        await releaseFirst.promise;
      }
    } });

    try {
      const first = mergeRecallGraphNodeIds(firstLayer, id, ["a"]);
      await enteredLock.promise;
      let secondSettled = false;
      const second = mergeRecallGraphNodeIds(secondLayer, id, ["b"]).finally(() => { secondSettled = true; });
      // B cannot pass the lock while A is paused after its guarded row read.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondSettled).toBe(false);
      releaseFirst.resolve();
      await expect(first).resolves.toEqual({ status: "updated" });
      await expect(second).resolves.toEqual({ status: "updated" });
      // Do not inspect after A alone: its commit immediately permits B to commit.
      expect((await getRecallRecord(layerA(), id))?.graphNodeIds).toEqual(["a", "b"]);
    } finally {
      releaseFirst.resolve();
      await Promise.all([firstLayer.close(), secondLayer.close()]);
    }
  });

  it("returns missing for missing and cross-project records", async () => {
    const id = await record();
    await expect(mergeRecallGraphNodeIds(layerA(), "missing", ["a"])).resolves.toEqual({ status: "missing" });
    await expect(mergeRecallGraphNodeIds(layerB(), id, ["a"])).resolves.toEqual({ status: "missing" });
  });
});
