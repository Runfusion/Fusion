import { and, desc, eq } from "drizzle-orm";
import { projectScopeFor, type AsyncDataLayer, type DbTransaction } from "../postgres/data-layer.js";
import * as schema from "../postgres/schema/index.js";
import type { CurrentPlanEvidence } from "../planner/spec-lock.js";

export class PlanEvidenceAppendError extends Error {
  constructor(readonly taskId: string, readonly attempts: number) {
    super(`Plan evidence append exhausted for ${taskId} after ${attempts} attempts`);
    this.name = "PlanEvidenceAppendError";
  }
}

export type AppendPlanEvidenceOptions = {
  projectId?: string;
  taskId: string;
  buildEvidence: (version: number, attempt: number) => CurrentPlanEvidence;
  maxAttempts?: number;
  /** Validates a source-hash dedupe row before it is treated as durable success. */
  validateMatchedEvidence?: (evidence: CurrentPlanEvidence, version: number, attempt: number) => void;
};

export type AppendPlanEvidenceResult = {
  evidence: CurrentPlanEvidence;
  version: number;
  deduped: boolean;
  attempts: number;
};

/**
 * FNXC:SpecLock 2026-08-11-02:04:
 * FN-8969/FN-8964 require every plan-evidence writer to derive versions from the durable column,
 * not snapshot JSON: a stale embedded version otherwise wedges future operator PROMPT.md writes.
 * PK races retry while sourceHash conflicts return their existing immutable evidence, preserving
 * append-only history without allowing a conflict to hard-fail a visible plan write.
 */
export async function appendPlanEvidenceInTransaction(
  tx: DbTransaction | AsyncDataLayer["db"],
  options: AppendPlanEvidenceOptions,
): Promise<AppendPlanEvidenceResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const latest = await tx.select({ version: schema.project.currentPlanEvidence.version })
      .from(schema.project.currentPlanEvidence)
      .where(and(
        projectScopeFor(schema.project.currentPlanEvidence.projectId, options.projectId),
        eq(schema.project.currentPlanEvidence.taskId, options.taskId),
      ))
      .orderBy(desc(schema.project.currentPlanEvidence.version))
      .limit(1);
    const evidence = options.buildEvidence((latest[0]?.version ?? 0) + 1, attempt);
    const inserted = await tx.insert(schema.project.currentPlanEvidence).values({
      projectId: options.projectId ?? "",
      taskId: options.taskId,
      version: evidence.version,
      sourceRevision: evidence.sourceRevision,
      sourceHash: evidence.sourceHash,
      capturedAt: evidence.capturedAt,
      snapshot: evidence,
    }).onConflictDoNothing().returning({ version: schema.project.currentPlanEvidence.version });
    if (inserted[0]) return { evidence, version: inserted[0].version, deduped: false, attempts: attempt + 1 };

    const matching = await tx.select({ version: schema.project.currentPlanEvidence.version, snapshot: schema.project.currentPlanEvidence.snapshot })
      .from(schema.project.currentPlanEvidence)
      .where(and(
        projectScopeFor(schema.project.currentPlanEvidence.projectId, options.projectId),
        eq(schema.project.currentPlanEvidence.taskId, options.taskId),
        eq(schema.project.currentPlanEvidence.sourceHash, evidence.sourceHash),
      ))
      .limit(1);
    if (matching[0]) {
      const stored = matching[0].snapshot as CurrentPlanEvidence;
      options.validateMatchedEvidence?.(stored, matching[0].version, attempt);
      return { evidence: stored, version: matching[0].version, deduped: true, attempts: attempt + 1 };
    }
  }
  throw new PlanEvidenceAppendError(options.taskId, maxAttempts);
}
