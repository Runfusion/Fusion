// @vitest-environment node
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:05 (batch-engine feed: agent-tools.ts 5 → 0):

THE INVARIANT: the agent-facing task lists hide the cards ITS OWN workflow calls finished.

`fn_task_list` advertises "active tasks that aren't done or archived" and `fn_task_search` accepts
`includeDone: false`. Both answered with `column !== "done"`. On a renamed board neither matched, so
every FINISHED card came back as active work — the tool's own description became false. An agent then
reasons over shipped work as if it were open: it re-does it, or flags a live card as a duplicate of a
completed one. Nothing raises; the symptom is an agent that looks confused.

WHY BOTH PREDICATES EXIST. `fn_task_list` hides complete AND archived; `fn_task_search`'s
`includeDone: false` hides ONLY complete, because archived is governed by its own `includeArchived`
parameter. Collapsing them into one helper would silently change what search returns, so the archived
card is asserted to SURVIVE the search filter below — that assertion is the guard against a later
"simplification" merging the two.

THE UNRESOLVABLE-BOARD DEFAULT IS ASSERTED, not assumed: a card whose workflow will not resolve is
omitted from the lane map and must fall back to the legacy literals. The alternative — treating an
empty resolution as "nothing is terminal" — flows finished cards back into the agent's list, which is
the expensive direction to be wrong in.

REVERT PROOF, measured: restore `tasks.filter((task) => task.column !== "done")` and the renamed-board
list case fails (the shipped card reappears); restore the search literal and the renamed search case
fails. The default-board cases keep passing either way, so they do not pin the fix on their own.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { createTaskListTool, createTaskSearchTool } from "../agent-tools.js";

/** A board whose complete lane is `shipped` and archived lane is `vault`. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "signoff", name: "Sign-off", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "vault", name: "Vault", traits: [{ trait: "archived" }] },
  ],
} as unknown as WorkflowIr;

function card(id: string, column: string): Task {
  return {
    id,
    title: `${id} title`,
    description: "",
    column,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    dependencies: [],
    steps: [],
  } as unknown as Task;
}

function mockStore(tasks: Task[], ir: WorkflowIr | undefined) {
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  let irReads = 0;
  const store = {
    listTasks: vi.fn(async () => tasks),
    searchTasks: vi.fn(async () => tasks),
    getTaskWorkflowSelection: () => (ir ? selection : undefined),
    getTaskWorkflowSelectionAsync: async () => (ir ? selection : undefined),
    getWorkflowDefinition: async () => {
      irReads += 1;
      return ir ? { ir } : undefined;
    },
  } as unknown as TaskStore;
  return { store, irReads: () => irReads };
}

const listedIds = (text: string, all: Task[]): string[] =>
  all.filter((t) => text.includes(t.id)).map((t) => t.id);

type Executor = (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }>;

async function runList(store: TaskStore): Promise<string> {
  const result = await (createTaskListTool(store).execute as unknown as Executor)("run-1", {});
  return result.content?.[0]?.text ?? "";
}

async function runSearch(store: TaskStore, params: Record<string, unknown>): Promise<string> {
  const result = await (createTaskSearchTool(store).execute as unknown as Executor)("run-1", params);
  return result.content?.[0]?.text ?? "";
}

describe("fn_task_list hides the board's own complete column", () => {
  it("omits a card in a RENAMED complete lane and keeps the active ones", async () => {
    // Pre-fix: `shipped` !== "done", so FN-DONE was listed as active work.
    const tasks = [card("FN-ACTIVE", "building"), card("FN-DONE", "shipped")];
    const { store } = mockStore(tasks, RENAMED_IR);

    const text = await runList(store);

    expect(listedIds(text, tasks)).toEqual(["FN-ACTIVE"]);
  });

  it("keeps the legacy literal when the workflow cannot be resolved", async () => {
    const tasks = [card("FN-ACTIVE", "in-progress"), card("FN-DONE", "done")];
    const { store } = mockStore(tasks, undefined);

    const text = await runList(store);

    expect(listedIds(text, tasks)).toEqual(["FN-ACTIVE"]);
  });

  it("shares ONE IR read across the whole list rather than resolving per card", async () => {
    // The caller-owned-cache contract: a whole-board list must not pay an IR read per card.
    const tasks = ["FN-1", "FN-2", "FN-3", "FN-4"].map((id) => card(id, "building"));
    const { store, irReads } = mockStore(tasks, RENAMED_IR);

    await runList(store);

    expect(irReads()).toBe(1);
  });
});

describe("fn_task_search includeDone resolves the complete lane only", () => {
  it("omits a RENAMED complete card when includeDone is false", async () => {
    const tasks = [card("FN-ACTIVE", "building"), card("FN-DONE", "shipped")];
    const { store } = mockStore(tasks, RENAMED_IR);

    const text = await runSearch(store, { query: "title", includeDone: false });

    expect(listedIds(text, tasks)).toEqual(["FN-ACTIVE"]);
  });

  it("does NOT hide an archived card — that is includeArchived's job, not includeDone's", async () => {
    // Pins the two predicates apart. If a later change routes search through the terminal (complete
    // OR archived) helper, this fails instead of silently narrowing what search returns.
    const tasks = [card("FN-ACTIVE", "building"), card("FN-VAULTED", "vault")];
    const { store } = mockStore(tasks, RENAMED_IR);

    const text = await runSearch(store, { query: "title", includeDone: false });

    expect(listedIds(text, tasks)).toEqual(["FN-ACTIVE", "FN-VAULTED"]);
  });

  it("returns everything when includeDone is true, resolving no IR at all", async () => {
    // The resolution is skipped entirely on the default path, so the common call costs nothing.
    const tasks = [card("FN-ACTIVE", "building"), card("FN-DONE", "shipped")];
    const { store, irReads } = mockStore(tasks, RENAMED_IR);

    const text = await runSearch(store, { query: "title", includeDone: true });

    expect(listedIds(text, tasks)).toEqual(["FN-ACTIVE", "FN-DONE"]);
    expect(irReads()).toBe(0);
  });
});
