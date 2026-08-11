/*
FNXC:MemoryRecall 2026-08-10-11:03:
Recall persistence is project-scoped and its near-duplicate decision is made under a PostgreSQL
transaction advisory lock. These integration assertions exercise the real migration and database
path rather than a mocked store, including concurrent writers and untrusted vector rankings.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  appendRecall,
  getRecallRecord,
  listRecall,
  searchRecall,
  setRecallAppendTestHooksForTest,
} from "../../memory/recall/recall-store.js";
import {
  RECALL_DEDUP_CANDIDATE_LIMIT,
  recallContentHash,
} from "../../memory/recall/recall-dedup.js";
import {
  RECALL_SEARCH_DEFAULT_LIMIT,
  RECALL_SEARCH_MAX_LIMIT,
} from "../../memory/recall/recall-search.js";
import { project } from "../../postgres/schema/index.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";

pgDescribe("memory recall store (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_memory_recall", projectId: "recall-project-a",
  });
  const layerA = () => Object.assign(h.layer(), { projectId: "recall-project-a" });
  const layerB = () => ({ ...h.layer(), projectId: "recall-project-b" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(async () => {
    setRecallAppendTestHooksForTest(undefined);
    await h.afterEach();
  });
  afterAll(h.afterAll);

  async function independentLayer(projectId: string): Promise<AsyncDataLayer> {
    const backend: ResolvedBackend = {
      mode: "external", runtimeUrl: h.testUrl(), migrationUrl: h.testUrl(), migrationUrlOverridden: false,
    };
    const connections = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
    return createAsyncDataLayer(connections, { projectId });
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  }

  async function assertSerializedAppend(firstContent: string, secondContent: string): Promise<void> {
    const firstLayer = await independentLayer("recall-project-a");
    const secondLayer = await independentLayer("recall-project-a");
    const reachedCandidateRead = deferred();
    const releaseFirst = deferred();
    let held = false;
    setRecallAppendTestHooksForTest({ afterCandidateRead: async () => {
      if (!held) {
        held = true;
        reachedCandidateRead.resolve();
        await releaseFirst.promise;
      }
    } });
    try {
      const first = appendRecall(firstLayer, {
        kind: "decision", content: firstContent, source: { origin: "manual" },
      });
      await reachedCandidateRead.promise;
      let secondSettled = false;
      const second = appendRecall(secondLayer, {
        kind: "decision", content: secondContent, source: { origin: "manual" },
      }).finally(() => { secondSettled = true; });
      // The second independent connection cannot reach its candidate read until the first lock releases.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondSettled).toBe(false);
      releaseFirst.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect([firstResult.status, secondResult.status].sort()).toEqual(["created", "duplicate"]);
      const records = await listRecall(layerA(), { kinds: ["decision"], limit: 50 });
      expect(records).toHaveLength(1);
      const created = firstResult.status === "created" ? firstResult.record : secondResult.record;
      const duplicate = firstResult.status === "duplicate" ? firstResult : secondResult;
      expect(duplicate.duplicateOf.id).toBe(created.id);
    } finally {
      releaseFirst.resolve();
      await Promise.all([firstLayer.close(), secondLayer.close()]);
    }
  }

  it("applies the migration and preserves project-scoped typed records", async () => {
    const tables = await h.adminDb().execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'project' AND table_name = 'memory_recall_records'
    `);
    expect(tables).toHaveLength(1);

    for (const kind of ["decision", "preference", "solution"] as const) {
      const result = await appendRecall(layerA(), {
        kind, content: `${kind} content`, source: {
          taskId: "FN-1", agentId: "agent-1", sessionId: "session-1", origin: "manual",
        }, tags: ["memory", kind], graphNodeIds: kind === "decision" ? ["node-1"] : [],
      });
      expect(result.status).toBe("created");
      if (result.status === "created") {
        expect(result.record.source).toMatchObject({ taskId: "FN-1", origin: "manual" });
        expect(result.record.tags).toContain(kind);
        expect(result.record.graphNodeIds).toEqual(kind === "decision" ? ["node-1"] : []);
        expect(result.record.createdAt).toBeTruthy();
        expect(result.record.updatedAt).toBeTruthy();
      }
    }
    const records = await listRecall(layerA(), { limit: 50 });
    expect(records).toHaveLength(3);
    expect(await searchRecall(layerB(), "content", { limit: 50 })).toMatchObject({ hits: [] });
    expect(await listRecall(layerB(), { limit: 50 })).toEqual([]);
    expect(await getRecallRecord(layerB(), records[0]!.id)).toBeNull();
  });

  it("serializes forced concurrent near-duplicate writers", async () => {
    const original = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
    const restatement = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen changed";
    await assertSerializedAppend(original, restatement);
  });

  it("serializes forced concurrent byte-identical writers", async () => {
    await assertSerializedAppend("identical concurrent decision", "identical concurrent decision");
  });

  it("uses ON CONFLICT recovery when the exact twin is outside the bounded candidate window", async () => {
    const content = "window evicted exact duplicate";
    const original = await appendRecall(layerA(), {
      kind: "decision", content, source: { origin: "manual" },
    });
    expect(original.status).toBe("created");
    if (original.status !== "created") return;
    await h.adminDb().insert(project.memoryRecallRecords).values(
      Array.from({ length: RECALL_DEDUP_CANDIDATE_LIMIT }, (_, index) => {
        const filler = `unrelated filler ${index}`;
        return {
          projectId: "recall-project-a", id: `filler-${index}`, kind: "decision", content: filler,
          contentHash: recallContentHash("decision", filler), source: { origin: "manual" }, tags: [], graphNodeIds: [],
          createdAt: `2030-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`, updatedAt: "2030-01-01T00:00:00.000Z",
        };
      }),
    );
    const duplicate = await appendRecall(layerA(), {
      kind: "decision", content, source: { origin: "manual" },
    });
    expect(duplicate).toMatchObject({
      status: "duplicate", similarity: 1, duplicateOf: { id: original.record.id },
    });
    const rows = await h.adminDb().select({ total: sql<number>`count(*)::int` })
      .from(project.memoryRecallRecords)
      .where(eq(project.memoryRecallRecords.projectId, "recall-project-a"));
    expect(rows[0]?.total).toBe(RECALL_DEDUP_CANDIDATE_LIMIT + 1);
  });

  it("demonstrates the unguarded near-duplicate race on two independent connections", async () => {
    const firstLayer = await independentLayer("recall-project-a");
    const secondLayer = await independentLayer("recall-project-a");
    const bothRead = deferred();
    let readerCount = 0;
    const content = ["unguarded alpha beta gamma", "unguarded alpha beta changed"];
    const unguardedInsert = (layer: AsyncDataLayer, index: number) => layer.transactionImmediate(async (tx) => {
      await tx.select({ id: project.memoryRecallRecords.id }).from(project.memoryRecallRecords)
        .where(and(eq(project.memoryRecallRecords.projectId, "recall-project-a"), eq(project.memoryRecallRecords.kind, "decision")));
      readerCount += 1;
      if (readerCount === 2) bothRead.resolve();
      await bothRead.promise;
      await tx.insert(project.memoryRecallRecords).values({
        projectId: "recall-project-a", id: `unguarded-${index}`, kind: "decision", content: content[index]!,
        contentHash: recallContentHash("decision", content[index]!), source: { origin: "manual" }, tags: [], graphNodeIds: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    });
    try {
      await Promise.all([unguardedInsert(firstLayer, 0), unguardedInsert(secondLayer, 1)]);
      const rows = await listRecall(layerA(), { kinds: ["decision"], limit: 50 });
      expect(rows).toHaveLength(2);
    } finally {
      await Promise.all([firstLayer.close(), secondLayer.close()]);
    }
  });

  it("scopes writer locks by project and kind while reads remain non-blocking", async () => {
    const decisionLayer = await independentLayer("recall-project-a");
    const otherProjectLayer = await independentLayer("recall-project-b");
    const reachedCandidateRead = deferred();
    const releaseDecision = deferred();
    let held = false;
    setRecallAppendTestHooksForTest({ afterCandidateRead: async () => {
      if (!held) {
        held = true;
        reachedCandidateRead.resolve();
        await releaseDecision.promise;
      }
    } });
    try {
      const heldAppend = appendRecall(decisionLayer, {
        kind: "decision", content: "held decision", source: { origin: "manual" },
      });
      await reachedCandidateRead.promise;
      await expect(Promise.race([
        searchRecall(layerA(), "held", { limit: 2 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read was serialized")), 500)),
      ])).resolves.toMatchObject({ hits: [] });
      const [solution, otherProject] = await Promise.all([
        appendRecall(layerA(), { kind: "solution", content: "other kind", source: { origin: "manual" } }),
        appendRecall(otherProjectLayer, { kind: "decision", content: "other project", source: { origin: "manual" } }),
      ]);
      expect(solution.status).toBe("created");
      expect(otherProject.status).toBe("created");
      releaseDecision.resolve();
      expect((await heldAppend).status).toBe("created");
    } finally {
      releaseDecision.resolve();
      await Promise.all([decisionLayer.close(), otherProjectLayer.close()]);
    }
  });

  it("filters searches and re-enforces vector provider result limits", async () => {
    for (let index = 0; index < 8; index += 1) {
      await appendRecall(layerA(), {
        kind: index % 2 ? "solution" : "decision", content: `alpha solution ${index}`,
        source: { origin: "manual" }, tags: index % 2 ? ["alpha", "solution"] : ["alpha", "decision"],
      });
    }
    const keyword = await searchRecall(layerA(), "alpha", { kinds: ["solution"], tags: ["alpha"], limit: 2 });
    expect(keyword.mode).toBe("keyword");
    expect(keyword.hits).toHaveLength(2);
    expect(keyword.hits.every((hit) => hit.record.kind === "solution")).toBe(true);
    expect((await listRecall(layerA())).length).toBeLessThanOrEqual(RECALL_SEARCH_DEFAULT_LIMIT);
    expect((await listRecall(layerA(), { limit: 10_000 })).length).toBeLessThanOrEqual(RECALL_SEARCH_MAX_LIMIT);

    let overReturningIds: string[] = [];
    const provider = {
      id: "over-returning",
      search: async ({ candidates }: { candidates: readonly { id: string }[] }) => {
        const matches = candidates.slice(0, 5).map((record, index) => ({ recordId: record.id, score: index + 1 }));
        overReturningIds = matches.map((match) => match.recordId);
        expect(matches.length).toBeGreaterThan(2);
        return [...matches, { recordId: "unknown", score: 99 }, matches[0]!];
      },
    };
    const vector = await searchRecall(layerA(), "alpha", { limit: 2, vector: provider });
    expect(vector).toMatchObject({ mode: "vector", capabilities: { vector: true } });
    expect(vector.hits.map((hit) => hit.record.id)).toEqual(overReturningIds.slice(-2).reverse());
    expect(vector.hits).toHaveLength(2);

    const degraded = await searchRecall(layerA(), "alpha", {
      limit: 2, vector: { id: "failing", search: async () => { throw new Error("offline"); } },
    });
    expect(degraded).toMatchObject({ mode: "keyword", capabilities: { vector: true } });
    expect(degraded.hits.length).toBeLessThanOrEqual(2);

    const unknownOnly = await searchRecall(layerA(), "alpha", {
      limit: 2, vector: { id: "unknown-only", search: async () => [{ recordId: "missing", score: 1 }] },
    });
    expect(unknownOnly).toMatchObject({ mode: "keyword", capabilities: { vector: true } });

    let candidateIds: string[] = [];
    const pathological = await searchRecall(layerA(), "alpha", {
      limit: 5,
      vector: {
        id: "pathological",
        search: async ({ candidates }: { candidates: readonly { id: string }[] }) => {
          candidateIds = candidates.map((candidate) => candidate.id);
          return [
            ...candidates.flatMap((candidate, index) => [
              { recordId: candidate.id, score: index },
              { recordId: candidate.id, score: index + 100 },
            ]),
            ...Array.from({ length: 20 }, (_, index) => ({ recordId: `unknown-${index}`, score: index + 500 })),
          ];
        },
      },
    });
    expect(pathological).toMatchObject({ mode: "vector", capabilities: { vector: true } });
    expect(pathological.hits.length).toBeLessThanOrEqual(5);
    expect(pathological.hits.length).toBeLessThanOrEqual(candidateIds.length);
    expect(pathological.hits.every((hit) => candidateIds.includes(hit.record.id))).toBe(true);
    expect(new Set(pathological.hits.map((hit) => hit.record.id)).size).toBe(pathological.hits.length);
  });
});
