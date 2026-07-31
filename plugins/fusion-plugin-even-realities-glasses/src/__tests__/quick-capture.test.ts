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

  /*
  FNXC:PluginLifecycleColumns 2026-07-31-09:00 (PR #2644 review): this case used to assert the card was
  created in `triage` because that was the configured default. `triage` is the column #2515 DELETED from
  the default lineage, so that assertion pinned a card being created into a column its own workflow does
  not declare — the defect greptile flagged, encoded as an expectation.

  The configured default is now validated like any other column: not declared -> fall to the workflow's
  own INTAKE column, which is where a new card belongs. Hence `todo`.
  */
  it("creates task in the workflow's intake when the configured default is not declared", async () => {
    const createTask = vi.fn(async (input) => ({ id: "FN-1", ...input, title: "t", column: input.column }));
    await runQuickCapture(
      { text: "hey fusion, write docs" },
      { taskStore: { createTask } as never, pluginId: "fusion-plugin-even-realities-glasses", defaultColumn: "triage" },
    );
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        column: "todo",
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
FNXC:PluginLifecycleColumns 2026-07-31-06:20 (PR #2644 review — third revision of this rule):

ACCEPT ONLY THE COLUMNS OF THE WORKFLOW THE NEW CARD WILL ACTUALLY USE, which is the project's DEFAULT
workflow. The two earlier versions were both wrong, in opposite directions:

  v1: the builtin default IR      -> rejected a custom board's own columns ("put it in checking" -> 400).
  v2: the union of ALL workflows  -> accepted `checking` from workflow B while the card lands on
                                     workflow A, which has no such column. The create then fails at the
                                     server, past the point where the operator could hear about it.

The union felt safer because it rejected less. "Rejects less" is not "correct" — it moved the failure
downstream. `getDefaultWorkflowId()` is the same authority `resolveWorkflowIntakeFacts` uses in
task-creation, so capture validation and card creation now agree by construction.

THE FIRST VERSION OF THIS SUITE ASSERTED THE UNION, so it had to change with the rule — recorded rather
than silently rewritten, because a test that changes with the code is only legitimate when the CONTRACT
changed, and here it did.
*/
describe("quick capture accepts the columns of the workflow a new card lands on", () => {
  const customIr = {
    version: "v2", id: "wf-custom", name: "custom", nodes: [], edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
      { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    ],
  };

  function deps(options: { defaultWorkflowId?: string } = {}) {
    const created: Array<Record<string, unknown>> = [];
    return {
      created,
      taskStore: {
        createTask: async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: "FN-1", column: input.column, description: input.description, updatedAt: "2026-07-31T00:00:00.000Z" };
        },
        getDefaultWorkflowId: async () => options.defaultWorkflowId,
        getWorkflowDefinition: async (id: string) => (id === "wf-custom" ? { id, ir: customIr } : undefined),
        listWorkflowDefinitions: async () => [{ id: "wf-custom", ir: customIr }],
      },
      pluginId: "glasses",
      defaultColumn: "backlog",
    } as never;
  }

  const columnOf = (d: unknown) => (d as { created: Array<{ column?: string }> }).created[0]?.column;

  it("accepts a column of the project's default workflow when that workflow is custom", async () => {
    const d = deps({ defaultWorkflowId: "wf-custom" });

    await runQuickCapture({ text: "ship the thing", column: "checking" }, d);

    expect(columnOf(d)).toBe("checking");
  });

  it("REJECTS a column from another workflow the new card will not land on", async () => {
    /*
    The case that killed the union: `checking` exists on `wf-custom`, but this project's default is the
    builtin lineage, and quick capture does not select a workflow. Accepting it would create a card in
    a column its own workflow does not declare.
    */
    await expect(runQuickCapture({ text: "ship it", column: "checking" }, deps())).rejects.toThrow(
      /invalid column/,
    );
  });

  it("accepts the builtin default's own columns when the default is builtin", async () => {
    const d = deps();

    await runQuickCapture({ text: "ship it", column: "in-progress" }, d);

    expect(columnOf(d)).toBe("in-progress");
  });

  it("still rejects a column no workflow declares", async () => {
    await expect(runQuickCapture({ text: "ship it", column: "nonsense" }, deps({ defaultWorkflowId: "wf-custom" }))).rejects.toThrow(
      /invalid column/,
    );
  });
});

/*
FNXC:PluginLifecycleColumns 2026-07-31-09:10 (PR #2644 review, greptile P1):

THE CONFIGURED DEFAULT IS ALSO A COLUMN, and it was the one path that never got validated. A capture
with no `column` returned the plugin SETTING verbatim, so on a project whose default workflow does not
declare that column, every voice capture created a card in an undeclared column. I fixed the
requested-column path twice and left the far more common path — no column named at all — unchecked.
*/
describe("the configured default column is validated too", () => {
  const customIr = {
    version: "v2", name: "Custom Board", nodes: [], edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    ],
  };

  function deps(defaultColumn: string, workflowId?: string) {
    const created: Array<Record<string, unknown>> = [];
    return {
      created,
      taskStore: {
        createTask: async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: "FN-1", column: input.column, description: input.description, updatedAt: "2026-07-31T00:00:00.000Z" };
        },
        getDefaultWorkflowId: async () => workflowId,
        getWorkflowDefinition: async (id: string) => (id === "wf-custom" ? { id, ir: customIr } : undefined),
      },
      pluginId: "glasses",
      defaultColumn,
    } as never;
  }

  const columnOf = (d: unknown) => (d as { created: Array<{ column?: string }> }).created[0]?.column;

  it("falls to the workflow's INTAKE when the configured default is not declared", async () => {
    // Pre-fix: created the card in `todo`, which this board does not have.
    const d = deps("todo", "wf-custom");

    await runQuickCapture({ text: "capture this" }, d);

    expect(columnOf(d)).toBe("backlog");
  });

  it("uses the configured default when the workflow DOES declare it", async () => {
    // The paired positive: the operator's setting is honoured wherever it is valid, so this is not
    // "always use intake".
    const d = deps("building", "wf-custom");

    await runQuickCapture({ text: "capture this" }, d);

    expect(columnOf(d)).toBe("building");
  });

  it("keeps the configured default when no workflow resolves at all", async () => {
    // Nothing to validate against is the legacy shape; refusing or rewriting here would break boards
    // that have never had a workflow selected.
    const d = deps("in-review");

    await runQuickCapture({ text: "capture this" }, d);

    expect(columnOf(d)).toBe("in-review");
  });
});

/*
FNXC:PluginLifecycleColumns 2026-07-31-11:00 (PR #2644 review — I split the snapshot again):

ONE RESOLUTION FOR BOTH ANSWERS. The declared-column set and the intake fallback each resolved the
workflow independently, so a workflow edit between them validated against one revision and selected the
intake column from another — persisting a card in a column the validated revision does not declare.

Third place in this branch I have made this mistake (executor resume lanes, glasses lane context, here),
and the second time AFTER fixing it elsewhere. The shape is always two helpers that each look correct,
called in sequence, each doing its own read. Hence a read-count assertion rather than prose: it is the
only thing that fails when someone reintroduces the split.
*/
describe("capture resolves the board once, not once per question", () => {
  const customIr = {
    version: "v2", name: "Custom Board", nodes: [], edges: [],
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    ],
  };

  function countingDeps(defaultColumn: string) {
    const created: Array<Record<string, unknown>> = [];
    const reads = { definition: 0 };
    return {
      created,
      reads,
      taskStore: {
        createTask: async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: "FN-1", column: input.column, description: input.description, updatedAt: "2026-07-31T00:00:00.000Z" };
        },
        getDefaultWorkflowId: async () => "wf-custom",
        getWorkflowDefinition: async () => {
          reads.definition += 1;
          return { id: "wf-custom", ir: customIr };
        },
      },
      pluginId: "glasses",
      defaultColumn,
    } as never;
  }

  it("reads the workflow ONCE even when the fallback path needs the intake column too", async () => {
    // `todo` is not declared here, so this capture needs BOTH answers: the declared set (to reject it)
    // and the intake column (to land the card). One read must serve both.
    const d = countingDeps("todo");

    await runQuickCapture({ text: "capture this" }, d);

    expect((d as unknown as { reads: { definition: number } }).reads.definition).toBe(1);
    expect((d as unknown as { created: Array<{ column?: string }> }).created[0]?.column).toBe("backlog");
  });

  it("reads once on the path where the requested column is accepted", async () => {
    const d = countingDeps("backlog");

    await runQuickCapture({ text: "capture this", column: "building" }, d);

    expect((d as unknown as { reads: { definition: number } }).reads.definition).toBe(1);
    expect((d as unknown as { created: Array<{ column?: string }> }).created[0]?.column).toBe("building");
  });
});

/*
FNXC:PluginLifecycleColumns 2026-07-31-12:35 (PR #2644 review — what I could NOT prove, recorded):

`resolveWorkflowIrById` silently substitutes the BUILTIN default IR when a configured custom workflow is
missing or unparsable, so its columns get treated as this project's vocabulary. The reviewer is right that
this is laundering. I could not establish a better answer: the legacy-five fallback ACCEPTS `triage` (the
column #2515 deleted — the defect I fixed earlier in this branch), accepting nothing rejects every named
column on a project whose row is merely missing, and refusing outright loses the utterance.

The tell that stopped me shipping a fix: my isolated revert stayed GREEN. Two candidate behaviours my
tests could not distinguish means I had no evidence, and a change I cannot make fail is a change I cannot
justify. The substitution is named at the site and the decision left to whoever owns the missing-workflow
contract.

What IS pinned below is the part that is provable: a readable custom board is used, and the row that was
read is the snapshot (one read, enforced by the read-count cases above).
*/
describe("a readable custom default board is used for validation", () => {
  it("accepts a column the custom board declares", async () => {
    const customIr = {
      version: "v2", name: "Custom", nodes: [], edges: [],
      columns: [
        { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
        { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      ],
    };
    const created: Array<Record<string, unknown>> = [];
    const d = {
      taskStore: {
        createTask: async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: "FN-1", column: input.column, description: input.description, updatedAt: "2026-07-31T00:00:00.000Z" };
        },
        getDefaultWorkflowId: async () => "wf-custom",
        getWorkflowDefinition: async () => ({ id: "wf-custom", ir: customIr }),
      },
      pluginId: "glasses",
      defaultColumn: "backlog",
    } as never;

    await runQuickCapture({ text: "capture this", column: "building" }, d);

    expect(created[0]?.column).toBe("building");
  });
});
