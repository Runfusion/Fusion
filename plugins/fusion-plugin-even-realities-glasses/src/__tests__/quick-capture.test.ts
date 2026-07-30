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

  it("accepts a column the default workflow declares", async () => {
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
