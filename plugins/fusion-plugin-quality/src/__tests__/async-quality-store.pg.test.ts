/*
FNXC:QualityPostgresDurability 2026-07-20-02:10:
FN-8394 replaces the embedded-PostgreSQL quarantine with a query-aware bounded
AsyncDataLayer fake. The fake rejects missing project predicates and only applies
lifecycle state changes for the SQL contracts the production store must issue,
so process pressure cannot hide a lost isolation or terminal-status guarantee.
*/
import { expect, it } from "vitest";
import type { AsyncDataLayer } from "@fusion/core";
import { AsyncQualityStore } from "../store/async-quality-store.js";

const createdRun = {
  id: "qrun_1",
  project_id: "quality-a",
  task_id: null,
  plan_id: null,
  source: "hub",
  preset_id: null,
  command: "pnpm verify:fast",
  cwd: "/repo",
  cwd_kind: "project-root",
  status: "queued",
  exit_code: null,
  error_message: null,
  timeout_ms: 1_000,
  started_at: null,
  finished_at: null,
  duration_ms: null,
  stdout: "",
  stderr: "",
  triggered_by: "test",
  created_at: "2026-07-19T00:00:00.000Z",
  updated_at: "2026-07-19T00:00:00.000Z",
};

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown } | null)?.value;
      return Array.isArray(value) ? value.join("") : String(value ?? "");
    })
    .join(" ")
    .replace(/\s+/g, " ");
}

/** A bounded data-layer seam that enforces SQL predicates instead of canned call order. */
function makeLayer(): { layer: AsyncDataLayer; statements: string[] } {
  const statements: string[] = [];
  let run = { ...createdRun };
  const plan = {
    id: "qplan_1", project_id: "quality-a", name: "Fast gate", status: "active",
    steps_json: '["verify-fast"]', created_at: "2026-07-19T00:00:00.000Z", updated_at: "2026-07-19T00:00:00.000Z",
  };
  const cases = {
    project_id: "quality-a", task_id: "FN-8103",
    cases_json: '[{"id":"case","text":"uses async data layer","done":false,"source":"heuristic"}]',
    generated_at: "2026-07-19T00:00:00.000Z", method: "heuristic",
  };
  const db = {
    execute: async (query: unknown) => {
      const statement = sqlText(query);
      statements.push(statement);
      const isProjectTable = statement.includes("project.quality_");
      if (isProjectTable && statement.includes("SELECT") && !statement.includes("project_id")) {
        throw new Error(`quality query omitted project predicate: ${statement}`);
      }
      if (statement.includes("INSERT INTO project.quality_test_runs")) return [];
      if (statement.includes("UPDATE project.quality_test_runs")) {
        /*
        FNXC:QualityPostgresDurability 2026-07-20-19:05:
        FN-8394's in-memory lifecycle seam must reject an unscoped UPDATE, not
        merely observe a project predicate on a later SELECT. State may change
        only after the production write proves both isolation and sticky-terminal
        status semantics.
        */
        if (!statement.includes("WHERE project_id =")) {
          throw new Error("quality run update omitted project predicate");
        }
        if (!statement.includes("WHEN status IN ('cancelled', 'passed', 'failed', 'timed_out', 'error')")) {
          throw new Error("quality run update omitted sticky terminal-status contract");
        }
        run = { ...run, status: "passed", exit_code: 0, finished_at: "2026-07-19T00:00:01.000Z", duration_ms: 1 };
        return [];
      }
      if (statement.includes("FROM project.quality_test_runs")) return [run];
      if (statement.includes("INSERT INTO project.quality_test_plans")) return [];
      if (statement.includes("FROM project.quality_test_plans")) return [plan];
      if (statement.includes("INSERT INTO project.quality_suggested_cases")) return [];
      if (statement.includes("FROM project.quality_suggested_cases")) return [cases];
      throw new Error(`unexpected quality query: ${statement}`);
    },
  };
  return {
    statements,
    layer: {
      projectId: "quality-a",
      db: db as AsyncDataLayer["db"],
      transactionImmediate: async (fn) => fn(db as never),
    } as AsyncDataLayer,
  };
}

it("persists a project-scoped async Quality lifecycle through SQL predicate contracts", async () => {
  const { layer, statements } = makeLayer();
  const store = new AsyncQualityStore(layer);

  const created = await store.createRun({ projectId: "quality-a", source: "hub", command: "pnpm verify:fast", cwd: "/repo", cwdKind: "project-root", timeoutMs: 1_000, triggeredBy: "test" });
  const updated = await store.updateRun("quality-a", created.id, { status: "passed", exitCode: 0, finishedAt: "2026-07-19T00:00:01.000Z", durationMs: 1 });
  expect(updated).toMatchObject({ id: created.id, status: "passed", exitCode: 0 });
  expect(await store.listRuns("quality-a")).toEqual([expect.objectContaining({ id: created.id, status: "passed" })]);

  await expect(store.getRun("quality-b", created.id)).rejects.toMatchObject({ message: /project mismatch/, statusCode: 403 });

  const createdPlan = await store.createPlan({ projectId: "quality-a", name: "Fast gate", steps: ["verify-fast"] });
  expect(createdPlan.steps).toEqual(["verify-fast"]);
  await store.saveSuggestedCases({ projectId: "quality-a", taskId: "FN-8103", cases: [{ id: "case", text: "uses async data layer", done: false, source: "heuristic" }], generatedAt: "2026-07-19T00:00:00.000Z", method: "heuristic" });
  expect(await store.getSuggestedCases("quality-a", "FN-8103")).toMatchObject({ cases: [expect.objectContaining({ id: "case" })] });

  expect(statements).toEqual(expect.arrayContaining([
    expect.stringContaining("INSERT INTO project.quality_test_runs"),
    expect.stringMatching(/UPDATE project\.quality_test_runs SET status = CASE.*WHERE project_id =/),
    expect.stringContaining("INSERT INTO project.quality_test_plans"),
    expect.stringContaining("INSERT INTO project.quality_suggested_cases"),
  ]));
});
