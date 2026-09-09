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
import { PIPELINE_SCENARIOS, type PipelineScenario, type PipelineWorkflowId } from "./_pipeline-scenarios.js";

const describeIfReady = hasGit ? pgDescribe : describe.skip;

function scenario(id: string): PipelineScenario {
  const selected = PIPELINE_SCENARIOS.find((candidate) => candidate.id === id);
  if (!selected) throw new Error(`Missing declared pipeline scenario ${id}.`);
  return selected;
}

function executableVariants(ids: readonly string[]): Array<{ scenario: PipelineScenario; workflowId: PipelineWorkflowId; variant?: string }> {
  return ids.flatMap((id) => {
    const selected = scenario(id);
    const workflows = selected.id === "S19"
      ? (["builtin:coding-ideas-v2", "builtin:coding"] as const)
      : selected.workflows.filter((workflowId) => workflowId !== "renamed-clone");
    return workflows.flatMap((workflowId) => (selected.variants ?? [undefined]).map((variant) => ({ scenario: selected, workflowId, variant })));
  });
}

/*
FNXC:PipelineSmoke 2026-08-23-17:12:
Restart, provider-restoration, and renamed-vocabulary scenarios reuse the executable drivers.
Each run re-reads persisted state after recovery rather than asserting a restart helper invocation.
*/
describeIfReady("pipeline smoke: resilience scenarios", () => {
  const pg: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pipeline_smoke_resilience",
    projectId: "pipeline-smoke-resilience",
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

  it.each(executableVariants(["S17", "S18", "S19", "S20", "S21"]))(
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
