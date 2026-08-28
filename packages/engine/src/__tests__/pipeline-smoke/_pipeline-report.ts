import { appendFileSync } from "node:fs";

import type { PipelineTerminalState } from "./_pipeline-terminal-state.js";

export type PipelineScenarioReportRecord = {
  readonly scenarioId: `S${number}`;
  readonly variant?: string;
  readonly workflowId: string;
  readonly expectedTerminal: PipelineTerminalState;
  readonly observedTerminal: PipelineTerminalState;
  readonly verdict: "pass" | "fail";
  readonly durationMs: number;
  readonly wedge?: string;
};

/*
FNXC:PipelineSmoke 2026-08-23-14:56:
FN-182's runner must count declared scenarios rather than Vitest assertions because harness
self-tests are intentionally in the same opt-in project. JSON-lines records keep the runner
independent of Vitest reporter internals and make every scenario/workflow variant inspectable.
*/
export function writePipelineScenarioReport(record: PipelineScenarioReportRecord): void {
  const path = process.env.FUSION_PIPELINE_SMOKE_REPORT;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function recordPipelineScenario(
  input: Omit<PipelineScenarioReportRecord, "observedTerminal" | "verdict" | "durationMs" | "wedge">,
  run: () => Promise<{ observedTerminal: PipelineTerminalState; wedge?: string }>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await run();
    const record: PipelineScenarioReportRecord = {
      ...input,
      observedTerminal: result.observedTerminal,
      verdict: result.observedTerminal === input.expectedTerminal && !result.wedge ? "pass" : "fail",
      durationMs: Date.now() - startedAt,
      ...(result.wedge ? { wedge: result.wedge } : {}),
    };
    writePipelineScenarioReport(record);
    if (record.verdict !== "pass") {
      throw new Error(`${record.scenarioId} observed ${record.observedTerminal}; expected ${record.expectedTerminal}.`);
    }
  } catch (error) {
    writePipelineScenarioReport({
      ...input,
      observedTerminal: "wedge",
      verdict: "fail",
      durationMs: Date.now() - startedAt,
      wedge: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
