/*
FNXC:PluginLifecycleColumns 2026-07-30-19:40 (PR #2607 review — CodeRabbit):

The reviewer is right that my "accepts a column the default workflow declares" case was VACUOUS:
`in-progress` belongs to both the legacy five and the declared set, so it passed before the change
as well. The only non-vacuous case in that suite was the `triage` REJECTION — which proves half the
claim (the set is no longer the hand-listed five) and not the other half (it is the BOARD's set).

Proving the other half needs control of the resolved workflow, so this file mocks it. Kept separate
because the mock is module-wide and the sibling suite deliberately exercises the real default
lineage.
*/
import { describe, expect, it, vi } from "vitest";

/** A board whose columns carry the standard traits under names the legacy five never contained. */
const RENAMED_IR = {
  version: "v2",
  id: "wf-renamed",
  name: "renamed",
  nodes: [],
  edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
};

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveDefaultWorkflowIr: () => RENAMED_IR };
});

const { runQuickCapture } = await import("../quick-capture.js");

function deps(defaultColumn = "queued") {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    taskStore: {
      createTask: async (input: Record<string, unknown>) => {
        created.push(input);
        return { id: "FN-1", column: input.column, description: input.description, updatedAt: "2026-07-30T00:00:00.000Z" };
      },
    },
    pluginId: "glasses",
    defaultColumn,
  } as never;
}

describe("quick capture accepts a RENAMED board's own columns", () => {
  it("accepts a column that appears nowhere in the legacy five", async () => {
    // THE NON-VACUOUS CASE. Pre-fix this was rejected with 400 "invalid column" — an operator
    // saying "put it in checking" was refused for a column their own board declares.
    const d = deps();

    await runQuickCapture({ text: "ship the thing", column: "checking" }, d);

    expect((d as unknown as { created: Array<{ column?: string }> }).created[0]?.column).toBe("checking");
  });

  it("rejects a legacy id this board does NOT declare", async () => {
    // The mirror: `in-progress` was accepted by the hand-listed five and is not a column here, so
    // forwarding it would have failed at the server after the voice interaction appeared to work.
    await expect(runQuickCapture({ text: "ship it", column: "in-progress" }, deps())).rejects.toThrow(
      /invalid column/,
    );
  });

  it("rejects a column no board declares", async () => {
    // Paired negative: "accept everything" must not pass for "read the workflow".
    await expect(runQuickCapture({ text: "ship it", column: "nonsense" }, deps())).rejects.toThrow(
      /invalid column/,
    );
  });
});
