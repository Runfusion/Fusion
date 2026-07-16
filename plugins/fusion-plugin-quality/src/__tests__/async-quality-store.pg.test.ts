/*
FNXC:QualityPostgresDurability 2026-07-16-10:30:
This behavioral test applies the plugin's declarative PostgreSQL schema itself:
core's harness supplies only baseline tables. It proves Quality CRUD uses the
project-bound AsyncDataLayer rather than the SQLite route that failed Task QA.
*/
import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { AsyncDataLayer } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe } from "../../../../packages/core/src/__test-utils__/pg-test-harness.js";
import { qualityPostgresSchema } from "../quality-schema.js";
import { AsyncQualityStore } from "../store/async-quality-store.js";

function projectLayer(layer: AsyncDataLayer, projectId: string): AsyncDataLayer { return { ...layer, projectId }; }

pgDescribe("AsyncQualityStore (PostgreSQL / backend mode)", () => {
  it("persists Quality lifecycle data and isolates projects", async () => {
    const h = await createTaskStoreForTest({ prefix: "fusion_quality_async" });
    try {
      for (const statement of qualityPostgresSchema.statements) await h.adminDb.execute(sql.raw(statement));
      const projectA = new AsyncQualityStore(projectLayer(h.layer, "quality-a"));
      const projectB = new AsyncQualityStore(projectLayer(h.layer, "quality-b"));
      const created = await projectA.createRun({ projectId: "quality-a", source: "hub", command: "pnpm verify:fast", cwd: "/repo", cwdKind: "project-root", timeoutMs: 1_000, triggeredBy: "test" });
      const updated = await projectA.updateRun("quality-a", created.id, { status: "passed", exitCode: 0, finishedAt: new Date().toISOString(), durationMs: 1 });
      expect(updated).toMatchObject({ id: created.id, status: "passed", exitCode: 0 });
      expect(await projectA.listRuns("quality-a")).toHaveLength(1);
      expect(await projectB.getRun("quality-b", created.id)).toBeNull();

      const createdPlan = await projectA.createPlan({ projectId: "quality-a", name: "Fast gate", steps: ["verify-fast"] });
      expect((await projectA.getPlan("quality-a", createdPlan.id))?.steps).toEqual(["verify-fast"]);
      await projectA.saveSuggestedCases({ projectId: "quality-a", taskId: "FN-8103", cases: [{ id: "case", text: "uses async data layer", done: false, source: "heuristic" }], generatedAt: new Date().toISOString(), method: "heuristic" });
      expect((await projectA.getSuggestedCases("quality-a", "FN-8103"))?.cases).toHaveLength(1);
      expect(await projectB.getSuggestedCases("quality-b", "FN-8103")).toBeNull();
    } finally { await h.teardown(); }
  });
});
