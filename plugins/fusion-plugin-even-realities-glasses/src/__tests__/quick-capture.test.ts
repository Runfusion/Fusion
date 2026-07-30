import { describe, expect, it, vi } from "vitest";
import {
  FILLER_TOKENS,
  GlassesInputError,
  parseUtterance,
  runQuickCapture,
  splitTitleAndDescription,
  stripFillerTokens,
  stripWakePhrases,
} from "../quick-capture.js";

describe("quick-capture parsing", () => {
  it("strips wake phrases only at start", () => {
    expect(stripWakePhrases("hey fusion add a feature")).toBe("add a feature");
    expect(stripWakePhrases("call hey fusion later")).toBe("call hey fusion later");
  });

  it("removes filler tokens as whole words", () => {
    expect(FILLER_TOKENS).toContain("um");
    expect(stripFillerTokens("um, ship it")).toBe("ship it");
    expect(stripFillerTokens("summary")).toBe("summary");
  });

  it("splits title and description on first sentence boundary", () => {
    expect(splitTitleAndDescription("Ship parser. Add tests")).toEqual({
      title: "Ship parser.",
      description: "Add tests",
    });
    expect(splitTitleAndDescription("No boundary text")).toEqual({
      title: "No boundary text",
      description: "No boundary text",
    });
  });

  it("truncates long title and pushes overflow to description", () => {
    const { title, description } = splitTitleAndDescription(
      "this title is intentionally very long and should be truncated before eighty characters with overflow kept",
      { maxTitleChars: 80 },
    );
    expect(title.length).toBeLessThanOrEqual(80);
    expect(description).toContain("overflow kept");
  });

  it("throws on empty utterance", () => {
    expect(() => parseUtterance("")).toThrowError(GlassesInputError);
    expect(() => parseUtterance("   ")).toThrowError(/empty utterance/);
  });

  it("creates task with default column and channel metadata", async () => {
    const createTask = vi.fn(async (input) => ({ id: "FN-1", ...input, title: "t", column: input.column }));
    await runQuickCapture(
      { text: "hey fusion, write docs" },
      { taskStore: { createTask } as never, pluginId: "fusion-plugin-even-realities-glasses", defaultColumn: "triage" },
    );
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        column: "triage",
        source: expect.objectContaining({
          sourceMetadata: expect.objectContaining({ channel: "glasses-quick-capture" }),
        }),
      }),
    );
  });

  it("honors valid column override and rejects invalid column", async () => {
    const createTask = vi.fn(async (input) => ({ id: "FN-2", ...input, title: "t", column: input.column }));
    await runQuickCapture(
      { text: "ship it", column: "done" },
      { taskStore: { createTask } as never, pluginId: "fusion-plugin-even-realities-glasses", defaultColumn: "triage" },
    );
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ column: "done" }));

    await expect(
      runQuickCapture(
        { text: "ship it", column: "bad-column" },
        { taskStore: { createTask } as never, pluginId: "fusion-plugin-even-realities-glasses", defaultColumn: "triage" },
      ),
    ).rejects.toThrowError(GlassesInputError);
  });
});

/*
FNXC:PluginLifecycleColumns 2026-07-30-13:20 (Phase C convergence — quick capture):

The accepted capture columns are the BOARD's, not a hand-listed five. The old list was wrong in
both directions after U11 (#2515): it accepted `triage`, which the default board no longer
declares (so the create failed at the server, at the far end of a voice interaction), and it
rejected every column of a renamed or custom board.

Note on severity, corrected from my own PR description: this was never SILENT substitution —
`runQuickCapture` compares the normalized value against the request and throws 400 on a
mismatch. An unusable column was visibly rejected. The defect is the accept/reject SET.
*/
describe("quick capture accepts the columns the board actually declares", () => {
  function deps(defaultColumn = "todo") {
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

  /*
  FNXC:PluginLifecycleColumns 2026-07-30-19:45 (PR #2607 review — CodeRabbit): this case is
  VACUOUS with respect to the change and is kept only as a smoke test for the happy path —
  `in-progress` belongs to both the legacy five and the declared set, so it passed before the fix
  too. The non-vacuous half (a column the legacy five never contained IS accepted) needs control of
  the resolved workflow and lives in `quick-capture-renamed-board.test.ts`.
  */
  it("accepts a column the default workflow declares (smoke; see the renamed-board suite)", async () => {
    const d = deps();

    await runQuickCapture({ text: "ship the thing", column: "in-progress" }, d);

    expect((d as unknown as { created: Array<{ column?: string }> }).created[0]?.column).toBe("in-progress");
  });

  it("rejects `triage` now that the default lineage no longer declares it", async () => {
    // Pre-fix this was ACCEPTED and forwarded, and the server rejected the create — the
    // failure surfaced after the voice interaction had already succeeded from the operator's
    // point of view.
    await expect(runQuickCapture({ text: "ship it", column: "triage" }, deps())).rejects.toThrow(/invalid column/);
  });

  it("rejects a column no workflow declares", async () => {
    // The paired negative: "accept everything" must not pass for "read the workflow".
    await expect(runQuickCapture({ text: "ship it", column: "nonsense" }, deps())).rejects.toThrow(/invalid column/);
  });

  it("uses the configured default when no column is requested", async () => {
    const d = deps("todo");

    await runQuickCapture({ text: "ship it" }, d);

    expect((d as unknown as { created: Array<{ column?: string }> }).created[0]?.column).toBe("todo");
  });
});

/*
FNXC:PluginLifecycleColumns 2026-07-31-03:00 (PR #2644 review, greptile P1):

THE BUILT-IN DEFAULT IS NOT NECESSARILY THIS PROJECT'S BOARD. `resolveDefaultWorkflowIr()` takes no
project and no task, so a board built from a CUSTOM workflow had its own columns rejected — an
operator saying "put it in checking" got 400 for a column their board declares.

Quick capture creates a NEW task, so there is no selection to resolve through. The honest answer is
the union of every column any workflow in this project declares: it accepts a custom board's columns
and still rejects a column no board has, which is the operator-visible distinction. Deliberately
permissive ACROSS workflows rather than guessing which one a new card lands on — the server validates
the create, so a wrong-workflow column surfaces as a real error instead of the silent substitution
this replaces.

These cases drive the REAL default IR (unmocked) plus a custom definition, which is the shape the
sibling renamed-board suite cannot express: it mocks the default resolver, so it would pass even if
the custom-definition union were deleted. That is exactly what happened — the union had no failing
test until this file got one.
*/
describe("quick capture accepts columns declared by a project's CUSTOM workflows", () => {
  const customIr = {
    version: "v2", id: "wf-custom", name: "custom", nodes: [], edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
      { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    ],
  };

  function deps(defaultColumn = "todo") {
    const created: Array<Record<string, unknown>> = [];
    return {
      created,
      taskStore: {
        createTask: async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: "FN-1", column: input.column, description: input.description, updatedAt: "2026-07-31T00:00:00.000Z" };
        },
        listWorkflowDefinitions: async () => [{ id: "wf-custom", ir: customIr }],
      },
      pluginId: "glasses",
      defaultColumn,
    } as never;
  }

  it("accepts a column only the custom workflow declares", async () => {
    // Pre-fix: rejected with 400, because only the builtin default IR was consulted.
    const d = deps();

    await runQuickCapture({ text: "ship the thing", column: "checking" }, d);

    expect((d as unknown as { created: Array<{ column?: string }> }).created[0]?.column).toBe("checking");
  });

  it("still accepts the builtin default's own columns", async () => {
    const d = deps();

    await runQuickCapture({ text: "ship it", column: "in-progress" }, d);

    expect((d as unknown as { created: Array<{ column?: string }> }).created[0]?.column).toBe("in-progress");
  });

  it("still rejects a column NO workflow in the project declares", async () => {
    // The paired negative: union-across-workflows must not become accept-anything.
    await expect(runQuickCapture({ text: "ship it", column: "nonsense" }, deps())).rejects.toThrow(
      /invalid column/,
    );
  });
});
