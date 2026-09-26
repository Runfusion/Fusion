import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RemoteAgentsPanel } from "../RemoteAgentsPanel";
import { api } from "../../api/client/client";

vi.mock("../../api/client/client", () => ({ api: vi.fn() }));
const id = "a".repeat(64);
const fixture = { id, hostId: "host", provider: "codex", nativeSessionId: "native", observation: { title: "Fixture agent", activity: "working", observedAt: new Date().toISOString(), feedback: { generation: "generation", expiresAt: new Date(Date.now() + 3600000).toISOString() } }, collectorConnected: true, activityStale: false };
const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
};
// jsdom defines visibilityState on Document.prototype; dropping the own override restores it.
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(document, "visibilityState"); vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("standalone remote agents", () => {
  it("preserves the composer across background updates and submits one stable command", async () => {
    const calls: unknown[] = [];
    vi.mocked(api).mockImplementation(async (path, opts) => {
      if (opts?.method === "POST") { const b = JSON.parse(String(opts.body)); calls.push(b); return { commandId: b.commandId, status: "queued", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() } as never; }
      if (path.includes("/hosts")) return { hosts: [] } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      if (path.includes("/cost")) return { usage: [], estimatedUsd: null, partialUsd: null, usageComplete: false, pricingDate: "2026-07-16", pricingSource: "Fusion" } as never;
      if (path.includes("/feedback")) return { feedback: [] } as never;
      if (path.includes(id)) return { session: fixture } as never;
      return { sessions: [fixture], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    fireEvent.click((await screen.findByText("Fixture agent")).closest("button")!);
    const composer = await screen.findByLabelText("Message");
    fireEvent.change(composer, { target: { value: "Keep working" } }); composer.focus();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toBe(composer));
    expect(composer).toHaveValue("Keep working");
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ generation: "generation", text: "Keep working" });
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });
  it("discards an in-flight manual refresh once the operator changes the filter", async () => {
    // Manual Refresh passes no AbortSignal, so aborting the scope's controller cannot stop its
    // response. Only a request generation keeps a late reply from replacing the new view.
    const stale = { ...fixture, id: "b".repeat(64), observation: { ...fixture.observation, title: "Stale agent" } };
    const fresh = { ...fixture, id: "c".repeat(64), provider: "claude", observation: { ...fixture.observation, title: "Fresh agent" } };
    const pending: (() => void)[] = [];
    let listRequests = 0;
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts: [] } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      if (path.includes("provider=claude")) return { sessions: [fresh], nextCursor: null } as never;
      // The first load must finish, because Refresh is disabled while a load is in flight.
      if (++listRequests > 1) await new Promise<void>(resolve => pending.push(resolve));
      return { sessions: [stale], nextCursor: "stale-cursor" } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    await screen.findByText("Stale agent");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude" } });
    await screen.findByText("Fresh agent");
    await act(async () => { pending.forEach(resolve => resolve()); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("Fresh agent")).toBeInTheDocument();
    expect(screen.queryByText("Stale agent")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more sessions" })).toBeNull();
  });

  it("shows each session's cost on its card and never invents a total it cannot stand behind", async () => {
    const priced = { ...fixture, id: "1".repeat(64), hostId: "j", observation: { ...fixture.observation, title: "Priced agent" }, cost: { estimatedUsd: 1.25, partialUsd: 1.25, usageComplete: true, unpricedRecords: 0 } };
    const partial = { ...fixture, id: "2".repeat(64), hostId: "j", observation: { ...fixture.observation, title: "Partly priced agent" }, cost: { estimatedUsd: null, partialUsd: 0.5, usageComplete: false, unpricedRecords: 2 } };
    const unknown = { ...fixture, id: "3".repeat(64), hostId: "m3", observation: { ...fixture.observation, title: "Unpriced agent" }, cost: { estimatedUsd: null, partialUsd: null, usageComplete: true, unpricedRecords: 1 } };
    const empty = { ...fixture, id: "4".repeat(64), hostId: "m3", observation: { ...fixture.observation, title: "No usage agent" }, cost: { estimatedUsd: null, partialUsd: null, usageComplete: false, unpricedRecords: 0 } };
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts: [{ hostId: "j", collectorConnected: true }, { hostId: "m3", collectorConnected: false }] } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      return { sessions: [priced, partial, unknown, empty], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    const row = async (title: string) => (await screen.findByText(title)).closest("li")!;
    expect(await row("Priced agent")).toHaveTextContent("$1.25 estimated");
    // A partial total must say so and must not be presented as the session total.
    expect(await row("Partly priced agent")).toHaveTextContent("$0.50 priced so far · 2 records unpriced");
    expect(await row("Partly priced agent")).not.toHaveTextContent("$0.50 estimated");
    expect(await row("Unpriced agent")).toHaveTextContent("Cost unknown · 1 record unpriced");
    expect(await row("No usage agent")).toHaveTextContent("No usage reported");
  });

  it("summarizes every server with its own session count and flags an incomplete host total", async () => {
    const priced = { ...fixture, id: "1".repeat(64), hostId: "j", observation: { ...fixture.observation, title: "J one" }, cost: { estimatedUsd: 2, partialUsd: 2, usageComplete: true, unpricedRecords: 0 } };
    const alsoPriced = { ...fixture, id: "2".repeat(64), hostId: "j", observation: { ...fixture.observation, title: "J two" }, cost: { estimatedUsd: 3, partialUsd: 3, usageComplete: true, unpricedRecords: 0 } };
    const incomplete = { ...fixture, id: "3".repeat(64), hostId: "m3", observation: { ...fixture.observation, title: "M3 one" }, cost: { estimatedUsd: null, partialUsd: 0.25, usageComplete: false, unpricedRecords: 1 } };
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts: [{ hostId: "j", collectorConnected: true }, { hostId: "m3", collectorConnected: false }, { hostId: "m5", collectorConnected: false }] } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      return { sessions: [priced, alsoPriced, incomplete], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    const items = await screen.findAllByRole("listitem");
    const j = items.find(i => i.textContent?.startsWith("j"))!;
    expect(j).toHaveTextContent("Collector connected");
    expect(j).toHaveTextContent("2 sessions loaded");
    expect(j).toHaveTextContent("$5.00 estimated");
    const m3 = items.find(i => i.textContent?.startsWith("m3"))!;
    expect(m3).toHaveTextContent("Collector offline");
    expect(m3).toHaveTextContent("1 session loaded");
    // One unpriced session makes the whole host total incomplete; it must not read as a finished number.
    expect(m3).toHaveTextContent("incomplete");
    const m5 = items.find(i => i.textContent?.startsWith("m5"))!;
    expect(m5).toHaveTextContent("0 sessions loaded");
    expect(m5).toHaveTextContent("No cost reported");
  });

  it("exposes the sessions as a labelled list and announces how many are shown", async () => {
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts: [] } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      return { sessions: [fixture], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    await screen.findByText("Fixture agent");
    const list = screen.getByRole("list", { name: "Remote agent sessions" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Session list status" })).toHaveTextContent("1 session shown");
  });

  it("shows per-server operational health and never reports unknown counters as zero", async () => {
    const hosts = [
      { hostId: "j", collectorConnected: true, heartbeatAgeMs: 4000, spoolDepth: 0, spoolBytes: 0, parseFailures: 0, deliveryFailures: 0 },
      { hostId: "m3", collectorConnected: true, heartbeatAgeMs: 125000, spoolDepth: 1750, spoolBytes: 2_097_152, parseFailures: 3, deliveryFailures: 2 },
      { hostId: "m5", collectorConnected: false, heartbeatAgeMs: null, spoolDepth: null, spoolBytes: null, parseFailures: null, deliveryFailures: null },
    ];
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      return { sessions: [], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    const items = await screen.findAllByRole("listitem");
    const j = items.find(i => i.textContent?.startsWith("j"))!;
    expect(j).toHaveTextContent("Last heartbeat 4s ago");
    expect(j).toHaveTextContent("Spool empty");
    expect(j).toHaveTextContent("No failures reported");
    const m3 = items.find(i => i.textContent?.startsWith("m3"))!;
    expect(m3).toHaveTextContent("Last heartbeat 2m ago");
    expect(m3).toHaveTextContent("1750 queued (2048 KiB)");
    expect(m3).toHaveTextContent("3 parse failures · 2 delivery failures");
    const m5 = items.find(i => i.textContent?.startsWith("m5"))!;
    // The bug this guards: a collector that never reported rendering as a healthy, empty spool.
    expect(m5).toHaveTextContent("Last heartbeat never reported");
    expect(m5).toHaveTextContent("Spool not reported");
    expect(m5).toHaveTextContent("parse failures not reported");
    expect(m5).not.toHaveTextContent("Spool empty");
  });

  it("says a historical session's cost is at today's rates rather than calling it an estimate", async () => {
    const recalculated = { ...fixture, id: "9".repeat(64), observation: { ...fixture.observation, title: "Old session" },
      cost: { estimatedUsd: 2, partialUsd: 2, usageComplete: true, unpricedRecords: 0, basis: { asOf: "2026-07-16", source: "Fusion", recalculated: true } } };
    const current = { ...fixture, id: "8".repeat(64), observation: { ...fixture.observation, title: "Recent session" },
      cost: { estimatedUsd: 3, partialUsd: 3, usageComplete: true, unpricedRecords: 0, basis: { asOf: "2026-07-16", source: "Fusion", recalculated: false } } };
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts: [] } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      return { sessions: [recalculated, current], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    const row = async (title: string) => (await screen.findByText(title)).closest("li")!;
    // Presenting a recomputation as an estimate would read as what the work actually cost.
    expect(await row("Old session")).toHaveTextContent("at today's rates");
    expect(await row("Old session")).not.toHaveTextContent("estimated");
    expect(await row("Recent session")).toHaveTextContent("$3.00 estimated");
  });

  it("surfaces monitoring errors instead of showing an empty success state", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Collector storage unavailable"));
    render(<RemoteAgentsPanel projectId="project-a" />);
    expect(await screen.findByRole("alert", { name: "Remote agents error" })).toHaveTextContent("Collector storage unavailable");
  });
  it("opens session details and submits a valid command ID when randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    const calls: { commandId: string }[] = [];
    vi.mocked(api).mockImplementation(async (path, opts) => {
      if (opts?.method === "POST") { const body = JSON.parse(String(opts.body)); calls.push(body); return { commandId: body.commandId, status: "queued", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() } as never; }
      if (path.includes("/hosts")) return { hosts: [] } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      if (path.includes("/cost")) return { usage: [], estimatedUsd: null, partialUsd: null, usageComplete: false, pricingDate: "2026-07-16", pricingSource: "Fusion" } as never;
      if (path.includes("/feedback")) return { feedback: [] } as never;
      if (path.includes(id)) return { session: fixture } as never;
      return { sessions: [fixture], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    fireEvent.click((await screen.findByText("Fixture agent")).closest("button")!);
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  /*
  FNXC:ExternalSessionAttribution 2026-09-24-07:05 (operator decision F4 = 1): a session that IS a Fusion task
  run must say so, or a reader totalling both the remote-agent cost and the task's own telemetry double counts it.
  */
  it("marks a session that is a Fusion task run, and an ambiguous match, without inventing a task", async () => {
    const attributed = { ...fixture, fusion: { taskId: "FN-1", cliSessionId: "cli-1", ambiguous: false } };
    const ambiguous = { ...fixture, id: "b".repeat(64), observation: { ...fixture.observation, title: "Contested agent" },
      fusion: { taskId: null, cliSessionId: null, ambiguous: true } };
    const plain = { ...fixture, id: "c".repeat(64), observation: { ...fixture.observation, title: "Operator agent" }, fusion: null };
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts: [] } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      return { sessions: [attributed, ambiguous, plain], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    const card = (await screen.findByText("Fixture agent")).closest("button")!;
    expect(card).toHaveTextContent("Fusion task FN-1");
    expect(card).toHaveTextContent("already counted in task telemetry");
    const contested = (await screen.findByText("Contested agent")).closest("button")!;
    expect(contested).toHaveTextContent("more than one Fusion run");
    expect(contested).not.toHaveTextContent("FN-1");
    // An unattributed session claims nothing at all.
    expect((await screen.findByText("Operator agent")).closest("button")!).not.toHaveTextContent("already counted");
  });

  it("polls list, hosts and the open session only while the tab is visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts: [] } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      if (path.includes("/cost")) return { usage: [], estimatedUsd: null, partialUsd: null, usageComplete: false, pricingDate: "2026-07-16", pricingSource: "Fusion" } as never;
      if (path.includes("/feedback")) return { feedback: [] } as never;
      if (path.includes(id)) return { session: fixture } as never;
      return { sessions: [fixture], nextCursor: null } as never;
    });
    const count = (match: (path: string) => boolean) => vi.mocked(api).mock.calls.filter(([path]) => match(String(path))).length;
    const list = (path: string) => path.startsWith("/external-sessions?");
    const hosts = (path: string) => path.includes("/hosts");
    const detail = (path: string) => path.includes(`/cost`);
    render(<RemoteAgentsPanel projectId="project-a" />);
    fireEvent.click((await screen.findByText("Fixture agent")).closest("button")!);
    await waitFor(() => expect(count(detail)).toBe(1));
    expect([count(list), count(hosts)]).toEqual([1, 1]);

    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect([count(list), count(hosts), count(detail)]).toEqual([2, 2, 3]);

    setVisibility("hidden");
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect([count(list), count(hosts), count(detail)]).toEqual([2, 2, 3]);

    await act(async () => { setVisibility("visible"); });
    expect([count(list), count(hosts), count(detail)]).toEqual([3, 3, 4]);
  });
  it.each([
    ["expired", "Retry me"],
    ["uncertain", "Retry me"],
    ["delivered", ""],
  ] as const)("unlocks the composer when a lost-response receipt turns %s", async (terminal, remainingText) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const posts: { commandId: string }[] = [];
    let receiptStatus: string | null = null;
    vi.mocked(api).mockImplementation(async (path, opts) => {
      if (opts?.method === "POST") {
        const body = JSON.parse(String(opts.body)); posts.push(body);
        if (posts.length === 1) { receiptStatus = "queued"; throw new Error("Network response lost"); }
        return { commandId: body.commandId, status: "queued", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), deliveredAt: null } as never;
      }
      if (path.includes("/hosts")) return { hosts: [] } as never;
      if (path.includes("/turns")) return { schemaVersion: 1, turns: [], nextCursor: null } as never;
      if (path.includes("/overview")) return { schemaVersion: 1, totalUsd: 0, coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 }, byDay: [], byModel: [], byHost: [], fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 } } as never;
      if (path.includes("/rankings")) return { schemaVersion: 1, scope: "turns", entries: [], coverage: { scanned: 0, priced: 0, unpriced: 0, withoutUsage: 0, truncated: false, pricedTotalUsd: 0 } } as never;
      if (path.includes("/cost")) return { usage: [], estimatedUsd: null, partialUsd: null, usageComplete: false, pricingDate: "2026-07-16", pricingSource: "Fusion" } as never;
      if (path.includes("/feedback")) return { feedback: receiptStatus && posts[0] ? [{ commandId: posts[0].commandId, status: receiptStatus, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), deliveredAt: null }] : [] } as never;
      if (path.includes(id)) return { session: fixture } as never;
      return { sessions: [fixture], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    fireEvent.click((await screen.findByText("Fixture agent")).closest("button")!);
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByRole("alert", { name: "Session detail error" })).toHaveTextContent("Network response lost");

    // The receipt surfaces as queued: the same command is still pending, so the composer stays locked.
    await act(async () => { vi.advanceTimersByTime(5_000); });
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeDisabled());

    receiptStatus = terminal;
    await act(async () => { vi.advanceTimersByTime(5_000); });
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeEnabled());
    expect(screen.getByLabelText("Message")).toHaveValue(remainingText);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.commandId).not.toBe(posts[0]!.commandId);
  });
});
