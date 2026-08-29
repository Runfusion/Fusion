import { expect, it } from "vitest";
import { appendPlanEvidenceInTransaction, PlanEvidenceAppendError } from "../task-store/plan-evidence.js";
import { createCurrentPlanEvidence, type CurrentPlanEvidence } from "../planner/spec-lock.js";

const prompt = "# Task\n\n## Mission\n\nEvidence\n\n## Steps\n\n1. Keep it\n";
const evidence = (version: number) => createCurrentPlanEvidence({ version, sourceRevision: 1, capturedAt: "2026-08-11T02:04:00.000Z", prompt });

function fakeTx(latestVersions: number[], conflicts: Array<"insert" | "dedupe"> = [], matching?: CurrentPlanEvidence) {
  const inserted: CurrentPlanEvidence[] = [];
  let selectCount = 0;
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [{ version: latestVersions[Math.min(selectCount++, latestVersions.length - 1)] }] }), limit: async () => matching ? [{ version: matching.version, snapshot: matching }] : [] }) }) }),
    insert: () => ({ values: (row: { snapshot: CurrentPlanEvidence }) => ({ onConflictDoNothing: () => ({ returning: async () => {
      const outcome = conflicts.shift();
      if (outcome === "insert" || outcome === "dedupe") return [];
      inserted.push(row.snapshot);
      return [{ version: row.snapshot.version }];
    } }) }) }),
  };
  return { tx, inserted };
}

it("derives the next evidence version from the durable column", async () => {
  const { tx, inserted } = fakeTx([5]);
  const result = await appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: evidence });
  expect(result.version).toBe(6);
  expect(inserted[0]?.version).toBe(6);
});

it("retries a primary-key conflict with a freshly-read version", async () => {
  const { tx, inserted } = fakeTx([5, 6], ["insert"]);
  const result = await appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: evidence });
  expect(result).toMatchObject({ version: 7, attempts: 2, deduped: false });
  expect(inserted[0]?.version).toBe(7);
});

it("returns the stored snapshot for a source-hash dedupe conflict", async () => {
  const stored = evidence(5);
  const { tx, inserted } = fakeTx([5], ["dedupe"], stored);
  const result = await appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: () => stored });
  expect(result).toMatchObject({ evidence: stored, version: 5, deduped: true });
  expect(inserted).toEqual([]);
});

it("throws a named error after conflicts cannot produce a durable row", async () => {
  const { tx } = fakeTx([5, 6, 7], ["insert", "insert", "insert"]);
  await expect(appendPlanEvidenceInTransaction(tx as never, { taskId: "KB-1", buildEvidence: evidence }))
    .rejects.toEqual(expect.objectContaining({ name: "PlanEvidenceAppendError", taskId: "KB-1", attempts: 3 } satisfies Partial<PlanEvidenceAppendError>));
});
