import { describe, expect, it } from "vitest";
import { CODE_REVIEW_GROUP_ID } from "@fusion/core";
import type { AgentHeartbeatRun, ReviewerRunRow, Task, WorkflowStepResult } from "@fusion/core";
import {
  classifyReviewCard,
  DEFAULT_REVIEW_GRACE_MS,
  DEFAULT_REVIEW_MAX_ATTEMPTS,
  DEFAULT_REVIEW_START_LATENCY_MS,
  DEFAULT_REVIEW_TICK_MS,
} from "../scheduling/review-dispatch-sweep.js";

const TASK_ID = "FN-SWEEP";
const REVIEWER_ID = "agent-reviewer";

/** A card already parked in the review lane; the sweep's clock is passed in, never read. */
const ENTERED_AT = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-01-02T00:00:00.000Z");

function reviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Sweep fixture",
    column: "in-review",
    updatedAt: ENTERED_AT,
    ...overrides,
  } as unknown as Task;
}

function attempt(overrides: Partial<ReviewerRunRow> = {}): ReviewerRunRow {
  return {
    id: "revrun_fixture",
    taskId: TASK_ID,
    reviewerAgentId: REVIEWER_ID,
    status: "running",
    reworkRound: 1,
    startedAt: ENTERED_AT,
    completedAt: null,
    ...overrides,
  };
}

function finished(status: "approve" | "revise" | "skipped" | "failed"): ReviewerRunRow {
  return attempt({ status, completedAt: ENTERED_AT });
}

function heartbeatRun(taskId: string): AgentHeartbeatRun {
  return {
    agentId: REVIEWER_ID,
    taskId,
    status: "active",
    startedAt: ENTERED_AT,
  } as unknown as AgentHeartbeatRun;
}

function reviewResult(status: WorkflowStepResult["status"], supersededAt: string | null = null): WorkflowStepResult {
  return {
    workflowStepId: CODE_REVIEW_GROUP_ID,
    workflowStepName: "Code Review",
    status,
    supersededAt,
  };
}

function decide(rows: ReviewerRunRow[], overrides: Partial<Task> = {}, activeRun: AgentHeartbeatRun | null = null) {
  return classifyReviewCard({
    task: reviewTask(overrides),
    reviewerFound: true,
    rows,
    activeRun,
    now: NOW,
    graceMs: DEFAULT_REVIEW_GRACE_MS,
    startLatencyMs: DEFAULT_REVIEW_START_LATENCY_MS,
    maxAttempts: DEFAULT_REVIEW_MAX_ATTEMPTS,
  });
}

describe("review-lane dispatch sweep classification", () => {
  it("dispatches a card nobody ever asked a reviewer about", () => {
    const decision = decide([]);
    expect(decision.bucket).toBe("never-dispatched");
    expect(decision.dispatch).toBe(true);
    expect(decision.supersedeFirst).toBe(false);
  });

  it("waits out the handoff grace window before calling an empty ledger a stall", () => {
    const decision = classifyReviewCard({
      task: reviewTask({ updatedAt: new Date(NOW - 1_000).toISOString() }),
      reviewerFound: true,
      rows: [],
      activeRun: null,
      now: NOW,
      graceMs: DEFAULT_REVIEW_GRACE_MS,
      startLatencyMs: DEFAULT_REVIEW_START_LATENCY_MS,
      maxAttempts: DEFAULT_REVIEW_MAX_ATTEMPTS,
    });
    expect(decision.bucket).toBe("awaiting-handoff");
    expect(decision.dispatch).toBe(false);
  });

  it("leaves a corroborated live review alone however old its ledger row looks", () => {
    const decision = decide([attempt({ startedAt: "2025-01-01T00:00:00.000Z" })], {}, heartbeatRun(TASK_ID));
    expect(decision.bucket).toBe("review-in-flight");
    expect(decision.dispatch).toBe(false);
  });

  it("refuses to supersede when the reviewer is busy on a different card", () => {
    const decision = decide([attempt()], {}, heartbeatRun("FN-SOMEONE-ELSE"));
    expect(decision.bucket).toBe("reviewer-busy");
    expect(decision.dispatch).toBe(false);
  });

  it("supersedes a dispatched review whose session never started", () => {
    const startedLongAgo = new Date(NOW - DEFAULT_REVIEW_START_LATENCY_MS - 60_000).toISOString();
    const decision = decide([attempt({ startedAt: startedLongAgo })]);
    expect(decision.bucket).toBe("stalled-attempt");
    expect(decision.dispatch).toBe(true);
    expect(decision.supersedeFirst).toBe(true);
  });

  it("gives a just-dispatched attempt its start latency before blaming it", () => {
    const justStarted = new Date(NOW - 1_000).toISOString();
    const decision = decide([attempt({ startedAt: justStarted })]);
    expect(decision.bucket).toBe("awaiting-handoff");
    expect(decision.dispatch).toBe(false);
  });

  it("retries a failed attempt while the ledger-derived budget lasts", () => {
    const decision = decide([finished("failed")]);
    expect(decision.bucket).toBe("stalled-attempt");
    expect(decision.dispatch).toBe(true);
    expect(decision.nextRound).toBe(2);
  });

  it("parks instead of retrying once the attempt budget is spent, including the live zombie", () => {
    const startedLongAgo = new Date(NOW - DEFAULT_REVIEW_START_LATENCY_MS - 60_000).toISOString();
    const spent = [finished("failed"), finished("failed"), attempt({ startedAt: startedLongAgo })];
    const decision = decide(spent);
    expect(decision.bucket).toBe("parked");
    expect(decision.dispatch).toBe(false);
  });

  it("never re-reviews a card whose verdict is already recorded, even over a failed attempt", () => {
    const decision = decide([finished("failed")], { workflowStepResults: [reviewResult("passed")] });
    expect(decision.bucket).toBe("verdict-recorded");
    expect(decision.dispatch).toBe(false);
  });

  it("counts an approve row as a verdict rather than a fresh dispatch", () => {
    const decision = decide([finished("approve")]);
    expect(decision.bucket).toBe("verdict-recorded");
    expect(decision.dispatch).toBe(false);
  });

  it("treats a dispatched-but-never-answered review step as missing work, not a verdict", () => {
    const decision = decide([], { workflowStepResults: [reviewResult("pending")] });
    expect(decision.bucket).toBe("never-dispatched");
    expect(decision.dispatch).toBe(true);
  });

  it("ignores a verdict a newer commit already superseded", () => {
    const decision = decide([], {
      workflowStepResults: [reviewResult("passed", "2026-01-01T12:00:00.000Z")],
    });
    expect(decision.bucket).toBe("never-dispatched");
    expect(decision.dispatch).toBe(true);
  });

  it("honours a reviewer-recorded nothing-reviewable outcome", () => {
    const decision = decide([finished("skipped")]);
    expect(decision.bucket).toBe("nothing-reviewable");
    expect(decision.dispatch).toBe(false);
  });

  it("skips a card that opted out of code review", () => {
    expect(decide([], { reviewLevel: 0 }).bucket).toBe("excluded-review-level");
    expect(
      decide([], { enabledWorkflowSteps: ["plan-review"] }).bucket,
    ).toBe("excluded-review-level");
  });

  it("still reviews a card whose enabled step list was never set", () => {
    expect(decide([], { enabledWorkflowSteps: undefined }).dispatch).toBe(true);
    expect(decide([], { enabledWorkflowSteps: [CODE_REVIEW_GROUP_ID] }).dispatch).toBe(true);
  });

  it("reports a pause as a pause even when no reviewer exists", () => {
    const decision = classifyReviewCard({
      task: reviewTask({ paused: true }),
      reviewerFound: false,
      rows: [],
      activeRun: null,
      now: NOW,
      graceMs: DEFAULT_REVIEW_GRACE_MS,
      startLatencyMs: DEFAULT_REVIEW_START_LATENCY_MS,
      maxAttempts: DEFAULT_REVIEW_MAX_ATTEMPTS,
    });
    expect(decision.bucket).toBe("excluded-paused");
    expect(decision.dispatch).toBe(false);
  });

  it("names the no-reviewer exclusion without inventing a substitute", () => {
    const decision = classifyReviewCard({
      task: reviewTask(),
      reviewerFound: false,
      rows: [],
      activeRun: null,
      now: NOW,
      graceMs: DEFAULT_REVIEW_GRACE_MS,
      startLatencyMs: DEFAULT_REVIEW_START_LATENCY_MS,
      maxAttempts: DEFAULT_REVIEW_MAX_ATTEMPTS,
    });
    expect(decision.bucket).toBe("no-reviewer");
    expect(decision.dispatch).toBe(false);
  });
});

describe("review-lane dispatch sweep timing", () => {
  it("ticks far inside the live reviewer's multi-hour patrol so a dispatch cannot arrive after it", () => {
    const PATROL_INTERVAL_MS = 21_600_000;
    expect(DEFAULT_REVIEW_TICK_MS).toBeLessThan(PATROL_INTERVAL_MS);
    expect(DEFAULT_REVIEW_START_LATENCY_MS).toBeLessThan(PATROL_INTERVAL_MS);
  });

  it("calls a stall well before the 24h observation runner would", () => {
    const OBSERVATION_THRESHOLD_MS = 86_400_000;
    expect(DEFAULT_REVIEW_GRACE_MS).toBeLessThan(OBSERVATION_THRESHOLD_MS);
    expect(DEFAULT_REVIEW_START_LATENCY_MS).toBeLessThan(OBSERVATION_THRESHOLD_MS);
  });

  it("keeps the anti-loop budget small enough to surface a wedge rather than burn sessions", () => {
    expect(DEFAULT_REVIEW_MAX_ATTEMPTS).toBeLessThanOrEqual(3);
  });
});
