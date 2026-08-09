import { describe, expect, it } from "vitest";
import { resolveAgentActivityAttribution } from "../task-store/agent-activity-outbox.js";

/* FNXC:AgentActivityStream 2026-08-09-11:50: Resolver output is a claim only; database roster proof remains exclusively at the append boundary. */
describe("agent activity attribution claims", () => {
  it("preserves provenance priority without inventing an actor", () => {
    expect(resolveAgentActivityAttribution([
      { id: "opaque-user", provenance: "actor" },
      { id: "agent-deadbeef", provenance: "roster" },
    ], "executor")).toMatchObject({ agentId: "agent-deadbeef", claimedAttribution: "agent" });
    expect(resolveAgentActivityAttribution([{ id: "opaque-user", provenance: "actor" }], "executor"))
      .toMatchObject({ agentId: "opaque-user", claimedAttribution: "actor" });
  });

  it("forces lane sentinels to lane claims even when a caller mislabels one", () => {
    expect(resolveAgentActivityAttribution([{ id: "executor", provenance: "roster" }], "executor"))
      .toMatchObject({ agentId: "executor", claimedAttribution: "lane" });
    expect(resolveAgentActivityAttribution([], "merger"))
      .toMatchObject({ agentId: "merger", claimedAttribution: "lane" });
  });
});
