import { describe, expect, it, vi } from "vitest";
import { createIdeationTools } from "../agent-tools.js";

const candidate = {
  id: "IC-1", sessionId: "IS-1", content: "Candidate", origin: "agent" as const, selected: false,
  createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z",
};

const textOf = (result: { content: Array<{ type: string; text: string }> }) => result.content[0]!.text;

const findTool = (store: never, name: string) => createIdeationTools(store).find((tool) => tool.name === name)!;

describe("createIdeationTools", () => {
  it("exposes read, divergence, and atomic convergence operations", () => {
    const store = { getIdeationStore: vi.fn() } as never;
    expect(createIdeationTools(store).map((tool) => tool.name)).toEqual([
      "fn_ideation_list", "fn_ideation_show", "fn_ideation_start", "fn_ideation_diverge", "fn_ideation_converge",
    ]);
  });

  it("delegates convergence to the single persisted operation and returns linkage", async () => {
    const convergeSession = vi.fn().mockResolvedValue({ id: "IS-1", status: "converged", targetMissionId: "M-1", candidates: [{ ...candidate, selected: true, linkedMissionId: "M-1" }] });
    const store = { getIdeationStore: () => ({ convergeSession }) } as never;
    const result = await findTool(store, "fn_ideation_converge").execute("call", { sessionId: "IS-1", candidateId: "IC-1" });
    expect(convergeSession).toHaveBeenCalledWith("IS-1", "IC-1", { targetMissionId: undefined, targetFeatureId: undefined });
    expect(result.details).toMatchObject({ targetMissionId: "M-1", session: { status: "converged" } });
  });

  it("renders every persisted candidate's identity, provenance, and multiline content in show text", async () => {
    const candidates = [
      { ...candidate, content: "Duplicate idea\nwith detail" },
      { ...candidate, id: "IC-2", origin: "research" as const, sourceRef: "R-1", content: "Duplicate idea\nwith detail" },
    ];
    const store = { getIdeationStore: () => ({ getSessionWithCandidates: vi.fn().mockResolvedValue({ id: "IS-1", title: "Ideas", status: "open", candidates }) }) } as never;

    const result = await findTool(store, "fn_ideation_show").execute("call", { id: "IS-1" });
    expect(textOf(result)).toBe([
      "IS-1: Ideas (open)",
      "Candidates (2)",
      "- IC-1 (agent)",
      "  Source reference: none",
      "  Content:",
      "    Duplicate idea",
      "    with detail",
      "- IC-2 (research)",
      "  Source reference: R-1",
      "  Content:",
      "    Duplicate idea",
      "    with detail",
    ].join("\n"));
  });

  it("reports an explicit empty candidate state and preserves missing-session errors", async () => {
    const ideation = {
      getSessionWithCandidates: vi.fn()
        .mockResolvedValueOnce({ id: "IS-empty", title: "Empty", status: "open", candidates: [] })
        .mockResolvedValueOnce(undefined),
    };
    const store = { getIdeationStore: () => ideation } as never;
    const tool = findTool(store, "fn_ideation_show");

    const empty = await tool.execute("call", { id: "IS-empty" });
    expect(textOf(empty)).toContain("Candidates (0): no divergent candidates recorded.");
    const missing = await tool.execute("call", { id: "IS-missing" });
    expect(missing).toMatchObject({ isError: true, details: { code: "IDEATION_SESSION_NOT_FOUND" } });
  });

  it("returns every assigned divergent candidate ID in agent-visible text, including duplicate content", async () => {
    const created = [
      { ...candidate, content: "Same idea" },
      { ...candidate, id: "IC-2", origin: "human" as const, sourceRef: "note-2", content: "Same idea" },
    ];
    const addCandidate = vi.fn().mockResolvedValueOnce(created[0]).mockResolvedValueOnce(created[1]);
    const store = { getIdeationStore: () => ({ addCandidate }) } as never;

    const result = await findTool(store, "fn_ideation_diverge").execute("call", {
      sessionId: "IS-1",
      candidates: created.map(({ content, origin, sourceRef }) => ({ content, origin, sourceRef })),
    });
    expect(addCandidate).toHaveBeenCalledTimes(2);
    expect(textOf(result)).toContain("- IC-1 (agent)");
    expect(textOf(result)).toContain("- IC-2 (human)");
    expect(textOf(result)).toContain("Source reference: none");
    expect(textOf(result)).toContain("Source reference: note-2");
    expect(result.details).toMatchObject({ candidates: created });
  });

  it("lets an agent converge with the candidate ID discovered from divergence text", async () => {
    const discovered = { ...candidate, id: "IC-discovered", content: "Reachable Mission", sourceRef: "research-42" };
    const convergeSession = vi.fn().mockResolvedValue({
      id: "IS-1", title: "Ideas", status: "converged", targetMissionId: "M-1", candidates: [{ ...discovered, selected: true }],
    });
    const store = { getIdeationStore: () => ({ addCandidate: vi.fn().mockResolvedValue(discovered), convergeSession }) } as never;

    const divergent = await findTool(store, "fn_ideation_diverge").execute("call", {
      sessionId: "IS-1", candidates: [{ content: discovered.content, origin: discovered.origin, sourceRef: discovered.sourceRef }],
    });
    const discoveredId = textOf(divergent).match(/- (IC-[\w-]+) \(/)?.[1];
    expect(discoveredId).toBe(discovered.id);

    const converged = await findTool(store, "fn_ideation_converge").execute("call", { sessionId: "IS-1", candidateId: discoveredId });
    expect(convergeSession).toHaveBeenCalledWith("IS-1", discovered.id, { targetMissionId: undefined, targetFeatureId: undefined });
    expect(textOf(converged)).toBe("Converged IS-1 into Mission M-1");
  });

  it("returns structured failures for an empty or already-converged session", async () => {
    const convergeSession = vi.fn().mockRejectedValue(new Error("Ideation session IS-1 is already converged"));
    const store = { getIdeationStore: () => ({ convergeSession }) } as never;
    const result = await findTool(store, "fn_ideation_converge").execute("call", { sessionId: "IS-1", candidateId: "IC-missing" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ error: expect.stringContaining("already converged") });
  });
});
