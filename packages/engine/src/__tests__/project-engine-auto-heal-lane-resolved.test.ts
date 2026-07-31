// @vitest-environment node
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: project-engine.ts 5 → 0):

THE INVARIANT: the auto-merge retry machinery asks "is this card in ITS OWN review lane?", never
"is this card in `in-review`?".

Sibling to `project-engine-merge-lane-resolved.test.ts`, which covers the merge ENTRY points. This
file covers the RETRY/auto-heal predicates behind them, which fail in the same silent direction:

  - `hasAutoHealableVerificationBufferFailure` returned false for every card on a renamed board, so a
    merge whose verification died on a buffer-overflow error was never auto-healed. It sat
    retry-exhausted until a human reset it, and "no auto-heal happened" is indistinguishable in the
    logs from "there was nothing to heal".
  - `canMergeTask` inherits that answer, so a retry-exhausted-but-healable card is judged unmergeable
    and the cooldown sweep skips it forever.

WHY AN OPTIONAL PARAMETER, NOT A RESOLUTION INSIDE THE PREDICATE: both are SYNCHRONOUS predicates and
IR resolution is async. This is the shape `shouldHoldActiveFileScopeLease` already uses in
scheduler.ts — the caller that has resolved the lane passes the answer; a caller that has not gets
exactly today's literal behaviour, so no existing call site changes meaning.

THE undefined/false DISTINCTION IS THE POINT, and is asserted directly below. `undefined` means "this
board could not be resolved" and must fall through to the documented literal default. `false` means
"resolved, and this card is NOT in review". Collapsing the two — passing `false` on an unresolvable
board — would disable auto-heal outright rather than preserving today's behaviour, which is the
bug this parameter shape exists to prevent.

REVERT PROOF, measured: restore `if (task.column !== "in-review") return false` and the renamed-board
case returns false; the "unresolvable board keeps the literal" case still passes (it is the legacy
path), so BOTH cases are required to pin the fix.
*/
import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { ProjectEngine } from "../project-engine.js";

/** A board whose review lane is `signoff` — no id shared with the default lineage. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

/** A card whose merge verification died on a buffer overflow — the auto-healable shape. */
function healableTask(column: string, id = "FN-1"): Task {
  return {
    id,
    column,
    mergeRetries: 5,
    error: "Deterministic test verification failed",
    log: [{ action: "[verification] test command failed (exit 0) — output exceeded buffer" }],
    dependencies: [],
    steps: [],
  } as unknown as Task;
}

const autoHeal = (task: Task, max: number, isReviewColumn?: boolean): boolean =>
  (ProjectEngine.prototype as unknown as {
    hasAutoHealableVerificationBufferFailure: (this: unknown, t: unknown, m: number, r?: boolean) => boolean;
  }).hasAutoHealableVerificationBufferFailure.call({}, task, max, isReviewColumn);

const canMerge = (task: Task, max: number, isReviewColumn?: boolean): boolean =>
  (ProjectEngine.prototype as unknown as {
    canMergeTask: (this: unknown, t: unknown, m: number, r?: boolean) => boolean;
  }).canMergeTask.call(
    {
      options: {},
      isRetryCooldownElapsed: () => false,
      // The real method, so this asserts forwarding rather than a stub's signature.
      hasAutoHealableVerificationBufferFailure:
        ProjectEngine.prototype["hasAutoHealableVerificationBufferFailure" as keyof ProjectEngine],
    },
    task,
    max,
    isReviewColumn,
  );

describe("auto-heal recognises the board's own review lane", () => {
  it("heals a RENAMED board's review card when the caller passes the resolved answer", () => {
    // Pre-fix: `signoff` !== "in-review" → false, and the card stayed retry-exhausted.
    expect(autoHeal(healableTask("signoff"), 3, true)).toBe(true);
  });

  it("still declines a card that is genuinely NOT in the review lane", () => {
    // The resolved answer must be able to say no — otherwise the parameter is just `true`.
    expect(autoHeal(healableTask("building"), 3, false)).toBe(false);
  });

  it("keeps the literal default when the board could not be resolved (undefined ≠ false)", () => {
    // This is the unconverted-caller contract: omitting the answer must behave exactly as before.
    expect(autoHeal(healableTask("in-review"), 3, undefined)).toBe(true);
    expect(autoHeal(healableTask("signoff"), 3, undefined)).toBe(false);
  });

  it("does not heal a card whose failure is not a verification-buffer failure", () => {
    const notHealable = { ...healableTask("signoff"), error: "merge conflict" } as Task;
    expect(autoHeal(notHealable, 3, true)).toBe(false);
  });

  it("forwards the resolved answer through canMergeTask", () => {
    // Retry-exhausted (5 >= 3) and cooldown not elapsed, so canMergeTask can only return true via
    // the auto-heal branch — which makes this a direct probe of the forwarding.
    expect(canMerge(healableTask("signoff"), 3, true)).toBe(true);
    expect(canMerge(healableTask("signoff"), 3, false)).toBe(false);
  });
});

describe("the in-review enqueue sweep resolves each card's own review lane", () => {
  function sweepHarness(tasks: Task[], ir: WorkflowIr | undefined) {
    const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
    let irReads = 0;
    const store = {
      getTaskWorkflowSelection: () => (ir ? selection : undefined),
      getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
      getWorkflowDefinition: async () => {
        irReads += 1;
        return ir ? { ir } : undefined;
      },
    } as unknown as TaskStore;

    const enqueued: string[] = [];
    const self = {
      runtime: { getTaskStore: () => store },
      allowInReviewMergeProcessing: vi.fn(async () => true),
      internalEnqueueMerge: (id: string) => enqueued.push(id),
      canMergeTask: ProjectEngine.prototype["canMergeTask" as keyof ProjectEngine],
      hasAutoHealableVerificationBufferFailure:
        ProjectEngine.prototype["hasAutoHealableVerificationBufferFailure" as keyof ProjectEngine],
      isRetryCooldownElapsed: () => false,
      options: {},
    };

    const run = () =>
      (ProjectEngine.prototype as unknown as {
        enqueueEligibleInReviewTasks: (this: unknown, t: readonly Task[], s: unknown) => Promise<number>;
      }).enqueueEligibleInReviewTasks.call(
        self,
        tasks,
        { autoMerge: true, maxAutoMergeRetries: 3 } as unknown as Settings,
      );

    return { run, enqueued, irReads: () => irReads };
  }

  it("enqueues a retry-exhausted healable card sitting in a RENAMED review lane", async () => {
    // Pre-fix this sweep enqueued nothing: canMergeTask saw a card over the retry cap whose
    // auto-heal branch was keyed on the literal, so the queue stayed empty on a renamed board.
    const { run, enqueued } = sweepHarness([healableTask("signoff")], RENAMED_IR);

    await run();

    expect(enqueued).toEqual(["FN-1"]);
  });

  it("shares ONE IR read across a multi-card sweep rather than resolving per card", async () => {
    // The caller-owned-cache contract on resolveTaskLifecycleColumns. Without the shared cache this
    // sweep pays an IR read per card, which is the cost that made per-card resolution unshippable.
    const cards = [healableTask("signoff", "FN-1"), healableTask("signoff", "FN-2"), healableTask("signoff", "FN-3")];
    const { run, enqueued, irReads } = sweepHarness(cards, RENAMED_IR);

    await run();

    expect(enqueued).toEqual(["FN-1", "FN-2", "FN-3"]);
    expect(irReads()).toBe(1);
  });

  it("does not resolve an IR for paused cards", async () => {
    // Resolution runs after the paused filter, so a paused backlog costs nothing.
    const paused = { ...healableTask("signoff"), paused: true } as Task;
    const { run, enqueued, irReads } = sweepHarness([paused], RENAMED_IR);

    await run();

    expect(enqueued).toEqual([]);
    expect(irReads()).toBe(0);
  });
});
