// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import { request as performRequest } from "../test-request.js";
import { createIdeationRouter } from "../ideation-routes.js";
import { createIdeationTools } from "@fusion/engine";

/*
FNXC:Ideation 2026-07-30-15:30:
Route/tool parity is delegation parity: both surfaces must send converge to the
same store operation, whose transaction owns Mission creation plus persisted
selection/linkage. This prevents a dashboard-only handoff implementation.
*/
describe("ideation route/tool parity", () => {
  it("uses the same persisted convergence operation and returns its linkage", async () => {
    const session = { id: "IS-1", title: "Ideas", status: "converged", targetMissionId: "M-1", candidates: [{ id: "IC-1", selected: true, linkedMissionId: "M-1" }] };
    const ideation = { listSessions: vi.fn().mockResolvedValue([session]), getSessionWithCandidates: vi.fn().mockResolvedValue(session), createSession: vi.fn(), addCandidate: vi.fn(), convergeSession: vi.fn().mockResolvedValue(session) };
    const store = { getIdeationStore: () => ideation } as never;
    const app = express(); app.use(express.json()); app.use(createIdeationRouter(store));
    const route = await performRequest(app, "POST", "/IS-1/converge", JSON.stringify({ candidateId: "IC-1" }), { "content-type": "application/json" });
    const tool = createIdeationTools(store).find((item) => item.name === "fn_ideation_converge")!;
    const toolResult = await tool.execute("call", { sessionId: "IS-1", candidateId: "IC-1" });
    expect(route.status).toBe(200);
    expect(route.body).toMatchObject({ status: "converged", targetMissionId: "M-1" });
    expect(toolResult.details).toMatchObject({ targetMissionId: "M-1", session: { status: "converged" } });
    expect(ideation.convergeSession).toHaveBeenNthCalledWith(1, "IS-1", "IC-1", { targetMissionId: undefined, targetFeatureId: undefined });
    expect(ideation.convergeSession).toHaveBeenNthCalledWith(2, "IS-1", "IC-1", { targetMissionId: undefined, targetFeatureId: undefined });
  });
});
