import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import { project } from "../../postgres/schema/index.js";
import { MemoryBackendError } from "../memory-backend.js";
import { RECALL_DEDUP_CANDIDATE_LIMIT, classifyRecallDuplicate, recallContentHash, recallDedupLockKey, recallGraphNodeIdsLockKey } from "./recall-dedup.js";
import { applyRecallVectorRanking, clampRecallSearchLimit, resolveRecallCapabilities, searchRecallKeyword, type RecallSearchOptions } from "./recall-search.js";
import type { RecallAppendInput, RecallAppendResult, RecallRecord, RecallSearchResult } from "./recall-types.js";

type RecallRow = typeof project.memoryRecallRecords.$inferSelect;

type RecallAppendTestHooks = {
  afterCandidateRead?: () => void | Promise<void>;
};
type RecallGraphNodeIdsTestHooks = { afterRowRead?: () => void | Promise<void> };

// Intentionally omitted from the recall barrel: PG tests use this to force the lock interleaving.
let appendRecallTestHooks: RecallAppendTestHooks | undefined;
export function setRecallAppendTestHooksForTest(hooks: RecallAppendTestHooks | undefined): void {
  appendRecallTestHooks = hooks;
}

// Intentionally omitted from the recall barrel: PG tests use this to prove lock serialization.
let recallGraphNodeIdsTestHooks: RecallGraphNodeIdsTestHooks | undefined;
export function setRecallGraphNodeIdsTestHooksForTest(hooks: RecallGraphNodeIdsTestHooks | undefined): void {
  recallGraphNodeIdsTestHooks = hooks;
}

const map = (row: RecallRow): RecallRecord => ({ ...row, kind: row.kind as RecallRecord["kind"], source: row.source as RecallRecord["source"], tags: row.tags as string[], graphNodeIds: row.graphNodeIds as string[] });
function projectId(layer: AsyncDataLayer): string { if (!layer.projectId) throw new MemoryBackendError("BACKEND_UNAVAILABLE", "Recall requires AsyncDataLayer.projectId", "recall"); return layer.projectId; }

/*
FNXC:MemoryRecall 2026-08-10-11:03:
The advisory transaction lock is first, spans candidate read and insert, and is namespaced by project/kind.
It is the sole lock in this path, preventing read-then-write near-duplicate races without serializing other kinds.
ON CONFLICT DO NOTHING preserves transaction usability: raising 23505 would poison a re-select; the branch is reachable
when an exact twin falls outside the bounded candidate window or a bypassing writer races this transaction.
*/
export async function appendRecall(layer: AsyncDataLayer, input: RecallAppendInput): Promise<RecallAppendResult> {
 const pid = projectId(layer); const now = new Date().toISOString(); const contentHash = recallContentHash(input.kind, input.content); const table = project.memoryRecallRecords;
 return layer.transactionImmediate(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${recallDedupLockKey(pid, input.kind)}))`);
  const candidates = (await tx.select().from(table).where(and(eq(table.projectId, pid), eq(table.kind, input.kind))).orderBy(desc(table.createdAt)).limit(RECALL_DEDUP_CANDIDATE_LIMIT)).map(map);
  await appendRecallTestHooks?.afterCandidateRead?.();
  const duplicate = classifyRecallDuplicate({ kind: input.kind, content: input.content, contentHash }, candidates);
  if (duplicate) return { status: "duplicate", duplicateOf: duplicate.record, similarity: duplicate.similarity };
  const inserted = await tx.insert(table).values({ projectId: pid, id: randomUUID(), kind: input.kind, content: input.content, contentHash, source: input.source, tags: input.tags ?? [], graphNodeIds: input.graphNodeIds ?? [], createdAt: now, updatedAt: now }).onConflictDoNothing({ target: [table.projectId, table.kind, table.contentHash] }).returning();
  if (inserted[0]) return { status: "created", record: map(inserted[0]) };
  const exact = await tx.select().from(table).where(and(eq(table.projectId, pid), eq(table.kind, input.kind), eq(table.contentHash, contentHash))).limit(1);
  if (!exact[0]) throw new MemoryBackendError("CONFLICT", "Recall exact-hash conflict disappeared before recovery", "recall");
  return { status: "duplicate", duplicateOf: map(exact[0]), similarity: 1 };
 });
}
/*
FNXC:MemoryRecall 2026-08-11-09:41:
FN-8922 reserved graph_node_ids for part 4. A per-record advisory lock keeps the read-union-write
atomic across processes: ids only grow, unrelated records and kind-dedup do not serialize, and an
equal union performs no UPDATE so unchanged consolidation ticks do not churn updated_at. Callers
must not move the read outside this transaction to fabricate an interleaving; lock holders serialize
until commit and the second writer unions the committed first value.
*/
export async function mergeRecallGraphNodeIds(layer: AsyncDataLayer, recordId: string, addGraphNodeIds: string[]): Promise<{ status: "updated" | "unchanged" | "missing" }> {
  const pid = projectId(layer);
  const table = project.memoryRecallRecords;
  const normalize = (ids: readonly string[]) => [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
  return layer.transactionImmediate(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${recallGraphNodeIdsLockKey(pid, recordId)}))`);
    const rows = await tx.select().from(table).where(and(eq(table.projectId, pid), eq(table.id, recordId))).limit(1);
    await recallGraphNodeIdsTestHooks?.afterRowRead?.();
    const row = rows[0];
    if (!row) return { status: "missing" };
    const stored = normalize(row.graphNodeIds as string[]);
    const next = normalize([...stored, ...addGraphNodeIds]);
    if (stored.length === next.length && stored.every((value, index) => value === next[index])) return { status: "unchanged" };
    await tx.update(table).set({ graphNodeIds: next, updatedAt: new Date().toISOString() }).where(and(eq(table.projectId, pid), eq(table.id, recordId)));
    return { status: "updated" };
  });
}

export async function getRecallRecord(layer: AsyncDataLayer, id: string): Promise<RecallRecord | null> { const pid=projectId(layer); const row=await layer.db.select().from(project.memoryRecallRecords).where(and(eq(project.memoryRecallRecords.projectId,pid),eq(project.memoryRecallRecords.id,id))).limit(1); return row[0] ? map(row[0]) : null; }
export async function listRecall(layer: AsyncDataLayer, options?: { kinds?: RecallRecord["kind"][]; limit?: number | null }): Promise<RecallRecord[]> { const pid=projectId(layer), t=project.memoryRecallRecords, limit=clampRecallSearchLimit(options?.limit); const rows=await layer.db.select().from(t).where(and(eq(t.projectId,pid), options?.kinds?.length ? inArray(t.kind, options.kinds) : undefined)).orderBy(desc(t.createdAt)).limit(limit); return rows.map(map); }
export async function deleteRecallRecord(layer: AsyncDataLayer, id: string): Promise<boolean> { const pid=projectId(layer); const rows=await layer.db.delete(project.memoryRecallRecords).where(and(eq(project.memoryRecallRecords.projectId,pid),eq(project.memoryRecallRecords.id,id))).returning({ id: project.memoryRecallRecords.id }); return Boolean(rows[0]); }
/* FNXC:MemoryRecall 2026-08-10-11:03: Vector providers only rank store-filtered candidates; failures degrade to deterministic keyword hits while the shared clamp remains authoritative after ranking. */
export async function searchRecall(layer: AsyncDataLayer, query: string, options?: RecallSearchOptions): Promise<RecallSearchResult> { const pid=projectId(layer), t=project.memoryRecallRecords, limit=clampRecallSearchLimit(options?.limit); let rows=(await layer.db.select().from(t).where(and(eq(t.projectId,pid), options?.kinds?.length ? inArray(t.kind, [...options.kinds]) : undefined)).orderBy(desc(t.createdAt))).map(map); if(options?.tags?.length) rows=rows.filter((r)=>options.tags!.every((tag)=>r.tags.includes(tag))); const keyword=searchRecallKeyword(query,rows,limit), capabilities=resolveRecallCapabilities(options?.vector); if(!options?.vector) return {hits:keyword,mode:"keyword",capabilities}; try { const matches=await options.vector.search({query,candidates:rows,limit}); const hits=applyRecallVectorRanking(rows,matches,limit); return hits.length ? {hits,mode:"vector",capabilities} : {hits:keyword,mode:"keyword",capabilities}; } catch { return {hits:keyword,mode:"keyword",capabilities}; } }
