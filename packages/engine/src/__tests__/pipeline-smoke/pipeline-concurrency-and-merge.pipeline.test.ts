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
    return selected.workflows
      .filter((workflowId) => workflowId !== "renamed-clone")
      .flatMap((workflowId) => (selected.variants ?? [undefined]).map((variant) => ({ scenario: selected, workflowId, variant })));
  });
}

/*
FNXC:PipelineSmoke 2026-08-23-17:11:
Concurrency and merger scenarios run production ProjectEngine admission and local disposable Git.
The drivers hold real merge bodies and session registry entries; no scenario calls runAiMerge directly.
*/
describeIfReady("pipeline smoke: concurrency and merge scenarios", () => {
  const pg: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pipeline_smoke_merge",
    projectId: "pipeline-smoke-merge",
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

  it.each(executableVariants(["S09", "S10", "S11", "S12", "S13", "S14", "S15", "S16"]))(
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
