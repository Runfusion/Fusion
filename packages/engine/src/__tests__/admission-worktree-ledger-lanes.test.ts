// @vitest-environment node
/*
FNXC:WorkflowResolvedColumns 2026-08-01-01:53 (fleet):

THE INVARIANT: the three gates that arbitrate the maxWorktrees budget count the SAME holders on a
renamed board — a finished card's retained worktree is never capacity, whatever its lane is called.

Planning admission (`triage.ts`) and the spawned-child gate (`executor.ts`) each filtered
`column !== "done" && column !== "archived"`. On a board that renamed its terminal lanes that pair
matches nothing, so every done card's retained worktree counts as live and `worktreeRoom` collapses:
admission refuses work while real slots sit free. That failure is QUIETER than the over-admission
breach the gates were written for — an over-throttled board is indistinguishable from an idle one,
which is why it is pinned here rather than left to the arithmetic tests.

WHAT THESE CASES COVER AND WHAT THEY DO NOT, stated rather than implied. Both call sites sit inside
methods (`TriageManager.processTriageTasks`, the `fn_spawn_agent` tool handler) that a unit test has
no business standing up — the same reasoning `scheduler-terminal-capacity-role.test.ts` and
`scheduler-load-lane-union.test.ts` record. So these pin the two halves the fix is made of:

  - `heldWorktreeCountOf`, the seam both call sites now share, including that it counts a
    worktree-less card as no holder and a terminal holder as no holder.
  - `resolveProjectColumnsForRoles(store, TERMINAL_ROLES)`, the terminal answer both now pass it,
    over a renamed board and over a degraded store.

The composition of the two is held by the compiler: the predicate is the function's only argument.

REVERTED — either call site restored to the literal pair — the "renamed board" case below fails: it
resolves `shipped`/`attic` as terminal, and the literal predicate reports 2 holders where the fix
reports 0. The degraded-store case is what keeps the legacy ids from being dropped in the process,
and it fails if `resolveProjectColumnsForRoles` is swapped for a trait-only resolver.
*/
import { describe, expect, it } from "vitest";
import { resolveProjectColumnsForRoles, TERMINAL_ROLES } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { heldWorktreeCountOf } from "../scheduler.js";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "attic", name: "Attic", traits: [{ trait: "archived" }] },
  ],
} as unknown as WorkflowIr;

/* Only the one method `resolveProjectColumnsForRoles` reads; anything else would be scenery. */
const storeWith = (definitions: Array<{ ir: unknown }>) =>
  ({ listWorkflowDefinitions: async () => definitions }) as never;

const task = (id: string, column: string, worktree?: string) =>
  ({ id, column, worktree }) as never;

describe("the admission-side worktree ledger, on a renamed board", () => {
  it("does not count a finished card's retained worktree, whatever the lane is called", async () => {
    const terminal = await resolveProjectColumnsForRoles(storeWith([{ ir: RENAMED_IR }]), TERMINAL_ROLES);
    const tasks = [
      task("t1", "shipped", "/wt/shipped"),
      task("t2", "attic", "/wt/attic"),
    ];

    /* The subject. Reverted to the literal pair this is 2, and admission throttles on phantom slots. */
    expect(heldWorktreeCountOf(tasks, (t) => terminal.has(t.column))).toBe(0);
  });

  it("still counts live cards in renamed working and intake lanes", async () => {
    const terminal = await resolveProjectColumnsForRoles(storeWith([{ ir: RENAMED_IR }]), TERMINAL_ROLES);
    const tasks = [
      task("t1", "building", "/wt/building"),
      task("t2", "backlog", "/wt/backlog"),
      task("t3", "shipped", "/wt/shipped"),
    ];

    /* Under-counting is the dangerous direction — it admits over the cap — so it is pinned too. */
    expect(heldWorktreeCountOf(tasks, (t) => terminal.has(t.column))).toBe(2);
  });

  it("counts HOLDING a worktree, not merely being live", () => {
    const tasks = [
      task("t1", "building", "/wt/one"),
      task("t2", "building"),
      task("t3", "building", ""),
    ];

    expect(heldWorktreeCountOf(tasks, () => false)).toBe(1);
  });

  it("keeps the legacy terminal ids when the definition list cannot be read", async () => {
    const unreadable = ({
      listWorkflowDefinitions: async () => { throw new Error("db down"); },
    }) as never;
    const terminal = await resolveProjectColumnsForRoles(unreadable, TERMINAL_ROLES);
    const tasks = [
      task("t1", "done", "/wt/done"),
      task("t2", "archived", "/wt/archived"),
      task("t3", "in-progress", "/wt/wip"),
    ];

    /* A degraded read must be no worse than the literal, never better-looking than it. */
    expect(heldWorktreeCountOf(tasks, (t) => terminal.has(t.column))).toBe(1);
  });
});
