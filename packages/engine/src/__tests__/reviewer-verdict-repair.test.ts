import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor, WORKFLOW_STEP_VERDICT_REPAIR_TIMEOUT_MS } from "../executor.js";
import {
  WORKFLOW_STEP_VERDICT_REPAIR_PROMPT,
  workflowStepMissingVerdictNotice,
} from "../executor/workflow-step-verdict.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

function task() {
  const now = new Date().toISOString();
  return {
    id: "FN-288-VERDICT",
    title: "Repair missing verdict",
    description: "Require every reviewer to author a verdict.",
    column: "in-progress" as const,
    worktree: "/tmp/fn-288-verdict",
    branch: "fusion/fn-288-verdict",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

function reviewStep() {
  const now = new Date().toISOString();
  return {
    id: "graph:code-review-step",
    name: "Code Review",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "gate" as const,
    prompt: "Review the implementation.",
    toolMode: "readonly" as const,
    optionalGroupId: "code-review",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

type Reply = string | Error | "never";

function installSessions(repliesBySession: Reply[][]) {
  const prompts: Array<ReturnType<typeof vi.fn>> = [];
  mockedCreateFnAgent.mockImplementation(async () => {
    const replies = repliesBySession[prompts.length] ?? repliesBySession.at(-1) ?? [];
    const listeners: Array<(event: any) => void> = [];
    let promptIndex = 0;
    const prompt = vi.fn(async () => {
      const reply = replies[promptIndex++];
      if (reply === "never") return new Promise<void>(() => {});
      if (reply instanceof Error) throw reply;
      if (typeof reply === "string") {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: reply,
            },
          });
        }
      }
    });
    prompts.push(prompt);
    return {
      session: {
        state: {},
        subscribe: (listener: (event: any) => void) => {
          listeners.push(listener);
          return () => {};
        },
        prompt,
        dispose: vi.fn(),
      },
    } as any;
  });
  return prompts;
}

async function runStep(repliesBySession: Reply[][], options: { verdictRequired?: boolean; audit?: ReturnType<typeof vi.fn>; reviewKind?: "plan" | "code" } = {}) {
  const store = createMockStore();
  if (options.audit) (store as any).recordRunAuditEvent = options.audit;
  const prompts = installSessions(repliesBySession);
  const executor = new TaskExecutor(store as any, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as any);
  if (options.audit) {
    vi.spyOn(executor as any, "getRunContextFor").mockReturnValue({
      taskId: task().id,
      agentId: "reviewer",
      runId: "run-fn-288",
      phase: "execute",
    });
  }
  const step = options.verdictRequired === false
    ? { ...reviewStep(), id: "graph:report", name: "Report", optionalGroupId: undefined, gateMode: "advisory", skillName: "report" }
    : options.reviewKind
      ? { ...reviewStep(), reviewKind: options.reviewKind }
      : reviewStep();
  const outcome = await (executor as any).executeWorkflowStep(
    task(),
    step,
    "/tmp/fn-288-verdict",
    { workflowStepTimeoutMs: 180_000 },
    undefined,
  );
  return { outcome, prompts, store };
}

describe("workflow-step verdict repair", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockImplementation(() => Buffer.from(""));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts one exact approving verdict repair on the live session", async () => {
    const audit = vi.fn(async () => undefined);
    const { outcome, prompts } = await runStep([[
      "I inspected the scoped change and found no correctness defects.",
      '{"verdict":"APPROVE"}',
    ]], { audit });

    expect(outcome).toMatchObject({
      success: true,
      verdict: "APPROVE",
      notes: "I inspected the scoped change and found no correctness defects.",
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toHaveBeenCalledTimes(2);
    expect(prompts[0].mock.calls[1][0]).toBe(WORKFLOW_STEP_VERDICT_REPAIR_PROMPT("code-review"));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:review-verdict-repaired",
      metadata: expect.objectContaining({
        taskId: task().id,
        workflowStepId: "code-review",
        outcome: "repaired",
        verdict: "APPROVE",
      }),
    }));
  });

  it("does not infer a repaired verdict from prose", async () => {
    const { outcome, prompts } = await runStep([
      ["The review is complete but I omitted the required envelope.", "I approve this change."],
      ["The retry also omitted its verdict.", "I still approve this change."],
    ]);

    expect(outcome).toMatchObject({
      success: false,
      malformed: true,
      verdictRequired: true,
      notes: workflowStepMissingVerdictNotice("no-verdict"),
    });
    expect(outcome).not.toHaveProperty("verdict");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the single verdict repair times out", async () => {
    vi.useFakeTimers();
    const audit = vi.fn(async () => undefined);
    const pending = runStep([
      ["The review response omitted its verdict.", "never"],
      ["The retry also omitted its verdict.", "Still no verdict object."],
    ], { audit });

    await vi.advanceTimersByTimeAsync(WORKFLOW_STEP_VERDICT_REPAIR_TIMEOUT_MS);
    const { outcome, prompts } = await pending;

    expect(outcome).toMatchObject({ success: false, malformed: true, verdictRequired: true });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:review-verdict-repaired",
      metadata: expect.objectContaining({ outcome: "timed-out" }),
    }));
  });

  it("issues exactly one repair request per session when follow-ups still have no verdict", async () => {
    const { outcome, prompts } = await runStep([
      ["No verdict was authored.", "Still no verdict object.", '{"verdict":"APPROVE"}'],
      ["The retry omitted its verdict.", "The retry still has no verdict object."],
    ]);

    expect(outcome).toMatchObject({ success: false, malformed: true });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toHaveBeenCalledTimes(2);
  });

  it("does not request a verdict for a step whose contract does not require one", async () => {
    const { outcome, prompts } = await runStep([["Report completed."]], { verdictRequired: false });

    expect(outcome).toMatchObject({ success: true, output: "Report completed." });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toHaveBeenCalledOnce();
    expect(prompts[0]).not.toHaveBeenCalledWith(expect.stringContaining("parseable verdict"));
  });
});

/*
FNXC:ReviewVerdictAuthority 2026-09-05-22:54:
FN-295's exact shape: the reviewer emitted REVISE with three `high` findings inside a payload whose JSON
was broken, the repair round replied with the verdict alone, and the empty finding list was read as
"nothing blocking" — so the card entered execution on a plan the reviewer had just rejected.
*/
describe("verdict repair with unreadable findings", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockImplementation(() => Buffer.from(""));
  });

  const malformedRevise = '{"verdict":"REVISE","notes":"Plan incomplet.","findings":[{"id":"a","title":"Plan absent",'
    + '"body":"severity":"high. Ajouter un plan exécutable.","severity":"high","resolution":"open"}]}';

  it("keeps a REVISE rescued from a malformed payload blocking", async () => {
    const { outcome } = await runStep([[malformedRevise, '{"verdict":"REVISE"}']], { reviewKind: "plan" });

    expect(outcome).toMatchObject({ verdict: "REVISE" });
    expect(outcome).not.toMatchObject({ verdict: "APPROVE_WITH_NOTES" });
  });

  it("still downgrades a well-formed finding-less REVISE", async () => {
    const { outcome } = await runStep([[
      'Nothing blocking. {"verdict":"REVISE","notes":"Nits only.","findings":[]}',
    ]], { reviewKind: "plan" });

    expect(outcome).toMatchObject({ verdict: "APPROVE_WITH_NOTES" });
  });
});
