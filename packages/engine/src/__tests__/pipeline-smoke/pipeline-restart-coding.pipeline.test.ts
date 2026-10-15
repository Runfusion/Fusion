import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
S17's Coding restart cases are fixture-isolated from the other workflow partitions. The production
paths still run serially inside this one disposable Git/PostgreSQL fixture, while Vitest's existing
three-worker project envelope schedules independent workflow partitions together.
*/
describeIfReady("pipeline smoke: Coding restart scenarios", () => {
  const pg: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pipeline_smoke_restart_coding",
    projectId: "pipeline-smoke-restart-coding",
  });
  let harness: PipelineSmokeHarness;
  let reportDir: string | undefined;
  let reportPath: string;
  let priorScenarioReport: string | undefined;
  let ownsScenarioReport = false;

  /*
  FNXC:PipelineSmoke 2026-10-15-00:58:
  FN-9551 needs this focused fixture to inspect its terminal post-merge record without replacing
  the runner-owned report path. A standalone run gets an isolated report, while the full smoke
  keeps its shared producer file so the manifest census retains all five Coding S17 variants.
  */
  beforeAll(pg.beforeAll);
  beforeEach(async () => {
    await pg.beforeEach();
    priorScenarioReport = process.env.FUSION_PIPELINE_SMOKE_REPORT;
    if (priorScenarioReport) {
      reportPath = priorScenarioReport;
      ownsScenarioReport = false;
    } else {
      reportDir = mkdtempSync(join(tmpdir(), "fusion-pipeline-coding-s17-"));
      reportPath = join(reportDir, "scenarios.jsonl");
      process.env.FUSION_PIPELINE_SMOKE_REPORT = reportPath;
      ownsScenarioReport = true;
    }
    harness = await PipelineSmokeHarness.create(pg);
  });
  afterEach(async () => {
    try {
      await harness.dispose();
      await pg.afterEach();
    } finally {
      if (ownsScenarioReport) {
        if (priorScenarioReport === undefined) delete process.env.FUSION_PIPELINE_SMOKE_REPORT;
        else process.env.FUSION_PIPELINE_SMOKE_REPORT = priorScenarioReport;
        rmSync(reportDir, { recursive: true, force: true });
      }
    }
  });
  afterAll(pg.afterAll);

  it("S17 runs every Coding restart stage through one fixture lifecycle", async () => {
    const selected = restartScenario();
    const workflowId = "builtin:coding" as const;
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
    const events = readFileSync(reportPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const completedPostMerge = events.filter((event) => event.event !== "started" && event.scenarioId === "S17" && event.workflowId === workflowId && event.variant === "post-merge");
    expect(completedPostMerge).toEqual([expect.objectContaining({ expectedTerminal: "merged-done", observedTerminal: "merged-done", verdict: "pass" })]);
  });
});
