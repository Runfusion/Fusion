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
import { PIPELINE_SCENARIOS, type PipelineScenario } from "./_pipeline-scenarios.js";

const describeIfReady = hasGit ? pgDescribe : describe.skip;

function restartScenario(): PipelineScenario {
  const selected = PIPELINE_SCENARIOS.find((candidate) => candidate.id === "S17");
  if (!selected) throw new Error("Missing declared S17 pipeline scenario.");
  return selected;
}

/*
FNXC:PipelineSmoke 2026-10-04-09:22:
S17's Coding Ideas v2 restart cases are fixture-isolated from the other workflow partitions.
The production paths still run serially inside this one disposable Git/PostgreSQL fixture, while
Vitest's existing three-worker project envelope schedules independent workflow partitions together.
*/
describeIfReady("pipeline smoke: Coding Ideas v2 restart scenarios", () => {
  const pg: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pipeline_smoke_restart_ideas_v2",
    projectId: "pipeline-smoke-restart-ideas-v2",
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

  it("S17 runs every Coding Ideas v2 restart stage through one fixture lifecycle", async () => {
    const selected = restartScenario();
    const workflowId = "builtin:coding-ideas-v2" as const;
    for (const variant of selected.variants ?? []) {
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
    }
  });
});
