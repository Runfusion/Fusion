import type { RecallCapabilities, RecallRecord, RecallSearchHit } from "./recall-types.js";
export const RECALL_SEARCH_DEFAULT_LIMIT = 10;
export const RECALL_SEARCH_MAX_LIMIT = 50;
export interface RecallVectorMatch { recordId: string; score: number; }
export interface RecallVectorSearchProvider { readonly id: string; search(input: { query: string; candidates: readonly RecallRecord[]; limit: number }): Promise<readonly RecallVectorMatch[]>; }
export interface RecallSearchOptions { kinds?: readonly RecallRecord["kind"][]; tags?: readonly string[]; limit?: number | null; vector?: RecallVectorSearchProvider; }
/* FNXC:MemoryRecall 2026-08-10-11:03: All hit-producing paths use this one clamp; malformed, zero, and non-integral values resolve to the default, preserving bounded deterministic reads. */
export function clampRecallSearchLimit(requested?: number | null): number { return typeof requested !== "number" || !Number.isFinite(requested) || !Number.isInteger(requested) || requested <= 0 ? RECALL_SEARCH_DEFAULT_LIMIT : Math.min(requested, RECALL_SEARCH_MAX_LIMIT); }
export function resolveRecallCapabilities(provider?: RecallVectorSearchProvider): RecallCapabilities { return { keyword: true, vector: Boolean(provider), persistent: true }; }
function terms(value: string): string[] { return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))]; }
export function searchRecallKeyword(query: string, candidates: readonly RecallRecord[], limit: number): RecallSearchHit[] {
  const queryTerms = terms(query);
  return candidates.map((record) => { const content = new Set(terms(record.content)); const tags = new Set(record.tags.flatMap(terms)); const matchedTerms = queryTerms.filter((term) => content.has(term) || tags.has(term)); const score = queryTerms.reduce((sum, term) => sum + (content.has(term) ? 1 : 0) + (tags.has(term) ? 2 : 0), 0); return { record, score, matchedTerms }; }).filter((hit) => hit.score > 0).sort((a,b) => b.score-a.score || b.record.createdAt.localeCompare(a.record.createdAt) || a.record.id.localeCompare(b.record.id)).slice(0, limit);
}
/* FNXC:MemoryRecall 2026-08-10-11:03: Providers rank untrusted candidate ids only. Store-side deduplication and post-ranking slicing prevent excess, duplicate, or unknown matches from escaping the common cap. */
export function applyRecallVectorRanking(candidates: readonly RecallRecord[], matches: readonly RecallVectorMatch[], limit: number): RecallSearchHit[] {
 const byId = new Map(candidates.map((record) => [record.id, record])); const best = new Map<string, RecallVectorMatch>();
 for (const match of matches) if (byId.has(match.recordId) && Number.isFinite(match.score) && (!best.has(match.recordId) || best.get(match.recordId)!.score < match.score)) best.set(match.recordId, match);
 return [...best.values()].map((match) => ({ record: byId.get(match.recordId)!, score: match.score, matchedTerms: [] })).sort((a,b) => b.score-a.score || b.record.createdAt.localeCompare(a.record.createdAt) || a.record.id.localeCompare(b.record.id)).slice(0, limit);
}
