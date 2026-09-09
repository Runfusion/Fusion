/*
FNXC:TaskRecommendations 2026-08-13-22:39:
Recommendation replay must use the indexed project-scoped claim lookup rather than a board scan.
These PostgreSQL assertions cover the actual Drizzle predicate, including forensic tombstones and
project isolation that a route mock cannot prove.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import { TaskStore } from "../../store.js";
import { insertTaskRow, softDeleteTaskRow } from "../../task-store/async/async-persistence.js";

pgDescribe("findTaskByProposalClaimId PostgreSQL persistence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_proposal_claim_lookup",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function createClaimedTask(
    id: string,
    claim: string,
    overrides: Record<string, unknown> = {},
  ) {
    return h.store().createTaskWithReservedId({
      id,
      description: `Claim holder ${id}`,
      column: "todo",
      proposalClaimId: claim,
      sourceMetadata: { fileScope: ["packages/core/src/store.ts"] },
      ...overrides,
    } as never, {
      taskId: id,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      applyDefaultWorkflowSteps: false,
    });
  }

  it("returns persisted live rows and rejects blank or unknown claims", async () => {
    const store = h.store();
    await createClaimedTask("FN-CLAIM", "recommendation:parent:one");
    await h.layer().db.update(schema.project.tasks).set({
      sourceMetadata: { fileScope: ["packages/core/src/store.ts"] },
    }).where(eq(schema.project.tasks.id, "FN-CLAIM"));
    await expect(store.findTaskByProposalClaimId("recommendation:parent:one")).resolves.toMatchObject({
      id: "FN-CLAIM",
      column: "todo",
      sourceMetadata: { fileScope: ["packages/core/src/store.ts"] },
    });
    await expect(store.findTaskByProposalClaimId("missing")).resolves.toBeNull();
    await expect(store.findTaskByProposalClaimId("   ")).resolves.toBeNull();
  });

  it("hides soft-deleted claim holders by default and returns them only for forensic replay", async () => {
    const store = h.store();
    await createClaimedTask("FN-DELETED", "recommendation:parent:deleted");
    await softDeleteTaskRow(h.layer(), "FN-DELETED", "2026-08-14T01:00:00.000Z");

    await expect(store.findTaskByProposalClaimId("recommendation:parent:deleted")).resolves.toBeNull();
    await expect(store.findTaskByProposalClaimId("recommendation:parent:deleted", { includeDeleted: true }))
      .resolves.toMatchObject({ id: "FN-DELETED", deletedAt: "2026-08-14T01:00:00.000Z" });
  });

  it("is project-scoped and never consults cold soft-delete snapshots", async () => {
    const layerFor = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
    const storeA = new TaskStore(h.rootDir(), undefined, { asyncLayer: layerFor("project-a") });
    const storeB = new TaskStore(h.rootDir(), undefined, { asyncLayer: layerFor("project-b") });
    const claim = "recommendation:shared:claim";
    const row = (id: string) => ({
      id,
      description: id,
      column: "todo",
      currentStep: 0,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      proposalClaimId: claim,
    });

    await insertTaskRow(layerFor("project-a"), row("FN-PROJECT-A"), { lineageId: "lineage-a" });
    await expect(storeB.findTaskByProposalClaimId(claim)).resolves.toBeNull();
    await expect(storeA.findTaskByProposalClaimId(claim)).resolves.toMatchObject({ id: "FN-PROJECT-A" });

    const deleted = await createClaimedTask("FN-COLD", "recommendation:cold:snapshot");
    await h.store().deleteTask(deleted.id);
    // A cold-only soft-delete snapshot has no live row for the indexed reader to match.
    await h.adminDb().delete(schema.project.tasks).where(eq(schema.project.tasks.id, deleted.id));
    await expect(h.store().findTaskByProposalClaimId("recommendation:cold:snapshot", { includeDeleted: true }))
      .resolves.toBeNull();
  });
});
