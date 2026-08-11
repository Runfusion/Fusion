/*
FNXC:MemoryRecall 2026-08-10-11:03:
Recall records retain durable decisions, preferences, and solutions separately from markdown memory so
callers can filter provenance without coupling this layer to capture automation or an MCP surface.
*/
export type RecallKind = "decision" | "preference" | "solution";
export type RecallOrigin = "chat" | "council" | "deep-research" | "task-completion" | "manual" | "other";
export interface RecallSource { origin: RecallOrigin; taskId?: string; agentId?: string; sessionId?: string; }
export interface RecallRecord { id: string; projectId: string; kind: RecallKind; content: string; contentHash: string; source: RecallSource; tags: string[]; graphNodeIds: string[]; createdAt: string; updatedAt: string; }
export interface RecallAppendInput { kind: RecallKind; content: string; source: RecallSource; tags?: string[]; graphNodeIds?: string[]; }
export type RecallAppendResult = { status: "created"; record: RecallRecord } | { status: "duplicate"; duplicateOf: RecallRecord; similarity: number };
export interface RecallCapabilities { keyword: true; vector: boolean; persistent: true; }
export interface RecallSearchHit { record: RecallRecord; score: number; matchedTerms: string[]; }
export interface RecallSearchResult { hits: RecallSearchHit[]; mode: "keyword" | "vector"; capabilities: RecallCapabilities; }
