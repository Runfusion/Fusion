/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-11:50:
Plan Review (stale approval class) — a Plan Review may release the implementation path only when it
provably belongs to the exact plan content and workflow definition the reviewer was actually
dispatched against. Task-log prose is never identity; log timestamps may only ever BLOCK.
Every scenario drives the REAL graph executor entry (never a private helper) with production-shaped
persistence receipts, and asserts observable dispatch order: reviewer vs. implementation.

Symptom verification (AGENTS.md "Fix the invariant, not the repro"):
  Original symptom — an earlier Plan Review episode completed; the plan was then replaced
                     (revised plan, NULL approvedPlanFingerprint, NULL current projection), and
                     the old completion log was turned into passage: implementation started with
                     zero reviewer dispatches against the current plan.
  Reproduction     — KB-006 case below: empty workflowStepResults, no anchor, an older
                     "[pre-merge] Workflow step completed: Plan Review" log entry, production
                     receipt on the result-recording seam.
  Assertion it's gone — the reviewer template node runs exactly once and the implementation
                     node is never reached before it.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockProbeEnvironmentCapabilities } = vi.hoisted(() => ({
  mockProbeEnvironmentCapabilities: vi.fn(),
}));

/* Deterministic host probe: the materialization test drives the real Plan Review step session and
   must not shell out to the host toolchain. */
vi.mock("../environment/environment-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../environment/environment-capabilities.js")>();
  return {
    ...actual,
    probeEnvironmentCapabilities: mockProbeEnvironmentCapabilities.mockResolvedValue({ capabilities: [] }),
  };
});

import "./executor-test-helpers.js";
import type { Settings, TaskDetail, WorkflowIr, WorkflowStepResult } from "@fusion/core";
import { getBuiltinWorkflow, applyPromptOverridesToIr, FAST_MODE_BYPASS_ACTOR, computePlanApprovalFingerprint, computeWorkflowIrPin, resolveDefaultWorkflowIr } from "@fusion/core";
import type { WorkflowRuntimePrimitives } from "../execution/runtime-primitives.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import { executeWorkflowStep } from "../executor/execute-workflow-step.js";
import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { discardWorkflowStepLease, persistWorkflowStepResultWithOutcome, withPlanReviewCurrentWorkflowReader } from "../executor/execute-workflow-graph.js";
import { mockedCreateFnAgent, resetExecutorMocks } from "./executor-test-helpers.js";

import {
  PLAN_REVIEW_CURRENT_WORKFLOW_READER,
  WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY,
  WORKFLOW_PLAN_REVIEW_SNAPSHOT_CONTEXT_KEY,
  WorkflowGraphExecutor,
  type WorkflowNodeHandler,
  type WorkflowStepResultPersistenceOutcome,
} from "../workflows/workflow-graph-executor.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

/** Two-node production-shaped graph: the built-in-identity `plan-review` optional group
 *  (gate identification is by node id, never by reviewKind) then the implementation node. */
function planReviewIr(overrides: { irName?: string } = {}): WorkflowIr {
  return {
    version: "v2",
    name: overrides.irName ?? "current-plan-review-current-identity",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: "plan-review",
        kind: "optional-group",
        column: "todo",
        config: {
          name: "Plan Review",
          reviewKind: "plan",
          defaultOn: true,
          template: {
            nodes: [{ id: "plan-review-step", kind: "prompt", config: { prompt: "review the plan" } }],
            edges: [],
          },
        },
      },
      { id: "execute", kind: "prompt", column: "in-progress", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "in-progress" },
    ],
    edges: [
      { from: "start", to: "plan-review" },
      { from: "plan-review", to: "execute", condition: "success" },
      { from: "execute", to: "end" },
    ],
  };
}

/** require-all chain: plan review AND a code-review gate before implementation. */
function twoGateIr(): WorkflowIr {
  const ir = planReviewIr({ irName: "current-plan-review-require-all" });
  const codeGroup = {
    id: "code-review",
    kind: "optional-group" as const,
    column: "in-progress",
    config: {
      name: "Code Review",
      reviewKind: "code" as const,
      defaultOn: true,
      template: {
        nodes: [{ id: "code-review-step", kind: "prompt" as const, config: { prompt: "review the code" } }],
        edges: [],
      },
    },
  };
  ir.nodes.splice(3, 0, codeGroup);
  ir.edges.splice(1, 1,
    { from: "plan-review", to: "code-review", condition: "success" },
    { from: "code-review", to: "execute", condition: "success" },
  );
  return ir;
}

interface IdentityRunOpts {
  reviewerResult?: () => { outcome: "success"; value?: string; contextPatch?: Record<string, unknown> };
  codeReviewerResult?: () => { outcome: "success"; value?: string; contextPatch?: Record<string, unknown> };
  onWrite?: (row: WorkflowStepResult) => void;
}

/** A REVISE-failing genuine reviewer — for release-refusal cases it proves implementation was
 *  never reached VIA A RELEASE; a genuine reviewer still runs. */
const REVISE: IdentityRunOpts = { reviewerResult: () => ({ outcome: "failure", value: "REVISE" }) };

interface IdentityHarness {
  /** Node ids in visit order (template reviewer steps and top-level nodes alike). */
  visits: string[];
  reviewerDispatches: () => number;
  codeReviewerDispatches: () => number;
  executeDispatches: () => number;
  /** Every row the mini store durably applied, in write order. */
  recorded: WorkflowStepResult[];
  logs: string[];
  /** Mutable artifact fixture — tests may change the plan between any two awaits. */
  setArtifact: (content: string | undefined) => void;
  /** Simulate a competing reclaim: replace the store's plan-review lease with a newer attempt. */
  externalReclaim: (newStartedAt: string) => void;
  /** Make the persistence sink refuse every non-lease write (a hostile/fully-contended store). */
  setRefuseAll: (refuse: boolean) => void;
  /**
   * Plan Review R3: replace what the WIRED durable current-workflow reader resolves. Production resolves
   * the current definition through the store adapter, independently of the run's own `ir` object, so
   * a test that wants to prove that independence changes HERE — leaving `run`'s `ir` untouched.
   */
  setCurrentWorkflow: (resolver: (taskId: string) => WorkflowIr | undefined) => void;
  run: (
    task: TaskDetail,
    ir: WorkflowIr,
    opts?: {
      reviewerResult?: () => { outcome: "success"; value?: string; contextPatch?: Record<string, unknown> };
      codeReviewerResult?: () => { outcome: "success"; value?: string; contextPatch?: Record<string, unknown> };
      /** Called for every write BEFORE its receipt is produced (mid-persistence mutations). */
      onWrite?: (row: WorkflowStepResult) => void;
    },
  ) => Promise<{ outcome: string; value?: string; context: Record<string, unknown> }>;
}

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-16:40 (extended FNXC:CurrentPlanReviewIdentity 2026-10-11-16:59 for the default-equality
matrix): Plan Review R3 integration — a minimal durable workflow-definition store for the PRODUCTION
reader adapter. `withPlanReviewCurrentWorkflowReader` attaches the real strict provenance resolver
(resolveWorkflowIrForTaskWithProvenance + Plan Review classification) to the primitives seam, so
these cases prove the graph resolves the CURRENT definition through the actual executor adapter and
the actual core resolver — never a callback-only mock. The definition object is a live store
fixture: tests replace WHAT THE STORE RESOLVES, keeping the run's own `ir` object byte-identical.
Modes: an explicit selected custom definition, or a SUCCESSFUL no-selection read (the default
workflow is then authoritative), plus a throwing selection read for the unreadable negative.
*/
interface ProductionWorkflowStoreLike {
  getTaskWorkflowSelectionAsync?: (taskId: string) => Promise<{ workflowId: string; stepIds: string[] } | undefined>;
  getWorkflowDefinition: (id: string) => Promise<{ ir: string | WorkflowIr } | undefined>;
}

function productionWorkflowStore(
  initial: WorkflowIr | undefined,
  selectionMode: { absent?: boolean } = {},
) {
  let current: WorkflowIr | undefined = initial;
  let failSelection = false;
  const store: ProductionWorkflowStoreLike = {
    getTaskWorkflowSelectionAsync: async () => {
      // A transient durable failure: the fail-soft core resolver substitutes the default workflow
      // invisibly, so only the strict Plan Review classification can tell read-failure from a
      // legitimate read. This must block, even when the substituted default's pin would equal the
      // captured pin — never "assume unchanged".
      if (failSelection) throw new Error("durable selection read failed");
      // A SUCCESSFUL read with no selection: the default workflow is legitimately authoritative.
      if (selectionMode.absent) return undefined;
      return { workflowId: "wf-current-plan-review-current", stepIds: [] as string[] };
    },
    getWorkflowDefinition: async (workflowId: string) =>
      workflowId === "wf-current-plan-review-current" && current ? { ir: current } : undefined,
  };
  return {
    store,
    /** Durable definition replacement (or deletion when undefined) in the store — the ONLY way
     *  these cases move the current workflow; the run's `ir` object is never touched. */
    replace: (next: WorkflowIr | undefined) => { current = next; },
    makeSelectionUnreadable: () => { failSelection = true; },
  };
}

function harness(opts: { artifact?: string; wirePrimitives?: boolean; productionWorkflowStore?: ProductionWorkflowStoreLike } = {}): IdentityHarness {
  const wirePrimitives = opts.wirePrimitives !== false;
  let artifact: string | undefined = opts.artifact;
  const visits: string[] = [];
  const recorded: WorkflowStepResult[] = [];
  const logs: string[] = [];
  // Mini store with the production attempt-CAS contract for fenced plan-review terminal writes.
  let storeRows: WorkflowStepResult[] = [];
  let reviewerResult: () => { outcome: "success"; value?: string; contextPatch?: Record<string, unknown> } =
    () => ({ outcome: "success", value: "APPROVE" });
  let codeReviewerResult: () => { outcome: "success"; value?: string; contextPatch?: Record<string, unknown> } =
    () => ({ outcome: "success", value: "APPROVE", contextPatch: { reviewInputFingerprint: "content-fixture-hash" } });
  let onWrite: ((row: WorkflowStepResult) => void) | undefined;
  let refuseAll = false;
  /* FNXC:CurrentPlanReviewIdentity 2026-10-11-14:25: Plan Review R3 — defaults to "the durable store still
     resolves the workflow this run started with"; tests replace it to prove the reader, not the
     run's in-memory `ir` argument, is the authority for the current workflow definition. */
  let currentWorkflowResolver: (taskId: string) => WorkflowIr | undefined = () => undefined;
  let currentWorkflowResolverOverridden = false;

  const handler: WorkflowNodeHandler = async (node) => {
    visits.push(node.id);
    if (node.id === "plan-review-step") return reviewerResult();
    if (node.id === "code-review-step") return codeReviewerResult();
    if (node.id === "execute") return { outcome: "success" };
    return { outcome: "success" };
  };

  const executor = new WorkflowGraphExecutor({
    handlers: { prompt: handler },
    runId: "run-under-test",
    logTaskEntry: (msg: string) => { logs.push(msg); },
    // Production receipt contract with the attempt fence honored (never a bare undefined return).
    recordWorkflowStepResult: (_taskId, result, fence): WorkflowStepResultPersistenceOutcome => {
      if (refuseAll && result.status !== "pending") {
        return { scopeCurrent: true, persisted: false, disposition: "fence-refused" };
      }
      const required = typeof fence?.requireAttemptStartedAt === "string" ? fence.requireAttemptStartedAt
        : typeof fence?.requireAttemptStartedAtOrAbsent === "string" ? fence.requireAttemptStartedAtOrAbsent
          : undefined;
      const orAbsent = fence?.requireAttemptStartedAtOrAbsent !== undefined;
      if (required !== undefined) {
        const current = storeRows.find((row) => row.workflowStepId === result.workflowStepId);
        if (!current) {
          if (!orAbsent) return { scopeCurrent: true, persisted: false, disposition: "fence-refused" };
        } else if (current.startedAt !== required) {
          return { scopeCurrent: true, persisted: false, disposition: "fence-refused" };
        }
      }
      storeRows = [
        ...storeRows.filter((row) => row.workflowStepId !== result.workflowStepId),
        result,
      ];
      recorded.push(result);
      // Hook fires AFTER the store applied the row — mid-persistence interleavings (a competing
      // reclaim, an artifact edit while the write is awaited) land exactly between apply and
      // the caller's post-persistence checks, the real race window.
      onWrite?.(result);
      return { scopeCurrent: true, persisted: true, disposition: "applied", persistedResult: result };
    },
    // Production artifact-read seam — the same store read the approval-anchor writer uses — plus
    // the Plan Review current-workflow reader production attaches at the executor adapter
    // (`withPlanReviewCurrentWorkflowReader`), which the graph forwards through its Proxy.
    // With a `productionWorkflowStore` the reader is the REAL adapter + REAL core resolver; the
    // callback form remains only for non-R3 cases that just pin "store unchanged".
    primitives: (wirePrimitives
      ? (opts.productionWorkflowStore !== undefined
        ? withPlanReviewCurrentWorkflowReader(
            { readArtifact: async () => artifact } as unknown as WorkflowRuntimePrimitives,
            opts.productionWorkflowStore as never,
          )
        : {
          readArtifact: async () => artifact,
          // 3-state contract: the callback fixture resolves to an IR only on a successful read;
          // "no definition" is an explicit read failure, never an implicitly substituted default.
          [PLAN_REVIEW_CURRENT_WORKFLOW_READER]: async (taskId: string) => {
            const resolved = currentWorkflowResolver(taskId);
            return resolved
              ? ({ ok: true as const, ir: resolved })
              : ({ ok: false as const, reason: "current-workflow-read-failed" as const });
          },
        })
      : undefined) as unknown as WorkflowRuntimePrimitives | undefined,
  } as ConstructorParameters<typeof WorkflowGraphExecutor>[0]);

  return {
    visits,
    reviewerDispatches: () => visits.filter((id) => id === "plan-review-step").length,
    codeReviewerDispatches: () => visits.filter((id) => id === "code-review-step").length,
    executeDispatches: () => visits.filter((id) => id === "execute").length,
    recorded,
    logs,
    setArtifact: (content) => { artifact = content; },
    externalReclaim: (newStartedAt) => {
      storeRows = storeRows.map((row) => row.workflowStepId === "plan-review"
        ? { ...row, startedAt: newStartedAt, leaseOwner: "peer-reclaimer" }
        : row);
    },
    setRefuseAll: (refuse) => { refuseAll = refuse; },
    setCurrentWorkflow: (resolver) => {
      currentWorkflowResolver = resolver;
      currentWorkflowResolverOverridden = true;
    },
    run: async (task, ir, runOpts) => {
      if (runOpts?.reviewerResult) reviewerResult = runOpts.reviewerResult;
      if (runOpts?.codeReviewerResult) codeReviewerResult = runOpts.codeReviewerResult;
      if (runOpts?.onWrite) onWrite = runOpts.onWrite;
      // Default: the durable store still resolves exactly this run's definition (production steady
      // state). A test overrides this to model a replacement or an unresolvable definition.
      if (!currentWorkflowResolverOverridden) currentWorkflowResolver = () => ir;
      // Seed the mini store from the task fixture so attempt fences see the fixture rows.
      storeRows = [...(task.workflowStepResults ?? [])];
      return await executor.run(task, settingsOn(), ir) as unknown as {
        outcome: string;
        value?: string;
        context: Record<string, unknown>;
      };
    },
  };
}

const baseTask = (over: Partial<TaskDetail> = {}): TaskDetail =>
  ({ id: "FN-Plan Review", column: "todo", enabledWorkflowSteps: ["plan-review"], workflowStepResults: [], ...over } as TaskDetail);

/** The current plan every release fixture binds to. */
const PLAN = "# Plan\n\ncurrent contract";
const PLAN_FP = computePlanApprovalFingerprint(PLAN);
const ANCHOR = PLAN_FP;

/** A genuine graph-authored terminal passed row with a COMPLETE, current, dispatch-captured proof. */
function genuineRow(ir: WorkflowIr, over: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  const startedAt = "2026-10-11T09:00:00.000Z";
  const completedAt = "2026-10-11T09:00:05.000Z";
  return {
    workflowStepId: "plan-review",
    workflowStepName: "Plan Review",
    phase: "pre-merge",
    source: "optional-group",
    status: "passed",
    verdict: "APPROVE",
    reviewKind: "plan",
    startedAt,
    completedAt,
    reviewedInputIdentity: {
      planFingerprint: ANCHOR,
      workflowPin: computeWorkflowIrPin(ir, "plan-review"),
      runAttemptId: "prior-episode-run",
      attemptStartedAt: startedAt,
    },
    ...over,
  };
}

/** A task that releases cleanly for `ir`. */
function releaseReadyTask(ir: WorkflowIr, over: Partial<TaskDetail> = {}, rowOver: Partial<WorkflowStepResult> = {}): TaskDetail {
  return baseTask({
    approvedPlanFingerprint: ANCHOR,
    workflowStepResults: [genuineRow(ir, rowOver)],
    ...over,
  });
}

describe("Plan Review current-input identity (Plan Review KB-006 class)", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("KB-006: an older completed Plan Review log with no projection and no anchor cannot release implementation", async () => {
    const h = harness({ artifact: "# Revised plan\n\nCurrent plan content." });
    const task = baseTask({
      workflowStepResults: [],
      approvedPlanFingerprint: undefined,
      log: [
        {
          timestamp: "2026-10-10T09:00:00.000Z",
          action: "[pre-merge] Workflow step failed: Plan Review",
          outcome: "returned branch rejected",
        },
        {
          timestamp: "2026-10-10T10:00:00.000Z",
          action: "[pre-merge] Workflow step completed: Plan Review",
          outcome: "approved before the plan was replaced",
        },
      ],
    });

    const result = await h.run(task, planReviewIr(), {
      reviewerResult: () => ({ outcome: "failure", value: "REVISE" }),
    });

    // The current plan has never been reviewed. A genuine reviewer must run; the old log
    // line is audit trail only and can never authorize execution.
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits[0]).toBe("plan-review-step");
    // With the genuine reviewer REVISING, implementation is never reached — proving it was
    // never released by the log; nothing synthetic is persisted either.
    expect(result.outcome).toBe("failure");
    expect(h.visits).not.toContain("execute");
    expect(h.recorded.some((row) => row.source === undefined)).toBe(false);
  });

  it("2. releases nothing when every required proof input is missing, one at a time", async () => {
    const ir = planReviewIr();
    const fullProof = genuineRow(ir).reviewedInputIdentity!;
    const missingProofCases: Array<[string, Partial<WorkflowStepResult>]> = [
      ["no reviewedInputIdentity at all (old-record shape)", { reviewedInputIdentity: undefined }],
      ["no plan fingerprint", { reviewedInputIdentity: { ...fullProof, planFingerprint: "" } }],
      ["no captured workflow pin", { reviewedInputIdentity: { ...fullProof, workflowPin: undefined } as unknown as WorkflowStepResult["reviewedInputIdentity"] }],
      ["no run/attempt identity", { reviewedInputIdentity: { ...fullProof, runAttemptId: "" } }],
      ["no attemptStartedAt", { reviewedInputIdentity: { ...fullProof, attemptStartedAt: "" } }],
      ["missing original row time", { completedAt: undefined }],
      ["identical start and finish times", { completedAt: "2026-10-11T09:00:00.000Z" }],
      ["non-graph source", { source: "node" }],
      ["no verdict", { verdict: undefined }],
    ];
    for (const [name, rowOver] of missingProofCases) {
      const h = harness({ artifact: PLAN });
      const task = releaseReadyTask(ir, {}, rowOver);
      await h.run(task, ir, REVISE);
      // Genuine rerun each time — never a synthetic release, never a fabricated row.
      expect(`refused for "${name}": ${h.reviewerDispatches()}`).toBe(`refused for "${name}": 1`);
      expect(h.visits).not.toContain("execute");
    }
  });

  /*
  FNXC:CurrentPlanReviewIdentity 2026-10-12-17:59:
  Plan Review (review validation bounded current-candidate correction) — reversed review chronology must refuse at the
  graph release authority. The independent approval-anchor writer (planReviewAnchorProofAllows in
  execute-workflow-graph.ts) already requires completedMs > startedMs, so the graph re-entry contract
  may not be looser: a terminal row that finished BEFORE it started is impossible for a real
  completion, however genuine its remaining shape, and can never release implementation. The fixed
  refusal vocabulary (non-distinct-original-times) is reused — no new reason string.
  */
  it("2a. refuses a terminal row whose completion precedes its start (reversed chronology) and runs a genuine review", async () => {
    const h = harness({ artifact: PLAN });
    const ir = planReviewIr();
    // The operator's counterexample: a release-ready task whose terminal row is otherwise fully
    // genuine (anchor and captured plan/pin/attempt all match current, proof.attemptStartedAt ==
    // row.startedAt == 2026-10-11T09:00:00.000Z, no plan-review failure log), but whose completedAt
    // is one second EARLIER than its start.
    const task = releaseReadyTask(ir, {}, { completedAt: "2026-10-11T08:59:59.000Z" });
    await h.run(task, ir, REVISE);
    // Not released as already-passed: the genuine reviewer template node dispatches exactly once,
    // first in visit order, and the implementation node is never reached before it.
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits[0]).toBe("plan-review-step");
    expect(h.visits).not.toContain("execute");
    // No synthetic row is ever persisted — only genuine graph-authored terminal rows are written.
    expect(h.recorded.some((row) => row.source === undefined)).toBe(false);
  });

  it("2b. refuses release when no artifact is readable at release time", async () => {
    const h = harness({ artifact: undefined });
    const ir = planReviewIr();
    const task = releaseReadyTask(ir);
    await h.run(task, ir, REVISE);
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
  });

  it("3. refuses a fully decorated row whose captured plan fingerprint is from plan A with a different non-empty anchor for plan B", async () => {
    const h = harness({ artifact: PLAN });
    const ir = planReviewIr();
    const planBFp = computePlanApprovalFingerprint(PLAN);
    const task = releaseReadyTask(ir, { approvedPlanFingerprint: planBFp }, {
      reviewedInputIdentity: {
        planFingerprint: "sha256:plan-a-not-b",
        workflowPin: computeWorkflowIrPin(ir, "plan-review"),
        runAttemptId: "prior-episode-run",
        attemptStartedAt: "2026-10-11T09:00:00.000Z",
      },
    });
    await h.run(task, ir, REVISE);
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
  });

  it("3b. refuses when the plan artifact drifted after the anchor and proof were written", async () => {
    const h = harness({ artifact: "# Plan\n\nsomeone edited the contract mid-flight" });
    const ir = planReviewIr();
    const task = releaseReadyTask(ir);
    await h.run(task, ir, REVISE);
    // Recomputed current != anchor == captured → refuse; a genuine review of the NEW content runs.
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
  });

  it("4. refuses the same plan and node with a DIFFERENT workflow definition (captured pin irHash drift)", async () => {
    const h = harness({ artifact: PLAN });
    const capturedIr = planReviewIr();
    const task = releaseReadyTask(capturedIr);
    // The workflow definition the task is now resolved against differs from the captured pin.
    const currentIr = planReviewIr({ irName: "current-plan-review-swapped-workflow" });
    await h.run(task, currentIr, REVISE);
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
  });

  it("5. strips release authority when the plan mutates between capture and reviewer materialization", async () => {
    const h = harness({ artifact: PLAN });
    const task = baseTask();
    // The plan moves immediately after the lease claim — before the reviewer materializes —
    // proving the capture binds to materialization, not merely to a pre-dispatch read.
    const result = await h.run(task, planReviewIr(), {
      reviewerResult: () => ({ outcome: "failure", value: "REVISE" }),
      onWrite: (row) => {
        if (row.status === "pending") h.setArtifact("# Plan\n\nreplaced after capture, before materialization");
      },
    });
    expect(h.reviewerDispatches()).toBe(1);
    // Never implementation: the attempt's proof was stripped, so no passage authority rides it.
    expect(h.visits).not.toContain("execute");
    expect(result.context["node:plan-review:value"]).toBe("REVISE");
    // The stripped attempt persists no identity — nothing fabricated or stale-carried.
    const terminal = h.recorded.find((row) => row.status !== "pending");
    expect(terminal?.reviewedInputIdentity).toBeUndefined();
  });

  it("6. blocks implementation on a mid-reviewer plan edit and preserves the genuine verdict and original times", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const h = harness({ artifact: PLAN });
    const task = baseTask();
    const result = await h.run(task, planReviewIr(), {
      reviewerResult: async () => {
        vi.advanceTimersByTime(5000);
        // The reviewer edits/mutates the plan while its own session is running, then APPROVES.
        h.setArtifact("# Plan\n\ncontent the reviewer never saw");
        return { outcome: "success", value: "APPROVE" };
      },
    });
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
    // The gate's terminal failure routes through the executor context (the same seam as the
    // authoritative-routing tests), not the graph-level run value.
    expect(result.context["node:plan-review:value"]).toBe("gate-stale-review-input");
    const terminal = h.recorded.find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    // Genuine reviewer evidence is recorded UNCHANGED — verdict and distinct original times intact,
    // with the proof still naming the pre-dispatch plan (never the post-change one).
    expect(terminal).toMatchObject({
      status: "passed",
      verdict: "APPROVE",
      reviewedInputIdentity: { planFingerprint: computePlanApprovalFingerprint(PLAN) },
    });
    expect(terminal?.startedAt).toBeDefined();
    expect(terminal?.completedAt).toBeDefined();
    expect(terminal?.startedAt).not.toBe(terminal?.completedAt);
  });

  it("6b. blocks implementation on a workflow-definition swap during the reviewer", async () => {
    const h = harness({ artifact: PLAN });
    const ir = planReviewIr();
    const task = baseTask();
    const result = await h.run(task, ir, {
      reviewerResult: () => {
        // Mid-reviewer workflow mutation: same ordering class as a plan edit.
        (ir.nodes[1]!.config as Record<string, unknown>).name = "Plan Review edited mid-review";
        return { outcome: "success", value: "APPROVE" };
      },
    });
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
    expect(result.context["node:plan-review:value"]).toBe("gate-stale-review-input");
  });

  it("7. persists the PRE-DISPATCH proof when the plan changes while the terminal write is awaited", async () => {
    const h = harness({ artifact: PLAN });
    const task = baseTask();
    const result = await h.run(task, planReviewIr(), {
      onWrite: (row) => {
        if (row.status === "passed") h.setArtifact("# Plan\n\nmoved during terminal persistence");
      },
    });
    // Implementation is not reached: the terminal re-read sees the drift and blocks.
    expect(h.visits).not.toContain("execute");
    expect(result.context["node:plan-review:value"]).toBe("gate-stale-review-input");
    // The persisted row carries the PRE-DISPATCH captured value, never the post-change one.
    const terminal = h.recorded.find((row) => row.status === "passed");
    expect(terminal?.reviewedInputIdentity?.planFingerprint).toBe(computePlanApprovalFingerprint(PLAN));
  });

  it("8. refuses a terminal write displaced by a newer attempt and persists nothing for it", async () => {
    const h = harness({ artifact: PLAN });
    const task = baseTask();
    // Immediately after THIS attempt's lease is applied, a competing reclaim wins a newer
    // attempt in the store. The original attempt's fenced terminal write must then be refused
    // (production fenced-writer contract) — its proof never lands and the required gate fails
    // closed instead of an overwritten attempt releasing implementation.
    const result = await h.run(task, planReviewIr(), {
      onWrite: (row) => {
        if (row.status === "pending") h.externalReclaim("2027-01-01T00:00:00.000Z");
      },
    });
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
    expect(result.context["node:plan-review:value"]).toBe("gate-persistence-unavailable");
    // The displaced terminal row (with its proof) is NOT in the durable set — only the
    // displaced-and-refused state exists; the store's row keeps the RECLAIMER's identity.
    expect(h.recorded.every((row) => row.status === "pending")).toBe(true);
  });

  it("9. refuses a passed row whose proof was copied onto it (attemptStartedAt != own startedAt)", async () => {
    const h = harness({ artifact: PLAN });
    const ir = planReviewIr();
    const task = releaseReadyTask(ir, {}, {
      reviewedInputIdentity: {
        planFingerprint: ANCHOR,
        workflowPin: computeWorkflowIrPin(ir, "plan-review"),
        runAttemptId: "some-other-run",
        attemptStartedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    await h.run(task, ir, REVISE);
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
  });

  it("10. retires superseded rows (both reasons) from release authority", async () => {
    for (const reason of ["dependency-change", "respecify"] as const) {
      const h = harness({ artifact: PLAN });
      const ir = planReviewIr();
      const task = releaseReadyTask(ir, {}, { supersededAt: "2026-10-11T09:30:00.000Z", supersededReason: reason });
      await h.run(task, ir, REVISE);
      expect(`${reason}: ${h.reviewerDispatches()}`).toBe(`${reason}: 1`);
      expect(h.visits).not.toContain("execute");
    }
  });

  it("10b. never releases through any historical skipped carrier — regardless of the anchor", async () => {
    const ir = planReviewIr();
    const carriers: Array<{ name: string; row: WorkflowStepResult; anchor: string | undefined }> = [
      {
        name: "operator bypass (null anchor)",
        anchor: undefined,
        row: {
          workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge",
          source: "optional-group", status: "skipped", startedAt: "2026-10-01T09:00:00.000Z",
          completedAt: "2026-10-01T09:00:00.000Z",
          bypassedBy: "operator", bypassedAt: "2026-10-01T09:00:00.000Z",
          bypassReason: "FN-1946 no-verdict lane stranded the card",
          bypassedFromStatus: "failed", bypassedFromVerdict: "REVISE",
        },
      },
      {
        name: "operator bypass (different non-empty anchor)",
        anchor: "sha256:different-plan",
        row: {
          workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge",
          source: "optional-group", status: "skipped", startedAt: "2026-10-01T09:00:00.000Z",
          completedAt: "2026-10-01T09:00:00.000Z",
          bypassedBy: "operator", bypassedAt: "2026-10-01T09:00:00.000Z",
          bypassReason: "FN-1946 no-verdict lane stranded the card",
          bypassedFromStatus: "failed", bypassedFromVerdict: "REVISE",
        },
      },
      {
        name: "arbitration release carrier",
        anchor: "sha256:different-plan",
        row: {
          workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge",
          source: "optional-group", status: "skipped", startedAt: "2026-10-01T09:00:00.000Z",
          completedAt: "2026-10-01T09:00:00.000Z",
          remediationArchivedAt: "2026-10-01T09:00:00.000Z",
          remediationArchivedFromStatus: "failed",
          arbitrationDecision: "UPHOLD_IMPLEMENTER",
          arbitrationBindingFindingCount: 0,
          arbitratedAt: "2026-10-01T09:00:00.000Z",
          arbitrationNotes: "binding findings zero",
        },
      },
      {
        name: "automated fast-mode carrier",
        anchor: ANCHOR,
        row: {
          workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge",
          source: "optional-group", status: "skipped",
          bypassedBy: FAST_MODE_BYPASS_ACTOR,
          bypassedAt: "2026-10-01T09:00:00.000Z",
          bypassReason: "Fast mode bypasses pre-merge workflow gates",
          bypassedFromStatus: "absent",
          startedAt: "2026-10-01T09:00:00.000Z",
        },
      },
      {
        name: "automated stale-callback waiver carrier",
        anchor: ANCHOR,
        row: {
          workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge",
          source: "optional-group", status: "skipped",
          startedAt: "2026-10-01T09:00:00.000Z",
          automatedStaleCallbackWaiver: {
            receiptId: "rcpt-1",
            policyVersion: "fn-9429-v1",
            actor: "system:stale-review-callback-waiver",
            reason: "proven-stale-code-review-callback",
            issuedAt: "2026-10-01T09:00:00.000Z",
            priorStatus: "pending",
            attemptId: "attempt-1",
          },
        },
      },
    ];
    for (const carrier of carriers) {
      const h = harness({ artifact: PLAN });
      const task = baseTask({ approvedPlanFingerprint: carrier.anchor, workflowStepResults: [carrier.row] });
      await h.run(task, ir, REVISE);
      expect(`${carrier.name}: ${h.reviewerDispatches()}`).toBe(`${carrier.name}: 1`);
      expect(carrier.name).toBeTruthy();
      expect(h.visits).not.toContain("execute");
    }
  });

  it("11. refuses contradictory current failure evidence (second row, later/same-ms/unorderable log)", async () => {
    const ir = planReviewIr();
    // A second non-superseded terminal row is contradictory evidence.
    {
      const h = harness({ artifact: PLAN });
      const task = releaseReadyTask(ir, {}, {});
      (task.workflowStepResults as WorkflowStepResult[]).push({
        workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge",
        source: "optional-group", status: "failed", startedAt: "2026-10-11T09:30:00.000Z",
        completedAt: "2026-10-11T09:30:05.000Z",
      });
      await h.run(task, ir, REVISE);
      expect(h.reviewerDispatches()).toBe(1);
    }
    for (const [label, failureTimestamp] of [
      ["strictly later", "2026-10-11T09:00:06.000Z"],
      ["same millisecond as the passed completion", "2026-10-11T09:00:05.000Z"],
      ["unparseable", "not-a-timestamp"],
    ] as const) {
      const h = harness({ artifact: PLAN });
      const task = releaseReadyTask(ir, {
        log: [{ timestamp: failureTimestamp, action: "[pre-merge] Workflow step failed: Plan Review" }],
      });
      await h.run(task, ir, REVISE);
      expect(`${label}: ${h.reviewerDispatches()}`).toBe(`${label}: 1`);
      expect(label).toBeTruthy();
    }
  });

  it("12. releases a genuinely matching complete current identity with no reviewer dispatch and no rewrites", async () => {
    const h = harness({ artifact: PLAN });
    const ir = planReviewIr();
    const task = releaseReadyTask(ir);
    const snapshot = structuredClone(task.workflowStepResults);

    const result = await h.run(task, ir);

    expect(h.reviewerDispatches()).toBe(0);
    expect(result.outcome).toBe("success");
    expect(h.executeDispatches()).toBe(1);
    expect(h.logs).toContain("[pre-merge] Workflow step already satisfied: Plan Review");
    // A release performs NO workflow-step write and rewrites nothing — exact verdict and the
    // original distinct times survive untouched.
    expect(h.recorded).toEqual([]);
    expect(task.workflowStepResults).toEqual(snapshot);
    const row = snapshot![0]!;
    expect(row.verdict).toBe("APPROVE");
    expect(row.startedAt).not.toBe(row.completedAt);
  });

  it("13. a passed CLOSE_NO_OP row never releases the implementation path", async () => {
    const h = harness({ artifact: PLAN });
    const ir = planReviewIr();
    const task = releaseReadyTask(ir, {}, { verdict: "CLOSE_NO_OP" });
    await h.run(task, ir, REVISE);
    // A close is not a generic approval; a genuine review runs instead.
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
  });

  it("14. a refused terminal write fails the required gate closed without reaching implementation", async () => {
    // Production refuses a fenced terminal write when the store row has moved on. The engine's
    // own fenced-writer refusal semantics are pinned by the authoritative-gate-result-routing
    // suite (no-writer / throw / fence-refused); here the graph seam additionally proves the
    // implementation node is never reached when the required gate's persistence fails.
    const h = harness({ artifact: PLAN });
    const task = baseTask();
    // Force the persistence sink itself to refuse, the way a fenced store would.
    h.setRefuseAll(true);
    const result = await h.run(task, planReviewIr(), {
      reviewerResult: () => ({ outcome: "success", value: "APPROVE" }),
    });
    expect(result.outcome).toBe("failure");
    expect(result.context["node:plan-review:value"]).toBe("gate-persistence-unavailable");
    expect(h.visits).not.toContain("execute");
  });

  it("15. require-all chain: a released Plan Review still runs the later enabled gate and merges nothing", async () => {
    const h = harness({ artifact: PLAN });
    const ir = twoGateIr();
    const task = baseTask({
      enabledWorkflowSteps: ["plan-review", "code-review"],
      approvedPlanFingerprint: ANCHOR,
      workflowStepResults: [genuineRow(ir)],
    });

    const result = await h.run(task, ir);

    // The release is not delivery: the code-review gate still runs genuinely.
    expect(h.reviewerDispatches()).toBe(0);
    expect(h.codeReviewerDispatches()).toBe(1);
    expect(result.outcome).toBe("success");
    // No merge surface is even reachable from this graph — nothing auto-merges from a release.
    expect(h.visits.filter((id) => id === "merge")).toHaveLength(0);
  });

  it("16. carrier purity: a genuine plan-review completion carries identity ONLY in reviewedInputIdentity", async () => {
    const h = harness({ artifact: PLAN });
    const task = baseTask();
    await h.run(task, planReviewIr());
    const terminal = h.recorded.find((row) => row.status === "passed");
    expect(terminal?.reviewedInputIdentity).toBeDefined();
    expect(terminal?.reviewedInputIdentity?.planFingerprint).toBe(PLAN_FP);
    // The content-review carrier stays absent on plan-review rows — its 14 consumers are untouched.
    expect(terminal?.reviewInputFingerprint).toBeUndefined();
  });

  it("17. refuses when the plan content moved between the stored proof and a later graph entry", async () => {
    // Same ordering class as 3b through an explicit two-entry sequence: entry one released
    // cleanly, the plan moved, entry two must dispatch against the CURRENT content.
    const h = harness({ artifact: PLAN });
    const ir = planReviewIr();
    const task = releaseReadyTask(ir);
    await h.run(task, ir);
    expect(h.reviewerDispatches()).toBe(0);
    h.setArtifact("# Plan\n\nedited after the release");
    const second = harness({ artifact: "# Plan\n\nedited after the release" });
    await second.run(baseTask({ approvedPlanFingerprint: ANCHOR, workflowStepResults: [genuineRow(ir)] }), ir, REVISE);
    expect(second.reviewerDispatches()).toBe(1);
    expect(second.visits).not.toContain("execute");
  });
});

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-14:25:
Plan Review R2 — the proof contract is enforced on EVERY fresh approving Plan Review terminal, not only on
attempts whose pre-dispatch capture happened to succeed. The historical shape: capture failed (no
primitives seam, unreadable/blank plan artifact), so no identity existed to validate; the reviewer
still APPROVEd, a genuine `passed` row was persisted, and the graph walked straight into
implementation. The row stays honest history; the implementation path does not open.
*/
describe("Plan Review fresh-approving terminal requires its own proof (Plan Review R2)", () => {
  it("R2. a genuine APPROVE with no dispatch-captured proof never reaches implementation", async () => {
    // Unwired primitives seam ⇒ nothing readable at capture ⇒ proof is undefined by design.
    const h = harness({ wirePrimitives: false });
    const task = baseTask();

    const result = await h.run(task, planReviewIr(), {
      // An APPROVEing reviewer, deliberately: a REVISE would fail the gate trivially and prove
      // nothing about the release path.
      reviewerResult: () => ({ outcome: "success", value: "APPROVE" }),
    });

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
    expect(result.context["node:plan-review:value"]).toBe("gate-unproven-plan-review-input");
    expect(result.outcome).toBe("failure");

    // Genuine reviewer evidence survives: the passed APPROVE row is persisted exactly as produced,
    // with no identity carrier manufactured for it.
    const terminal = h.recorded.find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
    expect(terminal?.reviewedInputIdentity).toBeUndefined();
    // And the blocking value is what the graph logged — an honest reason code, not silence.
    expect(h.logs.some((line) => line.includes("gate-unproven-plan-review-input"))).toBe(true);
  });

  it("R2b. a genuine APPROVE whose capture was stripped by the materialization guard is unproven too", async () => {
    const h = harness({ artifact: PLAN });
    const task = baseTask();

    const result = await h.run(task, planReviewIr(), {
      reviewerResult: () => ({ outcome: "success", value: "APPROVE" }),
      // The plan moves right after the lease claim, before the reviewer materializes.
      onWrite: (row) => {
        if (row.status === "pending") h.setArtifact("# Plan\n\nreplaced after capture, before materialization");
      },
    });

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
    expect(result.context["node:plan-review:value"]).toBe("gate-unproven-plan-review-input");
    const terminal = h.recorded.find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
    expect(terminal?.reviewedInputIdentity).toBeUndefined();
  });
});

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-14:25:
Plan Review R1 — materialization binding proven through the REAL custom-node runner and the REAL step
materialization function. The claim the identity is allowed to make is "the reviewer was shown exactly
these bytes", so the assertion is on the bytes handed to the reviewer session — not on a context key
having been set, and not on a mocked reviewer callback.
*/
describe("Plan Review reviewer input bytes are the captured snapshot (Plan Review R1)", () => {
  const SNAPSHOT = "# Plan A\n\nfingerprinted before dispatch";
  const MOVED = "# Plan B\n\nwritten after the preliminary read";

  beforeEach(() => {
    resetExecutorMocks();
    mockProbeEnvironmentCapabilities.mockResolvedValue({ capabilities: [] });
  });

  /** Captures the actual system prompt of every reviewer session the real step function opens. */
  function capturedSession(): string[] {
    const prompts: string[] = [];
    const output = "{\"verdict\":\"APPROVE\",\"notes\":\"Reviewed the embedded plan.\"}";
    mockedCreateFnAgent.mockImplementation(async (options: { systemPrompt?: string }) => {
      prompts.push(String(options.systemPrompt ?? ""));
      const listeners: Array<(event: unknown) => void> = [];
      return {
        session: {
          state: {},
          subscribe: (listener: (event: unknown) => void) => {
            listeners.push(listener);
            return () => undefined;
          },
          prompt: vi.fn(async () => {
            for (const listener of listeners) {
              listener({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: output, partial: output },
              });
            }
          }),
          dispose: vi.fn(),
        },
      } as never;
    });
    return prompts;
  }

  /** Real-runner deps whose ONLY scripted part is the store artifact read and the session. */
  function runnerDeps(readTaskArtifact: ReturnType<typeof vi.fn>) {
    const row = { id: "FN-Plan Review", column: "todo", dependencies: [], steps: [], log: [] };
    const store = {
      getTask: vi.fn(async () => row),
      logEntry: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => undefined),
      // The session's agent-log writer — awaited per streamed entry, so an absent method surfaces
      // as an unhandled rejection rather than a red assertion.
      appendAgentLog: vi.fn(async () => undefined),
    };
    return {
      store,
      rootDir: process.cwd(),
      options: {
        agentStore: { getAgent: vi.fn(async () => null), createAgent: vi.fn() },
      },
      workspaceConfig: null,
      graphUnattendedRuns: new Set<string>(),
      getRunContextFor: () => undefined,
      adoptColumnAgentForNode: vi.fn(async () => undefined),
      buildInjectedRuntimeEnv: vi.fn(async () => ({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 })),
      ensureGraphCustomNodeWorktree: vi.fn(async () => row),
      executeScriptWorkflowStep: vi.fn(async () => ({ success: true, output: "APPROVE" })),
      /* The real materialization function: it is the only place PROMPT.md is actually embedded into
         a reviewer context, so it is the only place a materialization claim can be tested. */
      executeWorkflowStep: (
        task: unknown,
        step: unknown,
        worktreePath: string,
        settings: unknown,
        nodeEnv: unknown,
        stepOptions: unknown,
      ) => executeWorkflowStep(
        {
          store,
          rootDir: process.cwd(),
          options: {
            agentStore: { getAgent: vi.fn(async () => null), createAgent: vi.fn() },
          },
          activePlanningWorkflowSessions: new Set(),
          activeWorkflowStepSessions: new Map(),
          getRunContextFor: () => undefined,
          captureModifiedFiles: vi.fn(async () => []),
          createSpawnAgentTool: vi.fn(),
          sharedWorkerTools: {
            store,
            rootDir: process.cwd(),
            getRunContextFor: () => undefined,
          } as never,
          deleteActiveWorkflowStepSession: vi.fn(),
          getAssignedAgentRuntimeConfig: vi.fn(),
          getAuthoritativeAssignedAgent: vi.fn(async () => null),
          readTaskArtifact,
          resolveInstructionsForRole: vi.fn(async () => ""),
          resolveMcpServers: vi.fn(async () => []),
          setActiveWorkflowStepSession: vi.fn(),
        } as never,
        task as never,
        step as never,
        worktreePath,
        settings as never,
        nodeEnv as never,
        stepOptions as never,
      ),
      pauseForCliApproval: vi.fn(),
      resolveWorkflowInputMarkerForGraphNode: vi.fn(async () => undefined),
      runAwaitInputNode: vi.fn(),
      runCliAgentNode: vi.fn(),
      runRawCliCommand: vi.fn(),
      runConfiguredCommand: vi.fn(),
    };
  }

  async function dispatchReviewNode(
    graphContext: Record<string, unknown>,
    node: { id: string; config: Record<string, unknown> },
    readTaskArtifact: ReturnType<typeof vi.fn>,
  ) {
    return await runGraphCustomNode(
      runnerDeps(readTaskArtifact) as never,
      { id: node.id, kind: "prompt", config: node.config } as never,
      { id: "FN-Plan Review", baseCommitSha: "base" } as never,
      {} as Settings,
      undefined,
      graphContext,
    );
  }

  it("R1. the reviewer's actual input equals the captured snapshot even after the artifact moved", async () => {
    // The store now holds a DIFFERENT plan: an edit landed after the executor's preliminary
    // pre-dispatch read. A standalone read would prove nothing — the binding is the handoff.
    const readTaskArtifact = vi.fn(async () => MOVED);
    const prompts = capturedSession();

    const result = await dispatchReviewNode(
      {
        [WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY]: "plan-review",
        [WORKFLOW_PLAN_REVIEW_SNAPSHOT_CONTEXT_KEY]: SNAPSHOT,
      },
      { id: "plan-review-step", config: { name: "Plan Review", reviewKind: "plan", gateMode: "gate", prompt: "Review the plan." } },
      readTaskArtifact,
    );

    expect(result.outcome).toBe("success");
    expect(prompts).toHaveLength(1);
    const reviewerInput = prompts[0];
    // Exact reviewer bytes: the fingerprinted snapshot, not the post-read mutation.
    expect(reviewerInput).toContain(SNAPSHOT);
    expect(reviewerInput).not.toContain(MOVED);
    // The bound path performs no independent artifact read at all.
    expect(readTaskArtifact).not.toHaveBeenCalled();
  });

  it("R1b. a snapshot-less dispatch keeps the independent store read unchanged", async () => {
    const readTaskArtifact = vi.fn(async () => MOVED);
    const prompts = capturedSession();

    const result = await dispatchReviewNode(
      { [WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY]: "plan-review" },
      { id: "plan-review-step", config: { name: "Plan Review", reviewKind: "plan", gateMode: "gate", prompt: "Review the plan." } },
      readTaskArtifact,
    );

    expect(result.outcome).toBe("success");
    expect(readTaskArtifact).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain(MOVED);
    expect(prompts[0]).not.toContain(SNAPSHOT);
  });

  it("R1c. a snapshot leaked to a non-plan-review step does not override its own read", async () => {
    // A review-type but non-Plan-Review node: the binding is keyed on Plan Review identity, so a
    // stray snapshot key must not substitute bytes for a different lane's spec read.
    const readTaskArtifact = vi.fn(async () => MOVED);
    const prompts = capturedSession();

    const result = await dispatchReviewNode(
      {
        [WORKFLOW_OPTIONAL_GROUP_CONTEXT_KEY]: "design-review",
        [WORKFLOW_PLAN_REVIEW_SNAPSHOT_CONTEXT_KEY]: SNAPSHOT,
      },
      { id: "design-review-step", config: { name: "Design Review", gateMode: "gate", prompt: "Review the design." } },
      readTaskArtifact,
    );

    expect(result.outcome).toBe("success");
    // Not Plan Review: its spec read stays independent and unchanged.
    expect(readTaskArtifact).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain(MOVED);
    expect(prompts[0]).not.toContain(SNAPSHOT);
  });
});

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-14:25:
Plan Review R3 — the CURRENT workflow definition is resolved durably through the wired reader, NOT recomputed
from this run's `ir` argument. A definition replaced in the store while a reviewer runs leaves that
JavaScript object untouched, so the run-start object cannot be the authority for "is this still
current?". Each case leaves `run`'s `ir` object byte-identical and changes only what the reader
resolves.
*/
describe("Plan Review current-workflow independence (Plan Review R3)", () => {
  it("R3. refuses release when the durable workflow definition was replaced while the run's IR object is unchanged", async () => {
    const h = harness({ artifact: PLAN });
    const runIr = planReviewIr();
    // The proof was captured against the definition that was current when the review ran.
    const task = releaseReadyTask(runIr);
    // Then an operator replaced the workflow definition in the store. The run's own `ir` object is
    // NOT touched — only the durable resolution moved.
    h.setCurrentWorkflow(() => planReviewIr({ irName: "current-plan-review-replaced-in-store" }));

    await h.run(task, runIr, REVISE);

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
  });

  it("R3b. blocks implementation when the durable definition is replaced mid-reviewer (run IR object unchanged)", async () => {
    const h = harness({ artifact: PLAN });
    const runIr = planReviewIr();
    const task = baseTask();

    const result = await h.run(task, runIr, {
      reviewerResult: () => {
        // Durable replacement during the reviewer session: the captured pin's workflow is no longer
        // the current definition, while `runIr` (the run's own object) is untouched.
        h.setCurrentWorkflow(() => planReviewIr({ irName: "current-plan-review-replaced-mid-review" }));
        return { outcome: "success", value: "APPROVE" };
      },
    });

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
    expect(result.context["node:plan-review:value"]).toBe("gate-stale-review-input");
    // The genuine APPROVE survives as history with its own captured (pre-replacement) pin.
    const terminal = h.recorded.find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
    expect(terminal?.reviewedInputIdentity?.workflowPin.irHash).toBe(
      computeWorkflowIrPin(runIr, "plan-review").irHash,
    );
  });

  it("R3c. an unresolvable current definition refuses release", async () => {
    const h = harness({ artifact: PLAN });
    const runIr = planReviewIr();
    const task = releaseReadyTask(runIr);
    // A WIRED reader that resolves nothing is "unreadable", never "unchanged".
    h.setCurrentWorkflow(() => undefined);

    await h.run(task, runIr, REVISE);
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.visits).not.toContain("execute");
  });
});

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-16:40:
Plan Review R3 production-adapter integration — the cases above prove the boundary behavior with a
wired reader callback; these prove the PRODUCTION path itself: the primitives object is built by
the real executor adapter `withPlanReviewCurrentWorkflowReader` (execute-workflow-graph.ts), whose
reader is the real strict provenance classification over `resolveWorkflowIrForTaskWithProvenance`
(core) resolving against a durable store fixture.
A callback-only mock cannot substitute this proof, and the run's own `ir` object is never the
replacement channel — every move here replaces only WHAT THE STORE RESOLVES, and each case
asserts the run-start IR stayed byte-identical.
*/
describe("Plan Review production current-workflow reader (Plan Review R3 integration)", () => {
  it("PROD1. a genuine steady-state approval releases through the real adapter + resolver without a reviewer re-dispatch", async () => {
    const reviewedDefinition = planReviewIr();
    // The store resolves a SEPARATE object with the reviewed definition — release must compare
    // resolved durable content, not object identity, and never this run's `ir` argument.
    const wf = productionWorkflowStore(structuredClone(reviewedDefinition));
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask({
      approvedPlanFingerprint: ANCHOR,
      workflowStepResults: [genuineRow(reviewedDefinition)],
    });
    const runIr = planReviewIr();
    const runStartBytes = JSON.stringify(runIr);

    const result = await h.run(task, runIr);

    expect(result.outcome).toBe("success");
    expect(h.logs).toContain("[pre-merge] Workflow step already satisfied: Plan Review");
    expect(h.reviewerDispatches()).toBe(0);
    expect(h.executeDispatches()).toBe(1);
    // A release performs no workflow-step write.
    expect(h.recorded.filter((row) => row.workflowStepId === "plan-review" && row.status !== "pending")).toHaveLength(0);
    expect(JSON.stringify(runIr)).toBe(runStartBytes);
  });

  it("PROD2. a genuine APPROVE is blocked from implementation when the STORE definition is durably replaced mid-review", async () => {
    const runIr = planReviewIr();
    const runStartBytes = JSON.stringify(runIr);
    const wf = productionWorkflowStore(structuredClone(runIr));
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask();

    const result = await h.run(task, runIr, {
      reviewerResult: () => {
        // Durable replacement in the store WHILE the reviewer session runs. The run's own `ir`
        // object is untouched, so only a real store resolution can observe this move.
        wf.replace(planReviewIr({ irName: "current-plan-review-durable-replacement-mid-review" }));
        return { outcome: "success", value: "APPROVE" };
      },
    });

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.executeDispatches()).toBe(0);
    expect(result.context["node:plan-review:value"]).toBe("gate-stale-review-input");
    // Honest reviewer history: the genuine APPROVE row is persisted, carrying its PRE-replacement
    // captured pin — never re-derived from the definition that became current mid-attempt.
    const terminal = h.recorded.find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
    expect(terminal?.reviewedInputIdentity?.workflowPin.irHash).toBe(
      computeWorkflowIrPin(runIr, "plan-review").irHash,
    );
    expect(JSON.stringify(runIr)).toBe(runStartBytes);
  });

  it("PROD3. release refuses when the selected definition has been deleted from the store (unreadable current definition)", async () => {
    const reviewedDefinition = planReviewIr();
    const wf = productionWorkflowStore(structuredClone(reviewedDefinition));
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask({
      approvedPlanFingerprint: ANCHOR,
      workflowStepResults: [genuineRow(reviewedDefinition)],
    });
    // The definition row disappears — the real resolver degrades to the DEFAULT workflow, whose
    // pin cannot equal the captured pin. Refuse at the release boundary; never "assume unchanged".
    wf.replace(undefined);

    await h.run(task, planReviewIr(), REVISE);

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.executeDispatches()).toBe(0);
    expect(h.logs.some((line) => line.includes("Plan Review existing projection refused release"))).toBe(true);
  });

  it("PROD4. a transient failure of the durable selection read cannot release (unresolvable current definition refuses)", async () => {
    const reviewedDefinition = planReviewIr();
    const wf = productionWorkflowStore(structuredClone(reviewedDefinition));
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask({
      approvedPlanFingerprint: ANCHOR,
      workflowStepResults: [genuineRow(reviewedDefinition)],
    });
    // A throwing selection read resolves to the default workflow (core resolver's fail-soft
    // contract) — a different definition is a mismatch, and a mismatch refuses the release.
    wf.makeSelectionUnreadable();

    await h.run(task, planReviewIr(), REVISE);

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.executeDispatches()).toBe(0);
  });

  it("PROD5. a mid-review selection failure also blocks the fresh terminal path with honest APPROVE history", async () => {
    const runIr = planReviewIr();
    const runStartBytes = JSON.stringify(runIr);
    const wf = productionWorkflowStore(structuredClone(runIr));
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask();

    const result = await h.run(task, runIr, {
      reviewerResult: () => {
        // The definition cannot be resolved for currentness while the reviewer runs: an
        // unresolvable recompute after a successful capture is unprovable → block, not pass.
        wf.makeSelectionUnreadable();
        return { outcome: "success", value: "APPROVE" };
      },
    });

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.executeDispatches()).toBe(0);
    expect(result.context["node:plan-review:value"]).toBe("gate-stale-review-input");
    const terminal = h.recorded.find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
    expect(JSON.stringify(runIr)).toBe(runStartBytes);
  });
});

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-16:59:
Plan Review R3 — the DEFAULT-EQUALITY negatives and positives. The general core resolver is fail-soft: a
throwing selection read or a deleted/malformed selected definition SUBSTITUTES the default coding
IR, visible to callers only as its `.ir`. For a Plan Review bound to a default-equal workflow, that
substituted pin is IDENTICAL to the captured pin — so a read FAILURE would otherwise masquerade as
"still current". These cases run exclusively through the production adapter + real core resolver
and a default-equal captured identity, so the fail-open can only be closed by the strict
provenance classification (read SUCCESS = named selection read, or a SUCCESSFUL no-selection read;
read failure = unknown, blocks). Legitimate default/explicit steady states must still pass.
*/
describe("Plan Review default-equality currentness (Plan Review R3 fail-open closure)", () => {
  /** The default workflow's pin for the Plan Review gate — the identity a fail-soft substitution
   *  reproduces exactly, which is why custom-only cases cannot close R3. */
  const DEFAULT_PIN = computeWorkflowIrPin(resolveDefaultWorkflowIr(), "plan-review");

  it("PROD-D1. a genuine approval captured against the default workflow releases while the default stays readable", async () => {
    const wf = productionWorkflowStore(undefined, { absent: true });
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask({
      approvedPlanFingerprint: ANCHOR,
      workflowStepResults: [genuineRow(planReviewIr(), { reviewedInputIdentity: undefined, ...({}) })],
    });
    // The row's proof carries the DEFAULT pin (the reviewed workflow was the default workflow).
    task.workflowStepResults![0]!.reviewedInputIdentity = {
      planFingerprint: ANCHOR,
      workflowPin: DEFAULT_PIN,
      runAttemptId: "prior-episode-run",
      attemptStartedAt: task.workflowStepResults![0]!.startedAt!,
    };

    const result = await h.run(task, planReviewIr());

    // Steady-state positive: a SUCCESSFUL no-selection read (default authoritative) is never refused.
    expect(result.outcome).toBe("success");
    expect(h.reviewerDispatches()).toBe(0);
    expect(h.executeDispatches()).toBe(1);
  });

  it("PROD-D2. a genuine approval captured against the default workflow does NOT release when the selection read throws", async () => {
    const wf = productionWorkflowStore(undefined, { absent: true });
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask({
      approvedPlanFingerprint: ANCHOR,
      workflowStepResults: [genuineRow(planReviewIr())],
    });
    task.workflowStepResults![0]!.reviewedInputIdentity = {
      planFingerprint: ANCHOR,
      workflowPin: DEFAULT_PIN,
      runAttemptId: "prior-episode-run",
      attemptStartedAt: task.workflowStepResults![0]!.startedAt!,
    };
    // Read failure: the fail-soft substitution's pin would EQUAL the captured pin — equality from
    // an UNKNOWN read is not currentness. The release must refuse and a genuine review must run.
    wf.makeSelectionUnreadable();

    await h.run(task, planReviewIr(), REVISE);

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.executeDispatches()).toBe(0);
    expect(h.logs.some((line) => line.includes("current-workflow-unreadable"))).toBe(true);
  });

  it("PROD-D3. a fresh APPROVE with a default-equal captured identity blocks when the selection becomes unreadable mid-review", async () => {
    // Run the DEFAULT coding workflow itself (a fresh deep copy — a different object, identical
    // bytes) so the DISPATCH-CAPTURED pin genuinely equals the default pin: the substitution
    // equality this case must refuse is exactly the one the fail-soft resolver produces.
    const defaultDefinition = structuredClone(resolveDefaultWorkflowIr());
    const runStartBytes = JSON.stringify(defaultDefinition);
    const wf = productionWorkflowStore(structuredClone(defaultDefinition), { absent: true });
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask();

    const result = await h.run(task, defaultDefinition, {
      reviewerResult: () => {
        // Mid-reviewer, the CURRENT definition becomes unreadable. The fail-soft resolver would
        // substitute the default — pin-identical to the captured pin — so ONLY the strict
        // read-success contract can block here. Honest APPROVE history must survive.
        wf.makeSelectionUnreadable();
        return { outcome: "success", value: "APPROVE" };
      },
    });

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.executeDispatches()).toBe(0);
    expect(result.context["node:plan-review:value"]).toBe("gate-stale-review-input");
    const terminal = h.recorded.find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
    // The persisted proof keeps the PRE-failure captured pin — the default pin, captured while the
    // read still succeeded — never re-derived at terminal time.
    expect(terminal?.reviewedInputIdentity?.workflowPin.irHash).toBe(DEFAULT_PIN.irHash);
    expect(JSON.stringify(defaultDefinition)).toBe(runStartBytes);
  });

  it("PROD-D4. a fresh APPROVE on a default-equal workflow releases when the default stays readable (steady-state positive)", async () => {
    const defaultDefinition = structuredClone(resolveDefaultWorkflowIr());
    const wf = productionWorkflowStore(structuredClone(defaultDefinition), { absent: true });
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask();

    const result = await h.run(task, defaultDefinition, {
      reviewerResult: () => ({ outcome: "success", value: "APPROVE" }),
    });

    // Genuine review on the default workflow, currentness read SUCCESSFUL: the implementation
    // boundary OPENS. The stepwise default routes plan-review's success edge into the native
    // parse-steps node; this harness deliberately does not wire a step-source reader, so the run
    // terminates there with "parse-steps-unwired" — which proves traversal BEYOND plan-review.
    // A stale fence would have blocked AT plan-review ("gate-stale-review-input" — D3's shape),
    // so reaching parse at all, with no stale value set, is exactly the release this case proves.
    // The released value is the genuine APPROVE verdict itself; a stale fence would instead have
    // set "gate-stale-review-input" and stopped the graph AT plan-review (D3's shape).
    expect(h.reviewerDispatches()).toBe(1);
    expect(result.context["node:plan-review:outcome"]).toBe("success");
    expect(result.context["node:plan-review:value"]).toBe("APPROVE");
    expect(result.context["node:parse:outcome"]).toBe("failure");
    expect(result.context["node:parse:value"]).toBe("parse-steps-unwired");
    const terminal = h.recorded.find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
  });

  it("PROD-D5. a selected definition whose valid IR equals the default, deleted from the store, refuses release", async () => {
    // EXPLICIT selection of a custom workflow id whose stored definition is a VALID IR equal to
    // the built-in default. Read success = source "selection" (never refused for content).
    const wf = productionWorkflowStore(structuredClone(resolveDefaultWorkflowIr()));
    const h = harness({ artifact: PLAN, productionWorkflowStore: wf.store });
    const task = baseTask({
      approvedPlanFingerprint: ANCHOR,
      workflowStepResults: [genuineRow(planReviewIr())],
    });
    task.workflowStepResults![0]!.reviewedInputIdentity = {
      planFingerprint: ANCHOR,
      workflowPin: DEFAULT_PIN,
      runAttemptId: "prior-episode-run",
      attemptStartedAt: task.workflowStepResults![0]!.startedAt!,
    };
    // The selected definition is then DELETED: the resolver substitutes the default (pin-identical
    // to the captured pin) but the selection was NOT absent — a failed read, unknown currentness.
    wf.replace(undefined);

    await h.run(task, planReviewIr(), REVISE);

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.executeDispatches()).toBe(0);
    expect(h.logs.some((line) => line.includes("current-workflow-unreadable"))).toBe(true);
  });
});

/*
FNXC:CurrentPlanReviewIdentity 2026-10-11-19:55:
Plan Review anchor-refusal race (review validation, Code Review finding `anchor-refusal-race-narrow`) — the
persistence receipt's `disposition: "applied"` ONLY describes the ROW write. When the anchor
authority REFUSES the Plan Review SATISFIED APPLICATION (outer proof unvalidatable, or a
competing reclaim wins the fenced apply-check), the genuine passed row may still persist as
honest history — but the fresh graph admission must treat the refusal as blocking, and a later
successful graph-side read in the SAME run may never erase it. These cases drive the REAL graph
executor with the REAL `persistWorkflowStepResultWithOutcome` production adapter as the
persistence sink (never a preprogrammed recorder receipt) through the REAL core resolver; the
refused window is a single deterministic durable selection read. Genuine APPROVE verdict,
original times and dispatch-captured proof must survive unchanged as evidence.
*/
interface ProductionSinkRunOpts {
  reviewerResult?: () => { outcome: "success"; value?: string; contextPatch?: Record<string, unknown> };
  /** Throw exactly this many CURRENTNESS selection reads from the start of the run. 1 fails ONLY
   *  the anchor application's resolve (the graph entry refuses with zero candidates before any
   *  read, and the graph's post-write re-read is the next read) — the deterministic race window. */
  failCurrentnessReads?: number;
  /** Fires inside the REAL fenced writer immediately before its apply compute — the exact
   *  window a competing reclaim wins in production. */
  applyBoundaryHook?: () => void;
}

function productionSinkHarness(opts: { artifact?: string; approvedPlanFingerprint?: string; builtinOverrides?: Record<string, string> }) {
  let artifact: string | undefined = opts.artifact;
  let failCurrentnessReads = 0;
  let applyBoundaryHook: (() => void) | undefined;
  const visits: string[] = [];
  const logs: string[] = [];
  const specLockCalls: string[] = [];
  const reconcileCalls: string[] = [];

  // One live task row; the store mutates it under the writer tiers, exactly as the graph sees it.
  const task = baseTask({ approvedPlanFingerprint: opts.approvedPlanFingerprint });

  // What the durable selection resolves to. Set by run() to EXACTLY the run's IR bytes — a
  // read SUCCESS whose pin equals the dispatch-captured pin, so every refusal these cases prove
  // is about the REFUSED application, never about an unrelated identity mismatch.
  let resolvedDefinition: WorkflowIr = planReviewIr();

  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<TaskDetail>) => {
      Object.assign(task, patch);
      return task;
    }),
    // The production fenced tier: re-enters the caller's compute AFTER a boundary hook models the
    // reclaim that lands between the outer lifecycle-lock read and the final apply-check.
    updateWorkflowStepResultsFenced: vi.fn(async (_id: string, compute: (current: TaskDetail) => Partial<TaskDetail> | null) => {
      applyBoundaryHook?.();
      const patch = compute(task);
      if (!patch) return { applied: false, reason: "refused" } as const;
      Object.assign(task, patch);
      return { applied: true, task };
    }),
    isBackendMode: vi.fn(() => true),
    withPlanningLifecycleLock: vi.fn(async (_id: string, cb: () => Promise<void>) => {
      await cb();
    }),
    lockCurrentPlanWhilePlanningLocked: vi.fn(async () => {
      specLockCalls.push(task.id);
    }),
    reconcileSpecDriftWhilePlanningLocked: vi.fn(async () => {
      reconcileCalls.push(task.id);
    }),
    recordAgentActivity: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "wf-current-plan-review-current" ? { ir: resolvedDefinition } : undefined)),
    getWorkflowSettingsProjectId: () => "review-fixture",
    getWorkflowPromptOverridesAsync: async () => opts.builtinOverrides ?? {},
  };
  Object.defineProperty(store, "getTaskWorkflowSelectionAsync", {
    configurable: true,
    get: () => async () => {
      if (failCurrentnessReads > 0) {
        failCurrentnessReads -= 1;
        throw new Error("transient durable selection read failure");
      }
      return { workflowId: opts.builtinOverrides ? "builtin:legacy-coding" : "wf-current-plan-review-current", stepIds: [] };
    },
  });

  const persistDeps = {
    store,
    getRunContextFor: () => undefined,
    readTaskArtifact: async () => artifact,
  };

  let reviewerResult: () => { outcome: "success"; value?: string; contextPatch?: Record<string, unknown> } =
    () => ({ outcome: "success", value: "APPROVE" });

  const handler: WorkflowNodeHandler = async (node) => {
    visits.push(node.id);
    if (node.id === "plan-review-step") return reviewerResult();
    return { outcome: "success" };
  };

  const executor = new WorkflowGraphExecutor({
    handlers: { prompt: handler },
    runId: "run-under-test",
    logTaskEntry: (msg: string) => {
      logs.push(msg);
    },
    // THE production adapter — the same wiring executeWorkflowGraph performs in live execution.
    recordWorkflowStepResult: (taskId, result, fence) =>
      persistWorkflowStepResultWithOutcome(persistDeps as never, taskId, result, fence as never),
    discardWorkflowStepLease: (taskId, workflowStepId, startedAt) =>
      discardWorkflowStepLease(persistDeps as never, taskId, workflowStepId, startedAt),
    // The real executor-adapter reader over the SAME durable store production shares between the
    // graph boundary and the anchor seam.
    primitives: withPlanReviewCurrentWorkflowReader(
      { readArtifact: async () => artifact } as unknown as WorkflowRuntimePrimitives,
      store as never,
    ),
  } as ConstructorParameters<typeof WorkflowGraphExecutor>[0]);

  return {
    runBuiltin: async () => {
      const seam = async () => ({ outcome: "success" as const });
      const runner = new WorkflowGraphTaskRunner({
        store: { ...store, getTaskWorkflowSelection: () => ({ workflowId: "builtin:legacy-coding", stepIds: [] }) } as never,
        seams: { planning: seam, execute: seam, review: seam, merge: seam, schedule: seam },
        runCustomNode: handler,
        primitives: withPlanReviewCurrentWorkflowReader({ readArtifact: async () => artifact } as unknown as WorkflowRuntimePrimitives, store as never),
        recordWorkflowStepResult: (taskId, result, fence) => persistWorkflowStepResultWithOutcome(persistDeps as never, taskId, result, fence as never),
      });
      reviewerResult = () => { vi.advanceTimersByTime(5000); return { outcome: "success", value: "APPROVE" }; };
      return runner.run(task, settingsOn(), "plan-review");
    },
    task,
    visits,
    logs,
    specLockCalls,
    reconcileCalls,
    rows: () => task.workflowStepResults ?? [],
    reviewerDispatches: () => visits.filter((id) => id === "plan-review-step").length,
    executeDispatches: () => visits.filter((id) => id === "execute").length,
    run: async (ir: WorkflowIr, runOpts?: ProductionSinkRunOpts) => {
      resolvedDefinition = ir;
      if (runOpts?.reviewerResult) reviewerResult = runOpts.reviewerResult;
      failCurrentnessReads = runOpts?.failCurrentnessReads ?? 0;
      applyBoundaryHook = runOpts?.applyBoundaryHook;
      return await executor.run(task, settingsOn(), ir) as unknown as {
        outcome: string;
        value?: string;
        context: Record<string, unknown>;
      };
    },
  };
}

describe("Plan Review refused satisfied application blocks the fresh graph admission (Plan Review anchor-refusal race)", () => {
  // Genuine attempt times come from the graph's own `new Date()` stamps; a deterministically
  // advanced clock keeps startedAt and completedAt distinct without wall-clock flakiness, while
  // every timer OTHER than Date stays real so the run's awaits behave normally.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T16:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("RACE1. an UNKNOWN anchor-application read cannot be laundered by the later successful graph re-read", async () => {
    const runIr = planReviewIr();
    const runStartBytes = JSON.stringify(runIr);
    const h = productionSinkHarness({ artifact: PLAN });

    const result = await h.run(runIr, {
      // The genuine reviewer APPROVEs 5s into the attempt — honest distinct original times.
      reviewerResult: () => {
        vi.advanceTimersByTime(5000);
        return { outcome: "success", value: "APPROVE" };
      },
      // ONLY the anchor application's currentness read is refused; the graph's post-write
      // re-read (the next durable read) succeeds with identical bytes.
      failCurrentnessReads: 1,
    });

    expect(h.reviewerDispatches()).toBe(1);
    // RED at cacf1332 before the fix: the refused satisfied application rode a plain
    // "applied" receipt and the graph walked straight into implementation.
    expect(h.executeDispatches()).toBe(0);
    expect(result.context["node:plan-review:value"]).toBe("gate-unproven-plan-review-input");
    // The genuine reviewer evidence persists UNCHANGED as honest history…
    const terminal = h.rows().find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
    expect(terminal?.startedAt).toBe("2026-10-11T16:00:00.000Z");
    expect(terminal?.completedAt).toBe("2026-10-11T16:00:05.000Z");
    expect(terminal?.reviewedInputIdentity?.planFingerprint).toBe(PLAN_FP);
    expect(terminal?.reviewedInputIdentity?.workflowPin).toEqual(computeWorkflowIrPin(runIr, "plan-review"));
    // …but NO satisfied approval was stamped, NO spec lock was taken (the outer proof itself
    // refused), and NO drift reconciliation ran.
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.specLockCalls).toHaveLength(0);
    expect(h.reconcileCalls).toHaveLength(0);
    expect(h.logs.some((line) => line.includes("anchor-proof-refused") && line.includes("gate-unproven-plan-review-input"))).toBe(true);
    // The refusal came from the durable read, never from object mutation.
    expect(JSON.stringify(runIr)).toBe(runStartBytes);
  });

  it("RACE2. ownership lost at the fenced apply-check also cannot release implementation", async () => {
    const runIr = planReviewIr();
    const h = productionSinkHarness({ artifact: PLAN });

    const result = await h.run(runIr, {
      reviewerResult: () => {
        vi.advanceTimersByTime(5000);
        return { outcome: "success", value: "APPROVE" };
      },
      // A competing reclaim wins the window between the outer lifecycle-lock read (ownership
      // proven, spec lock allowed) and the final fenced apply-check (ownership re-validated).
      applyBoundaryHook: () => {
        const lease = (h.task.workflowStepResults ?? []).find((row) => row.workflowStepId === "plan-review" && row.status === "pending");
        if (lease) lease.leaseOwner = "peer-reclaimer";
      },
    });

    expect(h.reviewerDispatches()).toBe(1);
    expect(h.executeDispatches()).toBe(0);
    expect(result.context["node:plan-review:value"]).toBe("gate-unproven-plan-review-input");
    const terminal = h.rows().find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
    expect(terminal?.reviewedInputIdentity?.planFingerprint).toBe(PLAN_FP);
    // Bounded documented behavior: the OUTER proof already permitted the spec lock in this
    // interleaving; only the final anchor stamp and drift reconciliation are withheld.
    expect(h.specLockCalls).toHaveLength(1);
    expect(h.task.approvedPlanFingerprint).toBeUndefined();
    expect(h.reconcileCalls).toHaveLength(0);
    expect(h.logs.some((line) => line.includes("apply-check-ownership-lost") && line.includes("gate-unproven-plan-review-input"))).toBe(true);
  });


  it.each(["outer-proof", "apply-ownership"] as const)("a refused %s application with a retained anchor requires review again after recovery", async (refusal) => {
    const ir = planReviewIr();
    const h = productionSinkHarness({ artifact: PLAN, approvedPlanFingerprint: PLAN_FP });
    await h.run(ir, {
      reviewerResult: () => {
        vi.advanceTimersByTime(5000);
        return { outcome: "success", value: "APPROVE" };
      },
      ...(refusal === "outer-proof" ? { failCurrentnessReads: 1 } : {
        applyBoundaryHook: () => {
          const lease = h.rows().find((row) => row.status === "pending");
          if (lease) lease.leaseOwner = "peer-reclaimer";
        },
      }),
    });
    expect(h.executeDispatches()).toBe(0);
    expect(h.task.approvedPlanFingerprint).toBe(PLAN_FP);
    expect(h.rows()[0]?.verdict).toBe("APPROVE");
    expect(h.rows()[0]?.planReviewApprovalRefused).toBe(true);
    expect(h.rows()[0]?.reviewedInputIdentity?.workflowPin).toEqual(computeWorkflowIrPin(ir, "plan-review"));

    vi.advanceTimersByTime(5000);
    await h.run(ir, {
      reviewerResult: () => {
        vi.advanceTimersByTime(5000);
        return { outcome: "failure", value: "REVISE" };
      },
    });
    expect(h.reviewerDispatches()).toBe(2);
    expect(h.executeDispatches()).toBe(0);

    vi.advanceTimersByTime(5000);
    await h.run(ir, {
      reviewerResult: () => {
        vi.advanceTimersByTime(5000);
        return { outcome: "success", value: "APPROVE" };
      },
    });
    expect(h.reviewerDispatches()).toBe(3);
    expect(h.executeDispatches()).toBe(1);
    expect(h.rows()[0]?.planReviewApprovalRefused).toBeUndefined();
  });


  it.each(["planning", "execute"])("built-in %s prompt override uses one effective IR for dispatch and approval", async (nodeId) => {
    const overrides = { [nodeId]: "Saved prompt override for " + nodeId };
    const h = productionSinkHarness({ artifact: PLAN, builtinOverrides: overrides });
    const result = await h.runBuiltin();
    expect(result.reason).toBeUndefined();
    expect(result.context?.["node:plan-review:outcome"]).toBe("success");
    expect(result.context?.["node:plan-review:value"]).toBe("APPROVE");
    expect(h.task.approvedPlanFingerprint).toBe(PLAN_FP);
    expect(h.reconcileCalls).toHaveLength(1);
    const row = h.rows().find((entry) => entry.workflowStepId === "plan-review");
    const effective = applyPromptOverridesToIr(getBuiltinWorkflow("builtin:legacy-coding")!.ir as WorkflowIr, overrides);
    expect(row?.reviewedInputIdentity?.workflowPin).toEqual(computeWorkflowIrPin(effective, "plan-review"));
  });

  it("RACE3. genuine complete current approval still releases through the same real adapter (control)", async () => {
    const runIr = planReviewIr();
    const h = productionSinkHarness({ artifact: PLAN });

    const result = await h.run(runIr, {
      reviewerResult: () => {
        vi.advanceTimersByTime(5000);
        return { outcome: "success", value: "APPROVE" };
      },
    });

    // Steady-state positive: nothing was refused — anchor + satisfied row landed, implementation
    // opens, and the honest original times/proof survive untouched.
    expect(h.reviewerDispatches()).toBe(1);
    expect(h.executeDispatches()).toBe(1);
    expect(result.context["node:plan-review:outcome"]).toBe("success");
    expect(h.task.approvedPlanFingerprint).toBe(PLAN_FP);
    expect(h.specLockCalls).toHaveLength(1);
    expect(h.reconcileCalls).toHaveLength(1);
    const terminal = h.rows().find((row) => row.workflowStepId === "plan-review" && row.status === "passed");
    expect(terminal?.verdict).toBe("APPROVE");
    expect(terminal?.startedAt).toBe("2026-10-11T16:00:00.000Z");
    expect(terminal?.completedAt).toBe("2026-10-11T16:00:05.000Z");
    expect(terminal?.reviewedInputIdentity?.workflowPin).toEqual(computeWorkflowIrPin(runIr, "plan-review"));
  });
});
