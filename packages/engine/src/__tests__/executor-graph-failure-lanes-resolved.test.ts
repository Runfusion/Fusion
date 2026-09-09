/*
FNXC:WorkflowLifecycleColumns 2026-08-01-08:10 (fleet: executor.ts graph-failure recovery family):

THE INVARIANT: every lifecycle question the graph-failure recovery family asks is answered from the
task's OWN workflow, and the halves of one decision answer it from ONE snapshot.

Two of the conversions in this family fix behaviour rather than vocabulary, and both are the
half-conversion shape — a gate that reads the wrong board is not merely inert, it ADMITS work the
gate existed to refuse:

  1. `isReentrantPausedAbortedInFlightNode` resolved lanes at the END, for its return value, while its
     four `in-review` eligibility gates were literals. On a renamed board those gates all read false,
     so a card in review skipped the global-pause recheck, the `autoMerge === false` refusal, the
     shared-branch-member arbitration and the merge-confirmed refusal — and then the lane-resolved
     final line answered "re-entrant". FN-7214's own comment says an auto-merge-off review row must
     stay terminal, so this was the documented invariant failing silently on any renamed board.

  2. `routeUnusableWorktreeGraphFailureToRecovery` asked "already finished?" and "in review?" as three
     literals. On a renamed board it read not-finished AND not-in-review, so recovery proceeded with
     the FN-5147 gate skipped: an automatic recovery moving a human-review-terminal card backward.

WHY THE RENAMED BOARD IS THE FIXTURE. On the default lineage every one of these guards is correct by
coincidence — the literals ARE the board. A test on the default board passes before and after the
change and proves nothing, which is how this class of defect survived every previous suite.

REVERT PROOF, measured: restore either literal and the matching case here fails (`autoMerge:false`
review row is admitted as re-entrant; the finished card is admitted into worktree recovery).
*/
import { describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { WorkflowIr } from "@fusion/core";

/** A board whose lifecycle columns share NO id with the default lineage. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function harness(ir: WorkflowIr | undefined, task: Record<string, unknown>, settingsOverride: Record<string, unknown> = {}) {
  const store = createMockStore();
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const widened = store as unknown as Record<string, unknown>;
  widened.getTaskWorkflowSelection = () => (ir ? selection : undefined);
  widened.getTaskWorkflowSelectionAsync = async () => (ir ? selection : undefined);
  widened.getWorkflowDefinition = async () => (ir ? { ir } : undefined);
  widened.getTask = async () => task;
  widened.getSettings = async () => ({ maxConcurrent: 4, maxWorktrees: 4, pollIntervalMs: 1000, autoMerge: true, globalPause: false, enginePaused: false, ...settingsOverride });
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);

  const executor = new TaskExecutor(store as never, "/repo");
  return { store, executor };
}

const pauseAbortResult = {
  interruptedAbortKind: "engine-pause",
  interruptedNodeId: "execute",
  visitedNodeIds: ["execute"],
  context: {},
} as never;

function reentrant(executor: TaskExecutor, live: unknown): Promise<boolean> {
  return (executor as unknown as {
    isReentrantPausedAbortedInFlightNode: (
      live: unknown, result: unknown, provenance: string, pausedAborted: boolean, userCanceled: boolean,
    ) => Promise<boolean>;
  }).isReentrantPausedAbortedInFlightNode(live, pauseAbortResult, "engine-abort", true, false);
}

describe("FN-7214: an auto-merge-off review row stays terminal on a RENAMED board", () => {
  it("refuses re-entry for a review-lane card with autoMerge:false", async () => {
    /*
    The measured pre-fix behaviour: the four `in-review` gates compared against the literal, `checking`
    is not `in-review`, so every refusal was skipped — and the final lane-resolved line then matched
    `resumeLanes.review` and returned TRUE. The card was re-entered behind a human review gate.
    */
    const live = { id: "FN-1", column: "checking", autoMerge: false, graphResumeRetryCount: 0 };
    const { executor } = harness(RENAMED_IR, live);

    expect(await reentrant(executor, live)).toBe(false);
  });

  it("still admits a review-lane card whose auto-merge is ON, so the fix is not 'refuse review rows'", async () => {
    // The paired positive. A gate that returns false unconditionally would pass the case above.
    const live = { id: "FN-2", column: "checking", autoMerge: true, graphResumeRetryCount: 0 };
    const { executor } = harness(RENAMED_IR, live);

    expect(await reentrant(executor, live)).toBe(true);
  });

  it("keeps the same answers on the DEFAULT board, where the literals happened to be right", async () => {
    // The conversion must not change behaviour where the old spelling was already correct.
    const offLive = { id: "FN-3", column: "in-review", autoMerge: false, graphResumeRetryCount: 0 };
    const onLive = { id: "FN-4", column: "in-review", autoMerge: true, graphResumeRetryCount: 0 };

    expect(await reentrant(harness(undefined, offLive).executor, offLive)).toBe(false);
    expect(await reentrant(harness(undefined, onLive).executor, onLive)).toBe(true);
  });

  it("refuses a card in the board's COMPLETE column — and this one passes either way", async () => {
    /*
    HONEST LABEL, because I checked: reverting the terminal-pair literal here does NOT redden this case.
    The method's final line already answers "is the card in a resume lane", and `shipped` is not one, so
    the terminal guard is redundant *in this method*. Kept as the paired negative — it pins that a
    finished card is refused however the refusal is reached — but it is not evidence for the conversion.
    The terminal conversions that DO change behaviour are proven in the worktree-recovery block below.
    */
    const live = { id: "FN-5", column: "shipped", autoMerge: true, graphResumeRetryCount: 0 };
    const { executor } = harness(RENAMED_IR, live);

    expect(await reentrant(executor, live)).toBe(false);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-01-08:40:
ASSERT THE CALL, NOT THE RETURN VALUE. My first version of this block asserted
`routeUnusableWorktreeGraphFailureToRecovery(...) === false` and passed with the literals restored —
the pre-fix path ran the whole recovery and then returned false for an unrelated reason (the mock's
outcome is not `requeue-todo`). A revert check that stays green is the signal I keep re-learning to
respect: the assertion was not touching the behaviour it claimed to cover.

Spying on `recoverMissingWorktreeSessionStartFailure` asks the question the guard actually decides —
was recovery ATTEMPTED on this card? — and it discriminates in both directions.
*/
describe("FN-5147: unusable-worktree recovery does not run on a finished or human-review card (RENAMED board)", () => {
  const SESSION_FAILURE = "Refusing to start coding agent in missing worktree: /gone";

  function harnessWithSpy(live: Record<string, unknown>, settingsOverride: Record<string, unknown> = {}) {
    const { executor, store } = harness(RENAMED_IR, live, settingsOverride);
    const recover = vi.fn().mockResolvedValue("requeue-todo");
    (executor as unknown as Record<string, unknown>).recoverMissingWorktreeSessionStartFailure = recover;
    return { executor, store, recover };
  }

  function route(executor: TaskExecutor, live: Record<string, unknown>): Promise<boolean> {
    return (executor as unknown as {
      routeUnusableWorktreeGraphFailureToRecovery: (task: unknown, live: unknown, result: unknown) => Promise<boolean>;
    }).routeUnusableWorktreeGraphFailureToRecovery({ id: live.id }, live, {
      context: { "node:execute:error": SESSION_FAILURE },
      visitedNodeIds: ["execute"],
    });
  }

  it("does not attempt recovery for a card in the board's COMPLETE column", async () => {
    // Pre-fix: `shipped` is neither `done` nor `archived`, so recovery ran on a finished card.
    const live = { id: "FN-7", column: "shipped", worktree: "/gone" };
    const { executor, recover } = harnessWithSpy(live);

    expect(await route(executor, live)).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });


  it("applies the FN-5147 auto-merge gate to the board's REVIEW lane", async () => {
    /*
    The half-conversion in its most consequential form: pre-fix the `in-review` literal did not match
    `checking`, so the auto-merge-off refusal never ran and an automatic recovery moved a
    human-review-terminal card backward. `allowsAutoMergeProcessing` is what must be consulted, and it
    can only be reached once the review lane is resolved.
    */
    /*
    THE GATE KEYS ON THE GLOBAL SETTING, not on `task.autoMerge`: `allowsAutoMergeProcessing` is
    `(settings.autoMerge !== false || task.autoMerge === true) && no manual open PR`. My first fixture
    set only `task.autoMerge: false` and the case failed — the recovery ran, correctly, because a
    per-task false does not withdraw a card from automatic processing. Correcting the fixture rather
    than the assertion: FN-5147 is about the OPERATOR turning auto-merge off for the project.
    */
    const live = { id: "FN-9", column: "checking", worktree: "/gone" };
    const { executor, recover } = harnessWithSpy(live, { autoMerge: false });

    expect(await route(executor, live)).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it("STILL recovers a wip-lane card, so the fix is not 'never recover'", async () => {
    // The paired positive: the guards above must not have turned the recovery path off wholesale.
    const live = { id: "FN-10", column: "building", worktree: "/gone" };
    const { executor, recover } = harnessWithSpy(live);

    expect(await route(executor, live)).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-01-10:30 (fleet: executor.ts wip-lane liveness family):

THE INVARIANT: "is this card still executing?" is the board's WIP lane.

TWO DIRECTIONS, and this is why the family is converted per method rather than by matching the text.
Most of these guards read `column !== "in-progress"` and REFUSE when they do not match, so a renamed
board silently disabled them (the completion handoff was deferred on every card, the deferred
approval resume never resumed, the completed-task watchdog returned on every tick). But the rerun
watchdog reads `column === "in-progress"` and SKIPS when it matches — so on a renamed board that one
never skipped, and a rerun could fire on a card that was still mid-execution. A mechanical swap of
every `!== "in-progress"` would have converted the refusals and left the admission.

`resumeApprovalAfterUnwindIfNeeded` is the case pinned here: it is a private method with a single
boolean answer and no side effects on the refusal path, so the assertion is direct.
*/
describe("the wip-lane liveness family resolves the board's own wip column", () => {
  function resumeApproval(executor: TaskExecutor, taskId: string): Promise<boolean> {
    return (executor as unknown as {
      resumeApprovalAfterUnwindIfNeeded: (id: string) => Promise<boolean>;
    }).resumeApprovalAfterUnwindIfNeeded(taskId);
  }

  function armed(live: Record<string, unknown>, ir: WorkflowIr | undefined) {
    const { executor, store } = harness(ir, live);
    // The deferral marker this method consumes, plus a stub for the dispatch it guards.
    (executor as unknown as { approvalResumeAfterUnwind: Set<string> }).approvalResumeAfterUnwind.add(live.id as string);
    const dispatch = vi.fn().mockResolvedValue(true);
    (executor as unknown as Record<string, unknown>).dispatchUnpauseResume = dispatch;
    return { executor, store, dispatch };
  }

  it("resumes a deferred approval for a card in the board's wip lane", async () => {
    // Pre-fix: `building` !== "in-progress", so the resume refused on every renamed board.
    const live = { id: "FN-11", column: "building" };
    const { executor, dispatch } = armed(live, RENAMED_IR);

    expect(await resumeApproval(executor, "FN-11")).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("still refuses a card that has LEFT the wip lane", async () => {
    // The paired negative: the fix must not resume work on a card that moved on.
    const live = { id: "FN-12", column: "checking" };
    const { executor, dispatch } = armed(live, RENAMED_IR);

    expect(await resumeApproval(executor, "FN-12")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still refuses a PAUSED card in the wip lane, so the lane is not the only gate", async () => {
    const live = { id: "FN-13", column: "building", paused: true };
    const { executor, dispatch } = armed(live, RENAMED_IR);

    expect(await resumeApproval(executor, "FN-13")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("behaves identically on the DEFAULT board", async () => {
    const live = { id: "FN-14", column: "in-progress" };
    const { executor, dispatch } = armed(live, undefined);

    expect(await resumeApproval(executor, "FN-14")).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-01-11:20 (fleet: executor.ts review-lane family):

THE INVARIANT: "is this card in review?" is the board's review lane.

`finalizeAlreadyReviewedTask` is the case pinned here because its failure is the loudest: it returns
"missing" — a word that reads as "the task is gone" — for a card that is sitting in review on a
renamed board. Everything downstream of the already-reviewed finalize path was therefore dead on any
board that renamed its merge lane, and the log line said the task could not be found.
*/
describe("the review-lane family resolves the board's own review column", () => {
  function finalizeAlreadyReviewed(executor: TaskExecutor, taskId: string): Promise<string> {
    return (executor as unknown as {
      finalizeAlreadyReviewedTask: (id: string) => Promise<string>;
    }).finalizeAlreadyReviewedTask(taskId);
  }

  it("does not report a review-lane card as MISSING", async () => {
    // Pre-fix: `checking` !== "in-review", so this returned "missing" for a card plainly in review.
    const live = { id: "FN-15", column: "checking", steps: [], workflowStepResults: [] };
    const { executor } = harness(RENAMED_IR, live);

    expect(await finalizeAlreadyReviewed(executor, "FN-15")).not.toBe("missing");
  });

  it("still reports a card OUTSIDE the review lane as missing", async () => {
    // The paired negative: the guard must still refuse a card that is not in review at all.
    const live = { id: "FN-16", column: "building", steps: [], workflowStepResults: [] };
    const { executor } = harness(RENAMED_IR, live);

    expect(await finalizeAlreadyReviewed(executor, "FN-16")).toBe("missing");
  });

  it("behaves identically on the DEFAULT board", async () => {
    const live = { id: "FN-17", column: "in-review", steps: [], workflowStepResults: [] };
    const { executor } = harness(undefined, live);

    expect(await finalizeAlreadyReviewed(executor, "FN-17")).not.toBe("missing");
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-01-13:30 (fleet: executor.ts — the REVERSE half-conversion):

`routeGraphFailureToExecutionResume` resolves the task's workflow before deciding whether an
implementation-incomplete failure can resume. Lifecycle containment now permits only a WIP card to
resume in place; review, hold, intake, and terminal cards remain where they are. The renamed-board
fixtures ensure both that the WIP role is resolved correctly and that no default-id comparison can
silently grant a backward move.
*/
describe("the execution-resume router's gate reads the same board as its destination", () => {
  function routeResume(executor: TaskExecutor, live: Record<string, unknown>, failureValue: string): Promise<boolean> {
    return (executor as unknown as {
      routeGraphFailureToExecutionResume: (live: unknown, failedNode: string, failureValue: string) => Promise<boolean>;
    }).routeGraphFailureToExecutionResume(live, "merge", failureValue);
  }

  const withIncompleteSteps = (column: string, id: string) => ({
    id, column, worktree: "/wt", steps: [{ name: "s", status: "pending" }], workflowStepResults: [],
  });

  it("contains a review-lane graph failure in place", async () => {
    const live = withIncompleteSteps("checking", "FN-18");
    const { executor } = harness(RENAMED_IR, live);

    expect(await routeResume(executor, live, "other")).toBe(false);
  });

  it("contains a HOLD-lane graph failure in place even with unfinished steps", async () => {
    const live = withIncompleteSteps("queued", "FN-19");
    const { executor } = harness(RENAMED_IR, live);

    expect(await routeResume(executor, live, "other")).toBe(false);
  });

  it("admits a WIP-lane card after a premature merge attempt", async () => {
    // The third shape: implementation-incomplete merge failure with steps still open.
    const live = withIncompleteSteps("building", "FN-20");
    const { executor } = harness(RENAMED_IR, live);

    expect(await routeResume(executor, live, "implementation-incomplete")).toBe(true);
  });

  it("still REFUSES a card in the intake lane, which is none of the three shapes", async () => {
    const live = withIncompleteSteps("backlog", "FN-21");
    const { executor } = harness(RENAMED_IR, live);

    expect(await routeResume(executor, live, "other")).toBe(false);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-01-20:50 (PR #2703 review — greptile P1, the sync-resolver no-op):

THE INVARIANT: no lifecycle guard in this file resolves its lane through the SYNCHRONOUS resolver.

`resolvePlannerLanes` reads `store.resolveTaskWorkflowIrSync`, whose selection reader returns `undefined`
unconditionally in PostgreSQL mode — the shipped backend. So a sync-resolved guard silently answers with
the DEFAULT workflow's ids on every real board: the census counts the site as converted, `--strict` drops
by one, and the behaviour is identical to the literal. That is worse than an unconverted literal, because
the number claims the site is done.

This is a STRUCTURAL assertion rather than a behavioural one, and deliberately so. A behavioural test
would need a PostgreSQL-backed store to demonstrate the no-op, and the thing worth preventing is not one
guard misbehaving — it is the pattern being reintroduced anywhere in this file by someone who reads
"synchronous classifier" and reaches for the synchronous resolver, exactly as I did.

The two legitimate `resolvePlannerLanes` call sites are MOVE destinations (`PlannerLanes` exists so a
caller refuses rather than inventing a column), which is a different question from "which lane is this
card in" and is why they are allowlisted here by name.
*/
describe("no lifecycle GUARD resolves its lane synchronously", () => {
  it("keeps resolvePlannerLanes out of column-comparison guards in executor.ts", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../executor.ts", import.meta.url), "utf8");

    /* Strip block comments: the notes explaining WHY the sync resolver is unsafe mention it by name. */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const callSites = [...code.matchAll(/resolvePlannerLanes\s*\(/g)].length;

    /*
    A CEILING, not an equality.

    The invariant this guard exists for is one-directional: no NEW synchronous resolution may appear.
    Removing one is always safe — it is the fix this test is trying to encourage — so an exact count
    fails on exactly the change it wants. That is what happened: #2764 converted the promotion-path
    site to `resolvePlannerLanesForTaskAsync`, the count went 3 -> 2, and a correct improvement
    landed as a red test on main with nothing wrong in the product.

    What remains are the two planner-column move destinations documented above (`PlannerLanes` exists
    so a caller refuses rather than inventing a column), which is a different question from "which
    lane is this card in". A THIRD is a new sync resolution and must be justified — if it is a guard,
    it is a no-op on PostgreSQL and the census will claim it is converted.
    */
    expect(callSites).toBeLessThanOrEqual(2);
  });

  it("does not compare a column against a synchronously-resolved lane on the same line", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../executor.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // The shape this guards against: `x.column === resolvePlannerLanes(...).review`.
    const inlineGuards = [...code.matchAll(/\.column\s*[!=]==\s*resolvePlannerLanes/g)];

    expect(inlineGuards).toEqual([]);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-04:30 (PR #2703 review — coderabbit MAJOR, and it is my own rule
turned back on me):

THE INVARIANT: every classifier in one recovery shares ONE lane snapshot.

`isBenignInReviewPauseAbort` takes its review lane as a parameter precisely because a fresh resolution
inside a classifier can disagree with the snapshot the rest of `handleGraphFailure` uses. Four sibling
classifiers were still calling `resolveResumeLanes()` with no memo — so a workflow edit landing mid-recovery
could have one classifier admit a card on the new board while another rejects it on the old one, and the
recovery would take a branch neither board justifies.

STRUCTURAL, because the race needs a workflow edit between two awaits inside one call — reproducible only
by instrumenting the resolver, which would pin the implementation rather than the rule. Counting
memo-less calls in the pause-abort family is the property that actually has to hold, and it fails the
moment someone adds a fifth classifier that resolves on its own.
*/
describe("one lane snapshot per recovery, across every classifier", () => {
  const MEMO_THREADED = [
    "isRetryableBenignMergePauseAbort",
    "isBenignManualMergeHoldPauseAbort",
    "handleStaleInReviewPlanPauseAbortReplay",
    "handleStaleInReviewParsePauseAbortReplay",
    "isReentrantPausedAbortedInFlightNode",
    "routeUnusableWorktreeGraphFailureToRecovery",
    "routeGraphFailureToExecutionResume",
  ];
  /* Methods that own their own recovery: no caller memo to share, so the FIRST resolution is correct and a
     SECOND is the split. `handleNonContinuableSessionError` was added here after exactly that defect
     (PR #2703 review) — its eligibility check and its review branch each resolved independently. */
  const SELF_CONTAINED = ["handleNonContinuableSessionError"];

  /*
  FNXC:CodeOrganization 2026-08-15-19:10 (executor peels):
  Every classifier moved out of the TaskExecutor class body into its own executor/ free-function
  module (`export async function <name>(`). The scan follows the peel: find the one module that
  declares the function and bound its body by the next top-level `export` declaration — the same
  wrong-window hazard the `private ` bound guarded against, now at module granularity.
  */
  const CLASSIFIER_MODULES: Record<string, string> = {
    isRetryableBenignMergePauseAbort: "is-retryable-benign-merge-pause-abort.ts",
    isBenignManualMergeHoldPauseAbort: "is-benign-manual-merge-hold-pause-abort.ts",
    handleStaleInReviewPlanPauseAbortReplay: "handle-stale-in-review-plan-pause-abort-replay.ts",
    handleStaleInReviewParsePauseAbortReplay: "handle-stale-in-review-parse-pause-abort-replay.ts",
    isReentrantPausedAbortedInFlightNode: "is-reentrant-paused-aborted-in-flight-node.ts",
    routeUnusableWorktreeGraphFailureToRecovery: "route-unusable-worktree-graph-failure-to-recovery.ts",
    routeGraphFailureToExecutionResume: "route-graph-failure-to-execution-resume.ts",
    handleNonContinuableSessionError: "non-continuable-session.ts",
  };

  async function methodBody(name: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const module = CLASSIFIER_MODULES[name];
    expect(module, `${name} has no mapped executor/ module — update this test, do not delete it`).toBeDefined();
    const source = await readFile(new URL(`../executor/${module}`, import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const start = code.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found — update this test, do not delete it`).toBeGreaterThan(-1);
    const next = code.indexOf("\nexport ", start + 1);
    return code.slice(start, next === -1 ? code.length : next);
  }

  it("threads the shared memo in every classifier that has one", async () => {
    const offenders: string[] = [];
    for (const name of MEMO_THREADED) {
      const body = await methodBody(name);
      // A memo-less call — `resolveResumeLanes(x)` with a single argument — is the defect.
      if (/resolveResumeLanes\(\s*[^,)]+\s*\)/.test(body)) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });

  it("resolves lanes AT MOST ONCE in a method that owns its own recovery", async () => {
    /*
    The rule differs by kind and that distinction is the point: a method called from `handleGraphFailure`
    must take the memo (zero independent resolutions), while a self-contained recovery legitimately resolves
    once. What neither may do is resolve TWICE — that is a split snapshot in both shapes.
    */
    const offenders: Array<{ name: string; calls: number }> = [];
    for (const name of SELF_CONTAINED) {
      const body = await methodBody(name);
      const calls = [...body.matchAll(/resolveResumeLanes\(/g)].length;
      if (calls > 1) offenders.push({ name, calls });
    }

    expect(offenders).toEqual([]);
  });

  it("threads the memo from handleGraphFailure into every one of them", async () => {
    const { readFile } = await import("node:fs/promises");
    /*
    FNXC:CodeOrganization 2026-08-03-15:05 (U4 handleGraphFailure peel):
    Call sites live in the free-function peel (`deps.<classifier>(…resumeLanesMemo)`), not the
    thin TaskExecutor facade. Scan the peel (and still accept `this.` for any residual class body).
    */
    const peel = await readFile(new URL("../executor/handle-graph-failure.ts", import.meta.url), "utf8");
    const code = peel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // The call sites must PASS it — accepting an unused optional parameter proves nothing.
    for (const name of MEMO_THREADED.filter((n) => n !== "isReentrantPausedAbortedInFlightNode")) {
      const callSite = new RegExp(`(?:this|deps)\\.${name}\\([^;]*resumeLanesMemo`);
      expect(callSite.test(code), `${name} call site does not pass resumeLanesMemo`).toBe(true);
    }
  });
});
