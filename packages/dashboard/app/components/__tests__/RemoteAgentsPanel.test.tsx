import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoteAgentsPanel } from "../RemoteAgentsPanel";
import { api } from "../../api/client/client";

vi.mock("../../api/client/client", () => ({ api: vi.fn() }));
const id = "a".repeat(64);
const fixture = { id, hostId: "host", provider: "codex", nativeSessionId: "native", observation: { title: "Fixture agent", activity: "working", observedAt: new Date().toISOString(), feedback: { generation: "generation", expiresAt: new Date(Date.now() + 3600000).toISOString() } }, collectorConnected: true, activityStale: false };
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
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
});
