import { describe, expect, it, vi } from "vitest";
import type { AgentLogEntry, TaskDetail, TaskStore } from "@fusion/core";
import {
  EVIDENCE_EXCERPT_TRUNCATION_MARKER,
  EVIDENCE_LIMITS,
  MAX_EVIDENCE_EXCERPT_LENGTH,
} from "@fusion/core";
import { collectTaskEvaluationEvidence } from "../eval/evaluator-evidence.js";

const TASK_ID = "FN-253";

function makeTask(): TaskDetail {
  return {
    id: TASK_ID,
    title: "Tool detail visibility",
    description: "Verify bounded evaluation evidence.",
    updatedAt: "2026-08-29T00:00:00.000Z",
    log: [],
    workflowStepResults: [],
  } as TaskDetail;
}

function makeStore(entries: AgentLogEntry[]): TaskStore {
  return {
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getAgentLogs: vi.fn().mockResolvedValue(entries),
    getRunAuditEventsAsync: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;
}

function entry(index: number, detail: string): AgentLogEntry {
  return {
    taskId: TASK_ID,
    timestamp: new Date(Date.UTC(2026, 7, 29, 0, 0, index)).toISOString(),
    type: "tool_result",
    text: "fn_run_verification",
    detail,
    agent: "executor",
  };
}

describe("evaluator agent-log detail evidence", () => {
  it("bounds oversized tool detail after preserving the tool name at the excerpt head", async () => {
    const evidence = await collectTaskEvaluationEvidence({
      store: makeStore([entry(0, "x".repeat(4_096))]),
      task: makeTask(),
      runId: "run-253",
      cwd: process.cwd(),
    });
    const [log] = evidence.agentLogs;

    expect(log?.excerpt?.length).toBeLessThanOrEqual(MAX_EVIDENCE_EXCERPT_LENGTH);
    expect(log?.excerpt?.startsWith("fn_run_verification — ")).toBe(true);
    expect(log?.excerpt).toContain(EVIDENCE_EXCERPT_TRUNCATION_MARKER);
    expect(log?.truncated).toBe(true);
  });

  it("keeps the fixed agent-log evidence row cap when detail is populated", async () => {
    const evidence = await collectTaskEvaluationEvidence({
      store: makeStore(Array.from({ length: EVIDENCE_LIMITS.agentLogs + 5 }, (_, index) => entry(index, `result-${index}`))),
      task: makeTask(),
      runId: "run-253",
      cwd: process.cwd(),
    });

    expect(evidence.agentLogs).toHaveLength(EVIDENCE_LIMITS.agentLogs);
    expect(evidence.agentLogs[0]?.excerpt).toContain("result-5");
    expect(evidence.agentLogs.at(-1)?.excerpt).toContain(`result-${EVIDENCE_LIMITS.agentLogs + 4}`);
  });
});
