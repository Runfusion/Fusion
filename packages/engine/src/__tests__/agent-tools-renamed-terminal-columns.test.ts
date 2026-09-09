/*
FNXC:WorkflowResolvedColumns 2026-07-30-09:40 (batch-engine tail — the agent tools listed FINISHED cards as active):
DIFFERENTIAL: one task set, one pair of tools, two column VOCABULARIES.

`fn_task_list` describes itself as listing active tasks and `fn_task_search`
offers `includeDone: false`. Both filtered with `task.column !== "done"`. On a board whose complete lane is
renamed, a finished card came back as ACTIVE — to an AGENT, which then reasons and acts on it as
outstanding work. Nothing throws; the agent is simply told the wrong thing.

Historical cold rows were already excluded by the QUERY. `done` was only ever a TypeScript predicate,
which is why exactly this half broke.

WHY A NEW FILE: no existing suite exercised `createTaskListTool` or `createTaskSearchTool` at all, so the
"304/304 green" the conversion originally cited was not evidence about the conversion. Per
`docs/solutions/test-failures/optional-flags-seam-hides-unconverted-column-guards.md`, a suite that never
supplies a workflow asserts the legacy fallback and passes before AND after the change.

BOTH SURFACES, deliberately. Converting two copies and testing one is the Surface Enumeration failure this
program has already hit twice; `fn_task_list` and `fn_task_search` are separate call sites of the helper.

REVERT CHECK, measured (each run against `task.column !== "done"` restored):
  - "fn_task_list omits a finished card on a RENAMED complete column" fails: the shipped card is listed.
  - "fn_task_search omits a finished card on a RENAMED complete column" fails: same.
Both DEFAULT-vocabulary cases pass before and after, which is the point of running both.
*/
import { describe, expect, it } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { createTaskListTool, createTaskSearchTool } from "../agent-tools.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

/**
 * Three cards spanning the roles the filter must separate: one mid-flight, one finished, and one in a
 * lane that is neither. The third is the NON-VACUOUS companion — without it a filter that returned
 * everything, or nothing, would satisfy the finished-card assertions.
 */
function tasksFor(vocab: Vocabulary): Task[] {
  const card = (id: string, column: string, title: string): Task =>
    ({
      id,
      title,
      description: title,
      column,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }) as Task;

  return [
    card("FN-9101", vocab.wip, "still building"),
    card("FN-9102", vocab.complete, "shipped already"),
    card("FN-9103", vocab.hold, "waiting to start"),
  ];
}

/**
 * A store that resolves a REAL workflow IR, so the helper reads the vocabulary under test rather than
 * failing soft to the legacy ids. Failing soft would make the renamed run indistinguishable from the
 * default one and the differential meaningless.
 */
function fixture(vocab: Vocabulary) {
  const ir: WorkflowIr = lifecycleIr(vocab, "agent-tools-lifecycle");
  const tasks = tasksFor(vocab);
  const store = {
    listTasks: async () => tasks,
    searchTasks: async () => tasks,
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: "agent-tools-lifecycle", stepIds: [] }),
    getTaskWorkflowSelection: () => ({ workflowId: "agent-tools-lifecycle", stepIds: [] }),
    getWorkflowDefinition: async (id: string) => (id === "agent-tools-lifecycle" ? { ir } : undefined),
  } as unknown as TaskStore;
  return { store, tasks };
}

const VOCABULARIES: ReadonlyArray<readonly [string, Vocabulary]> = [
  ["DEFAULT", DEFAULT_VOCAB],
  ["RENAMED", RENAMED_VOCAB],
];

describe("agent task-discovery tools resolve the terminal lane by ROLE, not by id", () => {
  for (const [label, vocab] of VOCABULARIES) {
    it(`fn_task_list omits a finished card on a ${label} complete column (${vocab.complete})`, async () => {
      const { store } = fixture(vocab);
      const result = await createTaskListTool(store).execute("call-1", {} as never);
      const text = result.content[0].text;

      expect(text).not.toContain("FN-9102");
      // Non-vacuous: the two non-terminal cards must SURVIVE the filter.
      expect(text).toContain("FN-9101");
      expect(text).toContain("FN-9103");
    });

    it(`fn_task_search omits a finished card on a ${label} complete column (${vocab.complete})`, async () => {
      const { store } = fixture(vocab);
      const result = await createTaskSearchTool(store).execute("call-2", {
        query: "a",
        includeDone: false,
      } as never);
      const text = result.content[0].text;

      expect(text).not.toContain("FN-9102");
      expect(text).toContain("FN-9101");
      expect(text).toContain("FN-9103");
      expect(result.details).toMatchObject({ count: 2 });
    });
  }

  it("fn_task_search omits the finished card when includeDone is left at its default", async () => {
    const { store } = fixture(RENAMED_VOCAB);
    const result = await createTaskSearchTool(store).execute("call-3", { query: "a" } as never);

    expect(result.content[0].text).not.toContain("FN-9102");
    expect(result.details).toMatchObject({ count: 2 });
  });

  it("falls back to the legacy terminal pair when the workflow cannot be resolved", async () => {
    /*
    `resolveWorkflowIrForTask` returns the BUILT-IN IR for a missing or corrupt workflow rather than
    throwing, so the legacy union in the helper is load-bearing: without it a degraded board would resolve
    a terminal set excluding its own terminal lane and the filter would go INERT — the exact failure being
    fixed, reintroduced by the error path.
    */
    const tasks = tasksFor(DEFAULT_VOCAB);
    const store = {
      listTasks: async () => tasks,
      getTaskWorkflowSelectionAsync: async () => {
        throw new Error("workflow store unavailable");
      },
      getTaskWorkflowSelection: () => undefined,
      getWorkflowDefinition: async () => undefined,
    } as unknown as TaskStore;

    const result = await createTaskListTool(store).execute("call-4", {} as never);

    expect(result.content[0].text).not.toContain("FN-9102");
    expect(result.content[0].text).toContain("FN-9101");
  });
});
