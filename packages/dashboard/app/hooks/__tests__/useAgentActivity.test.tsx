import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const getAgentActivity = vi.fn();
  let handler: ((event: MessageEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const subscribeSse = vi.fn((_url: string, subscription: { events?: Record<string, (event: MessageEvent) => void> }) => {
    handler = subscription.events?.["agent:activity"];
    return unsubscribe;
  });
  return { getAgentActivity, getHandler: () => handler, subscribeSse, unsubscribe };
});

vi.mock("../../api", () => ({ getAgentActivity: mocks.getAgentActivity }));
vi.mock("../../sse-bus", () => ({ subscribeSse: mocks.subscribeSse }));

import { __resetAgentActivityStoreForTests } from "../agentActivityStore";
import { useAgentActivity } from "../useAgentActivity";

function Consumer({ label }: { label: string }) {
  const snapshot = useAgentActivity("project");
  return <output data-testid={label}>{snapshot.activityByAgentId.get("agent-a")?.summary ?? "none"}</output>;
}

afterEach(() => {
  __resetAgentActivityStoreForTests();
  vi.clearAllMocks();
});

describe("useAgentActivity", () => {
  it("is a thin shared-store view for multiple consumers", async () => {
    mocks.getAgentActivity.mockResolvedValue({ events: [], nextCursor: null });
    const view = render(<><Consumer label="first" /><Consumer label="second" /></>);
    await waitFor(() => expect(mocks.getAgentActivity).toHaveBeenCalledTimes(1));
    expect(mocks.subscribeSse).toHaveBeenCalledTimes(1);

    act(() => {
      mocks.getHandler()!(new MessageEvent("agent:activity", { data: JSON.stringify({
        eventId: "event-1", seq: "1", projectId: "project", agentId: "agent-a", agentAttribution: "agent",
        taskId: null, type: "task:started", fromAgentId: null, toAgentId: null, summary: "live prose",
        occurredAt: "2026-08-09T10:00:00.000Z", metadata: null,
      }) }));
    });
    expect(screen.getByTestId("first")).toHaveTextContent("live prose");
    expect(screen.getByTestId("second")).toHaveTextContent("live prose");
    view.unmount();
  });

  it("does not duplicate a stream during StrictMode effect replay and releases it after unmount", async () => {
    mocks.getAgentActivity.mockResolvedValue({ events: [], nextCursor: null });
    const view = render(<StrictMode><Consumer label="strict" /></StrictMode>);
    await waitFor(() => expect(mocks.getAgentActivity).toHaveBeenCalledTimes(1));
    expect(mocks.subscribeSse).toHaveBeenCalledTimes(1);
    view.unmount();
    await Promise.resolve();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
