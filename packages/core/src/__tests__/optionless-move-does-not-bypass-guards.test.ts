/*
FNXC:TaskMovement 2026-07-30-11:30 (PR #2655 review — the contract that was only a comment):
AN OPTIONLESS `moveTask(id, toColumn)` MUST NOT INHERIT GUARD BYPASS.

`moves.ts` resolves `moveSource = options?.moveSource ?? "engine"` for the EMITTED source, while
`resolveWorkflowBypassGuardsImpl` reads `options?.moveSource` — so an optionless call is reported as
engine-sourced but does not skip workflow guards, plugin gates or the merge blocker. That asymmetry
is deliberate and was documented at `moves.ts` in a comment. It was not tested.

WHY IT NEEDED A TEST. The `void moveSource;` beside that read looks exactly like someone silencing an
unused-parameter lint, so I "fixed" it to use the resolved value — which handed guard bypass to the
eight optionless `moveTask` calls in dashboard HTTP routes (reset, rebound, respecify, unassign). It
took two rounds of review to get back to the shipped behaviour. A comment could not stop that; this
can.

The ambiguity underneath is real and unresolved: 18 optionless calls in `packages/engine` are genuine
engine moves that arguably SHOULD bypass, and 8 in `packages/dashboard` are operator-initiated and
must not. The fix is to make `moveSource` explicit at those 26 sites so the default is never guessed.
Until then, this pins the safe half — a public caller never silently acquires privilege — because
that is the direction whose failure is a security problem rather than an inconvenience.
*/
import { describe, expect, it } from "vitest";
import { resolveWorkflowBypassGuardsImpl } from "../task-store/task-store-helpers.js";
import type { TaskStore, MoveTaskOptions } from "../store.js";

/** The helper ignores the store; it is a pure policy decision over (moveSource, options). */
const STORE = {} as unknown as TaskStore;

describe("optionless moveTask does not inherit guard bypass", () => {
  it("does NOT bypass when no options are supplied", () => {
    /*
    The call site resolves `moveSource` to "engine" for the emitted event. Passing that resolved value
    here is exactly the mistake this test exists to prevent: it must not be enough on its own.
    */
    expect(resolveWorkflowBypassGuardsImpl(STORE, "engine", undefined)).toBe(false);
  });

  it("does NOT bypass when options are supplied without an explicit source", () => {
    // A caller that passes unrelated options is still not declaring itself engine-sourced.
    expect(resolveWorkflowBypassGuardsImpl(STORE, "engine", { preserveProgress: true } as MoveTaskOptions)).toBe(false);
  });

  it("DOES bypass when a call site opts in explicitly", () => {
    /*
    The other half — without this the helper could return false unconditionally and still pass. Engine,
    scheduler, handoff and recovery sites opt in by naming their source or asking for it directly.
    */
    expect(resolveWorkflowBypassGuardsImpl(STORE, "engine", { moveSource: "engine" } as MoveTaskOptions)).toBe(true);
    expect(resolveWorkflowBypassGuardsImpl(STORE, "engine", { moveSource: "scheduler" } as MoveTaskOptions)).toBe(true);
    expect(resolveWorkflowBypassGuardsImpl(STORE, "user", { skipMergeBlocker: true } as MoveTaskOptions)).toBe(true);
    expect(resolveWorkflowBypassGuardsImpl(STORE, "user", { recoveryRehome: true } as MoveTaskOptions)).toBe(true);
  });

  it("honours an explicit bypassGuards=false even from an engine source", () => {
    // `??` on the option means an explicit false wins over the source-derived default.
    expect(
      resolveWorkflowBypassGuardsImpl(STORE, "engine", { moveSource: "engine", bypassGuards: false } as MoveTaskOptions),
    ).toBe(false);
  });

  it("does NOT bypass for a user-sourced move", () => {
    expect(resolveWorkflowBypassGuardsImpl(STORE, "user", { moveSource: "user" } as MoveTaskOptions)).toBe(false);
  });
});
