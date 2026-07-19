import { describe, expect, it, vi } from "vitest";
import { createIdeationTools } from "../agent-tools.js";

const candidate = { id: "IC-1", sessionId: "IS-1", content: "Candidate", origin: "agent", selected: false };

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
    const tool = createIdeationTools(store).find((item) => item.name === "fn_ideation_converge")!;
    const result = await tool.execute("call", { sessionId: "IS-1", candidateId: "IC-1" });
    expect(convergeSession).toHaveBeenCalledWith("IS-1", "IC-1", { targetMissionId: undefined, targetFeatureId: undefined });
    expect(result.details).toMatchObject({ targetMissionId: "M-1", session: { status: "converged" } });
  });

  it("records all divergent candidates with provenance", async () => {
    const addCandidate = vi.fn().mockResolvedValue(candidate);
    const store = { getIdeationStore: () => ({ addCandidate }) } as never;
    const tool = createIdeationTools(store).find((item) => item.name === "fn_ideation_diverge")!;
    const result = await tool.execute("call", { sessionId: "IS-1", candidates: [candidate, { ...candidate, id: "IC-2", origin: "research", sourceRef: "R-1" }] });
    expect(addCandidate).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({ candidates: [candidate, candidate] });
  });

  it("returns structured failures for an empty or already-converged session", async () => {
    const convergeSession = vi.fn().mockRejectedValue(new Error("Ideation session IS-1 is already converged"));
    const store = { getIdeationStore: () => ({ convergeSession }) } as never;
    const tool = createIdeationTools(store).find((item) => item.name === "fn_ideation_converge")!;
    const result = await tool.execute("call", { sessionId: "IS-1", candidateId: "IC-missing" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ error: expect.stringContaining("already converged") });
  });
});
