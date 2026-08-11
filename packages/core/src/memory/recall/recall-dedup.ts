import { createHash } from "node:crypto";
import type { RecallKind, RecallRecord } from "./recall-types.js";

export const RECALL_DEDUP_SIMILARITY_THRESHOLD = 0.9;
export const RECALL_DEDUP_CANDIDATE_LIMIT = 200;

/*
FNXC:MemoryRecall 2026-08-10-11:03:
Dedup compares normalized same-kind content in a bounded recent window. An older exact twin can fall
outside that window, so the database exact-hash constraint remains a required backstop.
*/
export function normalizeRecallContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?,;:]+$/g, "");
}
export function recallContentHash(kind: RecallKind, content: string): string {
  return createHash("sha256").update(`${kind}\0${normalizeRecallContent(content)}`).digest("hex");
}
function tokens(content: string): Set<string> { return new Set(normalizeRecallContent(content).split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)); }
export function recallSimilarity(a: string, b: string): number {
  const left = tokens(a), right = tokens(b); const union = new Set([...left, ...right]);
  if (!union.size) return 1;
  let common = 0; for (const token of left) if (right.has(token)) common += 1;
  return common / union.size;
}
export function classifyRecallDuplicate(candidate: Pick<RecallRecord, "kind" | "content" | "contentHash">, existingRecords: readonly RecallRecord[]) {
  for (const record of existingRecords) {
    if (record.kind !== candidate.kind) continue;
    if (record.contentHash === candidate.contentHash) return { record, similarity: 1 };
    const similarity = recallSimilarity(candidate.content, record.content);
    if (similarity >= RECALL_DEDUP_SIMILARITY_THRESHOLD) return { record, similarity };
  }
  return undefined;
}
/* FNXC:MemoryRecall 2026-08-10-11:03: Classification is read-then-write and unsafe without serializing this key across its candidate read and insert. */
export function recallDedupLockKey(projectId: string, kind: RecallKind): string { return `fusion:memory-recall:${projectId}:${kind}`; }
