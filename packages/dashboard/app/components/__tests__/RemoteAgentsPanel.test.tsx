import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("keeps a Load more page that lands while the background poll is refreshing", async () => {
    // The poll and pagination belong to the same scope, so a newer poll must not discard the page
    // the operator asked for. Only a project or filter change may invalidate an in-flight response.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = { ...fixture, id: "d".repeat(64), observation: { ...fixture.observation, title: "First page agent" } };
    const next = { ...fixture, id: "e".repeat(64), observation: { ...fixture.observation, title: "Second page agent" } };
    const pendingPages: (() => void)[] = [];
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts: [] } as never;
      if (path.includes("cursor=page-2")) { await new Promise<void>(resolve => pendingPages.push(resolve)); return { sessions: [next], nextCursor: null } as never; }
      return { sessions: [first], nextCursor: "page-2" } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    screen.getByText("First page agent");
    fireEvent.click(screen.getByRole("button", { name: "Load more sessions" }));
    await act(async () => { await Promise.resolve(); });
    expect(pendingPages).toHaveLength(1);
    // The background poll for the same scope lands while that page is still in flight.
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { pendingPages.forEach(resolve => resolve()); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("Second page agent")).toBeInTheDocument();
    expect(screen.getByText("First page agent")).toBeInTheDocument();
  });

  it("surfaces monitoring errors instead of showing an empty success state", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Collector storage unavailable"));
    render(<RemoteAgentsPanel projectId="project-a" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Collector storage unavailable");
  });
  it("opens session details and submits a valid command ID when randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    const calls: { commandId: string }[] = [];
    vi.mocked(api).mockImplementation(async (path, opts) => {
      if (opts?.method === "POST") { const body = JSON.parse(String(opts.body)); calls.push(body); return { commandId: body.commandId, status: "queued", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() } as never; }
      if (path.includes("/hosts")) return { hosts: [] } as never;
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
  it("polls list, hosts and the open session only while the tab is visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.mocked(api).mockImplementation(async path => {
      if (path.includes("/hosts")) return { hosts: [] } as never;
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
      if (path.includes("/cost")) return { usage: [], estimatedUsd: null, partialUsd: null, usageComplete: false, pricingDate: "2026-07-16", pricingSource: "Fusion" } as never;
      if (path.includes("/feedback")) return { feedback: receiptStatus && posts[0] ? [{ commandId: posts[0].commandId, status: receiptStatus, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), deliveredAt: null }] : [] } as never;
      if (path.includes(id)) return { session: fixture } as never;
      return { sessions: [fixture], nextCursor: null } as never;
    });
    render(<RemoteAgentsPanel projectId="project-a" />);
    fireEvent.click((await screen.findByText("Fixture agent")).closest("button")!);
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network response lost");

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
