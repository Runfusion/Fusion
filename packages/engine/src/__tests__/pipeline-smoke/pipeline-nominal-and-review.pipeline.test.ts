import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { executePipelineScenario } from "./_pipeline-drivers.js";
import { hasGit } from "./_pipeline-git-fixture.js";
import { PipelineSmokeHarness } from "./_pipeline-harness.js";
import { recordPipelineScenario } from "./_pipeline-report.js";
import { assertPipelineScenarioTable, PIPELINE_SCENARIOS, type PipelineScenario, type PipelineWorkflowId } from "./_pipeline-scenarios.js";

const describeIfReady = hasGit ? pgDescribe : describe.skip;

// Structural validation stays outside the PostgreSQL lifecycle so it cannot start a runtime.
describe("pipeline smoke scenario contract", () => {
  it("keeps the executable scenario manifest closed at twenty-one entries", () => {
    assertPipelineScenarioTable();
  });
});

function scenario(id: string): PipelineScenario {
  const selected = PIPELINE_SCENARIOS.find((candidate) => candidate.id === id);
  if (!selected) throw new Error(`Missing declared pipeline scenario ${id}.`);
  return selected;
}

function executableVariants(ids: readonly string[]): Array<{ scenario: PipelineScenario; workflowId: PipelineWorkflowId; variant?: string }> {
  return ids.flatMap((id) => {
    const selected = scenario(id);
    return selected.workflows
      .filter((workflowId) => workflowId !== "renamed-clone")
      .flatMap((workflowId) => (selected.variants ?? [undefined]).map((variant) => ({ scenario: selected, workflowId, variant })));
  });
}

/*
FNXC:PipelineSmoke 2026-08-23-17:10:
The nominal lane executes the declared scenario drivers against fresh persisted PostgreSQL rows.
It follows the live E2E assertion rule: a driver reports observed task/work-item/audit/Git state,
never a spy or a scenario-table value copied into an expectation.
*/
describeIfReady("pipeline smoke: nominal and review scenarios", () => {
  const pg: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pipeline_smoke_nominal",
    projectId: "pipeline-smoke-nominal",
  });
  let harness: PipelineSmokeHarness;

  beforeAll(pg.beforeAll);
  beforeEach(async () => {
    await pg.beforeEach();
    harness = await PipelineSmokeHarness.create(pg);
  });
  afterEach(async () => {
    await harness.dispose();
    await pg.afterEach();
  });
  afterAll(pg.afterAll);

  it.each(executableVariants(["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08"]))(
    "$scenario.id runs $workflowId $variant",
    async ({ scenario: selected, workflowId, variant }) => {
      const context = { harness, workflowId, variant };
      await recordPipelineScenario({
        scenarioId: selected.id,
        workflowId,
        variant,
        expectedTerminal: selected.expectedTerminal,
      }, async () => {
        await executePipelineScenario(selected, context);
        const observed = context.result;
        if (!observed) throw new Error(`${selected.id} did not publish an observed terminal state.`);
        return { observedTerminal: observed.observedTerminal, wedge: observed.wedge };
      });
    },
  );
});
