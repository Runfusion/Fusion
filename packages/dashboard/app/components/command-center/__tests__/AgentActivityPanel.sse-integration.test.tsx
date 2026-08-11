/*
FNXC:CommandCenterAgentActivity 2026-08-10-02:43:
The panel's normal unit tests replace subscribeSse, but this regression drives the real shared SSE multiplexer through an injected EventSource fake. That proves the org-wide live log receives and correctly orders agent:activity frames after the singleton bridge, without opening a network connection.
*/
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityEvent } from "../../../api";
import { __resetSseBus } from "../../../sse-bus";

const { getAgentActivity } = vi.hoisted(() => ({ getAgentActivity: vi.fn() }));
vi.mock("../../../api", () => ({ getAgentActivity }));

import { AgentActivityPanel } from "../AgentActivityPanel";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  readyState = FakeEventSource.OPEN;
  close = vi.fn(() => { this.readyState = FakeEventSource.CLOSED; });

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

const range = { from: null, to: null, preset: "all" };
const event = (seq: string): AgentActivityEvent => ({
  seq,
  eventId: `event-${seq}`,
  projectId: "project",
  agentId: "agent-2",
  agentAttribution: "agent",
  taskId: "FN-2",
  type: "task:completed",
  fromAgentId: null,
  toAgentId: null,
  summary: `Completed work ${seq}`,
  occurredAt: "2026-08-10T00:00:00.000Z",
  metadata: null,
});

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetSseBus();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  getAgentActivity.mockReset().mockResolvedValue({ events: [event("5"), event("1")], nextCursor: null });
});

afterEach(() => {
  __resetSseBus();
  vi.stubGlobal("EventSource", originalEventSource);
  vi.stubGlobal("fetch", originalFetch);
});

describe("AgentActivityPanel shared SSE integration", () => {
  it("renders the live feed through the shared EventSource bridge and places an out-of-order push by seq", async () => {
    const { unmount } = render(<AgentActivityPanel projectId="project" range={range} />);

    await screen.findByText("Completed work 5");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toMatch(/^\/api\/events\?/);

    act(() => FakeEventSource.instances[0].emit("agent:activity", event("3")));

    await screen.findByText("Completed work 3");
    expect(getAgentActivity).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/Completed work/).map((row) => row.textContent)).toEqual([
      "Completed work 5",
      "Completed work 3",
      "Completed work 1",
    ]);

    unmount();
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledOnce();
  });
});
