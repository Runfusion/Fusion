import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-19:45:
THE EVALUATOR'S ARCHIVED-LANE READ, on a RENAMED board.

`HybridEvaluatorService.evaluateTask` resolves the board's archived lanes and hands them to
`collectDeterministicSignals`, which uses them to decide which of a task's related rows count as
archived when scoring a run.

WHY THIS FILE EXISTS. `HybridEvaluatorService` had NO test anywhere in the repo — the module was
imported by four test files, none of which construct or exercise it. So the archived-lane conversion
was unobservable for the simplest possible reason: nothing ran the code.

HOW IT IS PINNED WITHOUT FAKING AN AI RESPONSE. The assertion is about what the collector RECEIVES,
which is decided before any model call. `collectDeterministicSignals` is mocked to record its
arguments and then throw a sentinel, so the test asserts the resolved lane set and stops — no canned
provider payload to drift out of sync with `parseAiResponse`, and no network. `runPrompt` is
injectable via deps, so this would be offline either way; the sentinel keeps the test about ONE
thing.

WHAT BREAKS WITHOUT THE CONVERSION. On a board whose archived lane is `vaulted`, the evaluator hands
the collector the legacy `{archived}` set. Rows resting in `vaulted` are then not recognised as
archived, and the deterministic half of every evaluation score is computed from a wrong picture of
the task's history. It is a silent scoring defect: nothing errors, the run completes, the number is
just wrong.

DIFFERENTIAL. Both vocabularies run the same workflow SHAPE with identical traits; only the ids
differ. The default-vocabulary run is the control — it passes with or without the conversion.
*/

const STOP = "STOP_AFTER_SIGNALS";
const collectSpy = vi.fn(() => {
  throw new Error(STOP);
});

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, collectDeterministicSignals: collectSpy };
});

const { HybridEvaluatorService } = await import("../evaluator.js");

const WF = "custom:renamed-archive";

function ir(archivedColumn: string): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "done", label: "Complete", traits: [{ trait: "complete" }] },
      { id: archivedColumn, label: "Archived", traits: [{ trait: "archived" }] },
    ],
  } as unknown as WorkflowIr;
}

function createStore(archivedColumn: string): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  return {
    listTasks: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({} as Settings)),
    getTask: vi.fn(async () => null),
    logEntry: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: ir(archivedColumn) })),
    /* FNXC:WorkflowResolvedColumns 2026-07-31-23:30: without this the resolver hands back legacy ids
       only, so the conversion under test cannot be observed and the suite passes on the unconverted
       code — the blinding failure this file guards. */
    listWorkflowDefinitions: vi.fn(async () => [{ ir: ir(archivedColumn) }]),
  } as unknown as TaskStore;
}

/** Returns the archived lane set the evaluator actually handed to the collector. */
async function archivedLanesHandedToCollector(archivedColumn: string): Promise<string[]> {
  collectSpy.mockClear();
  const service = new HybridEvaluatorService({
    cwd: "/tmp/project",
    store: createStore(archivedColumn),
    runPrompt: async () => "{}",
  });

  const task = { id: "FN-1", title: "t", description: "", column: "done", steps: [], log: [] } as unknown as Task;
  await expect(
    service.evaluateTask(task as never, { runId: "run-1" } as never, {} as Settings),
  ).rejects.toThrow(STOP);

  expect(collectSpy).toHaveBeenCalledTimes(1);
  const options = collectSpy.mock.calls[0]![2] as { archivedColumns?: ReadonlySet<string> } | undefined;
  return [...(options?.archivedColumns ?? [])].sort();
}

describe("evaluator resolves the board's own archived lanes", () => {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-22:35 (#3224 review follow-up — the half that was right):
  EXACT SET, not `toContain`. The review asked for an exact SINGLE-column set (`["vaulted"]`), which
  fails — see the note below on the legacy floor. But its underlying worry survives that correction:
  `toContain` also passes when the set grows a lane nobody intended, and an over-broad archived set
  silently classifies live rows as archived.

  The exact set is assertable, it just is not the one the review proposed. `[...].sort()` in the
  helper makes the ordering stable, so these pin the resolver's whole answer: the legacy floor plus
  the board's own lane, and nothing else.
  */
  it("default vocabulary: hands the collector exactly the archived lane", async () => {
    expect(await archivedLanesHandedToCollector("archived")).toEqual(["archived"]);
  });

  it("renamed vocabulary: hands the collector exactly the legacy floor plus the RENAMED lane", async () => {
    expect(await archivedLanesHandedToCollector("vaulted")).toEqual(["archived", "vaulted"]);
  });

  it("both vocabularies resolve their OWN lane — no column-id literal survives on this path", async () => {
    const renamed = await archivedLanesHandedToCollector("vaulted");
    const legacy = await archivedLanesHandedToCollector("archived");
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:30 (#3224 review — "reject legacy archived identifiers"):
    MEASURED, AND THE LEGACY ID IS SUPPOSED TO BE THERE.

    The review asked for an exact single-column set. Asserting that fails: the renamed board resolves
    to `["archived", "vaulted"]`. That is `resolveProjectColumnsForRoles`' documented legacy FLOOR —
    it unions `LEGACY_COLUMN_IDS_BY_ROLE` in so a row whose workflow cannot be resolved still
    classifies, and the helper's contract says the result is "never empty: the legacy ids are"
    included. Pinning an exact set here would encode the opposite of the design and fail the moment
    anyone read the helper's own docstring.

    The review's underlying worry is real but belongs to a different layer: a project that renames its
    archive lane AND has an unrelated column literally named `archived` would over-match. That is the
    known cost of the union, recorded in project-union-versus-per-task-lanes.md, and the answer there
    is per-task resolution at sites where over-inclusion is unsafe — not a narrower set here.

    So: assert the renamed lane IS resolved (the conversion works) and that the two boards differ,
    and pin the floor explicitly so its presence is documented rather than incidental.
    */
    expect(renamed).toContain("vaulted");
    expect(legacy).not.toContain("vaulted");
    /* The legacy floor, asserted rather than tolerated. */
    expect(renamed).toContain("archived");
  });
});
