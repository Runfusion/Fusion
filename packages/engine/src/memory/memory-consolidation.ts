import type { GraphNode, RecallAppendInput, RecallAppendResult, RecoveryReason } from "@fusion/core";
import { deriveRecallMaterial } from "./memory-consolidation-material.js";

export type MemoryConsolidationTickInput = { agentId: string; projectId: string };
export type MemorySemanticsSkipReason = "unchanged" | "malformed-response" | "no-candidates" | "graph-unavailable";
export type MemoryConsolidationPorts = {
  refreshGraph: () => Promise<{ rationaleNodes: GraphNode[]; nodeCount: number; edgeCount: number; changed: boolean; recoveryReason: RecoveryReason | null; stats: { parsedFiles: number; reusedFiles: number; prunedFiles: number } }>;
  appendRecall: (input: RecallAppendInput) => Promise<RecallAppendResult>;
  mergeRecallGraphNodeIds: (recordId: string, ids: string[]) => Promise<{ status: "updated" | "unchanged" | "missing" }>;
  /** Semantic enrichment is optional for test ports but production resolves it beside graph I/O. */
  runSemantics?: (graphChanged: boolean) => Promise<{ written?: number; deduped?: number; droppedUnresolved?: number; skipped?: MemorySemanticsSkipReason }>;
  clock?: () => number;
  logger?: { warn(message: string): void };
};
export type MemoryConsolidationOutcome = { graphChanged: boolean; graphRecoveryReason: RecoveryReason | null; parsedFiles: number; reusedFiles: number; prunedFiles: number; nodeCount: number; edgeCount: number; recallCandidates: number; recallCreated: number; recallDuplicate: number; crossRefUpdated: number; crossRefUnchanged: number; crossRefMissing: number; semanticsWritten: number; semanticsDeduped: number; semanticsDroppedUnresolved: number; semanticsSkipped?: MemorySemanticsSkipReason; durationMs: number; changed: boolean; skipped?: "in-progress" };
export class MemoryConsolidationError extends Error { constructor(readonly stage: "graph" | "recall" | "cross-reference" | "semantics", message: string, options?: ErrorOptions) { super(message, options); this.name = "MemoryConsolidationError"; } }
const active = new Set<string>();
const empty = (): Omit<MemoryConsolidationOutcome, "skipped"> => ({ graphChanged:false, graphRecoveryReason:null, parsedFiles:0, reusedFiles:0, prunedFiles:0, nodeCount:0, edgeCount:0, recallCandidates:0, recallCreated:0, recallDuplicate:0, crossRefUpdated:0, crossRefUnchanged:0, crossRefMissing:0, semanticsWritten:0, semanticsDeduped:0, semanticsDroppedUnresolved:0, durationMs:0, changed:false });

/* FNXC:MemoryAgent 2026-08-11-09:41: The synchronous claim fences manual same-process reentry before any await. It complements heartbeat's per-agent lock; cross-process recall writes serialize in their own advisory locks. No watermark exists: graph fingerprints, recall dedup, and no-write-on-equal reference merges make an unchanged tick silent. */
export class MemoryConsolidationService {
  constructor(private readonly ports: MemoryConsolidationPorts) {}
  async runConsolidationTick(input: MemoryConsolidationTickInput): Promise<MemoryConsolidationOutcome> {
    const key = `${input.agentId}:${input.projectId}`;
    if (active.has(key)) return { ...empty(), skipped: "in-progress" };
    active.add(key);
    const started = (this.ports.clock ?? Date.now)();
    try {
      let graph;
      try { graph = await this.ports.refreshGraph(); } catch (cause) { throw new MemoryConsolidationError("graph", cause instanceof Error ? cause.message : String(cause), { cause }); }
      const byRecord = new Map<string, Set<string>>(); let created = 0; let duplicate = 0;
      for (const material of deriveRecallMaterial(graph.rationaleNodes, input.agentId)) {
        let result: RecallAppendResult;
        try { result = await this.ports.appendRecall(material.append); } catch (cause) { throw new MemoryConsolidationError("recall", cause instanceof Error ? cause.message : String(cause), { cause }); }
        const record = result.status === "created" ? result.record : result.duplicateOf;
        if (result.status === "created") created++; else duplicate++;
        const ids = byRecord.get(record.id) ?? new Set<string>(); material.graphNodeIds.forEach((id) => ids.add(id)); byRecord.set(record.id, ids);
      }
      let updated=0, unchanged=0, missing=0;
      let semanticsWritten = 0, semanticsDeduped = 0, semanticsDroppedUnresolved = 0, semanticsSkipped: MemorySemanticsSkipReason | undefined;
      if (this.ports.runSemantics) { try { const result = await this.ports.runSemantics(graph.changed); semanticsWritten = result.written ?? 0; semanticsDeduped = result.deduped ?? 0; semanticsDroppedUnresolved = result.droppedUnresolved ?? 0; semanticsSkipped = result.skipped; } catch (cause) { throw new MemoryConsolidationError("semantics", cause instanceof Error ? cause.message : String(cause), { cause }); } }
      for (const [id, ids] of byRecord) { try { const result = await this.ports.mergeRecallGraphNodeIds(id, [...ids].sort()); if(result.status === "updated") updated++; else if(result.status === "unchanged") unchanged++; else missing++; } catch (cause) { throw new MemoryConsolidationError("cross-reference", cause instanceof Error ? cause.message : String(cause), { cause }); } }
      return { graphChanged:graph.changed, graphRecoveryReason:graph.recoveryReason, parsedFiles:graph.stats.parsedFiles, reusedFiles:graph.stats.reusedFiles, prunedFiles:graph.stats.prunedFiles, nodeCount:graph.nodeCount, edgeCount:graph.edgeCount, recallCandidates:created+duplicate, recallCreated:created, recallDuplicate:duplicate, crossRefUpdated:updated, crossRefUnchanged:unchanged, crossRefMissing:missing, semanticsWritten, semanticsDeduped, semanticsDroppedUnresolved, ...(semanticsSkipped ? { semanticsSkipped } : {}), durationMs:(this.ports.clock ?? Date.now)()-started, changed:graph.changed || created>0 || updated>0 || semanticsWritten>0 };
    } finally { active.delete(key); }
  }
}
