import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RemoteAgentsPanel } from "../RemoteAgentsPanel";
import { api } from "../../api/client/client";

vi.mock("../../api/client/client", () => ({ api: vi.fn() }));

/*
FNXC:RemoteAgents 2026-09-26-23:39: a deep link opens its session even outside the loaded page, is consumed
once, applies only to the project it names, and never turns a malformed or unknown id into a different session.
*/
const linked = "b".repeat(64);
const listed = { id: "a".repeat(64), hostId: "j", provider: "codex", nativeSessionId: "n1",
  observation: { title: "Listed agent", activity: "working", observedAt: "2026-09-26T00:00:00Z" }, collectorConnected: true, activityStale: false };
const offPage = { ...listed, id: linked, observation: { ...listed.observation, title: "Older linked agent" } };
const go = (search: string) => window.history.replaceState({}, "", `/${search}`);
afterEach(() => { cleanup(); vi.resetAllMocks(); go(""); });

function mockApi(sessionById: Record<string, unknown>) {
  vi.mocked(api).mockImplementation(async path => {
    const p = String(path);
    if (p.includes("/hosts")) return { hosts: [] } as never;
    if (p.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
    if (p.includes("/cost")) return { usage: [], estimatedUsd: null, partialUsd: null, usageComplete: true, pricingDate: "2026-09-01", pricingSource: "Fusion" } as never;
    if (p.includes("/feedback")) return { feedback: [] } as never;
    if (p.includes("/summary")) return { schemaVersion: 1, summary: null, stale: false } as never;
    if (p.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
    if (p.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
    const one = /\/external-sessions\/([a-z0-9]{64})(\?|$)/.exec(p);
    if (one) { const s = sessionById[one[1]!]; if (!s) throw new Error("External session not found"); return { schemaVersion: 1, session: s } as never; }
    return { sessions: [listed], nextCursor: null } as never;
  });
}

describe("remote agent deep links", () => {
  it("opens a linked session outside the loaded page and consumes the link", async () => {
    mockApi({ [linked]: offPage });
    go(`?project=project-a&view=agents&remoteSession=${linked}&turn=t9`);
    render(<RemoteAgentsPanel projectId="project-a" />);
    expect(await screen.findByRole("heading", { name: "Older linked agent" })).toBeInTheDocument();
    const params = new URLSearchParams(window.location.search);
    expect(params.has("remoteSession")).toBe(false);
    expect(params.has("turn")).toBe(false);
    expect(params.get("project")).toBe("project-a"); // unrelated parameters survive
  });

  it("reports an unknown session instead of opening another one", async () => {
    mockApi({});
    go(`?project=project-a&remoteSession=${"c".repeat(64)}`);
    render(<RemoteAgentsPanel projectId="project-a" />);
    expect(await screen.findByRole("alert", { name: "Session not found" })).toHaveTextContent("That session was not found in this project.");
    expect(screen.queryByRole("region", { name: "Remote agent details" })).toBeNull();
  });

  it("ignores a malformed id and a link for another project", async () => {
    mockApi({ [linked]: offPage });
    go("?remoteSession=../../etc&turn=%3Cscript%3E");
    render(<RemoteAgentsPanel projectId="project-a" />);
    await screen.findByText("Listed agent");
    expect(vi.mocked(api).mock.calls.some(([p]) => String(p).includes("etc"))).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
    go(`?project=project-b&remoteSession=${linked}`);
    render(<RemoteAgentsPanel projectId="project-a" />);
    await screen.findByText("Listed agent");
    expect(screen.queryByRole("heading", { name: "Older linked agent" })).toBeNull();
    // Still pending for project-b, so it is not consumed by the wrong project.
    expect(new URLSearchParams(window.location.search).get("remoteSession")).toBe(linked);
  });
});
