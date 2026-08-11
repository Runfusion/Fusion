import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityEvent } from "../../../api";

const { getAgentActivity, subscribeSse } = vi.hoisted(() => ({
  getAgentActivity: vi.fn(),
  subscribeSse: vi.fn(),
}));

vi.mock("../../../api", () => ({ getAgentActivity }));
vi.mock("../../../sse-bus", () => ({ subscribeSse }));

import { AgentActivityPanel } from "../AgentActivityPanel";

const range = { from: null, to: null, preset: "all" };
const event = (seq: string, overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent => ({
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
  ...overrides,
});

describe("AgentActivityPanel", () => {
  beforeEach(() => {
    getAgentActivity.mockReset().mockResolvedValue({ events: [event("2")], nextCursor: null });
    subscribeSse.mockReset().mockReturnValue(vi.fn());
  });

  it("renders a seeded live row and prepends an SSE row without refetching", async () => {
    let subscription: { events: Record<string, (message: MessageEvent) => void> } | undefined;
    subscribeSse.mockImplementation((_url, options) => {
      subscription = options;
      return vi.fn();
    });

    render(<AgentActivityPanel projectId="project" range={range} />);

    await screen.findByText("Completed work 2");
    expect(getAgentActivity).toHaveBeenCalledTimes(1);
    act(() => subscription?.events["agent:activity"](new MessageEvent("agent:activity", { data: JSON.stringify(event("3")) })));

    await screen.findByText("Completed work 3");
    expect(getAgentActivity).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/Completed work/).map((row) => row.textContent)).toEqual(["Completed work 3", "Completed work 2"]);
  });

  it("opens a task from its timeline row and retains a separate agent target", async () => {
    const onOpenTask = vi.fn();
    const onOpenAgent = vi.fn();
    render(<AgentActivityPanel projectId="project" range={range} onOpenTask={onOpenTask} onOpenAgent={onOpenAgent} />);

    await screen.findByText("Completed work 2");
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    fireEvent.click(screen.getByRole("button", { name: "Open task FN-2" }));
    expect(onOpenTask).toHaveBeenCalledWith("FN-2");
    expect(onOpenAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open agent agent-2" }));
    expect(onOpenAgent).toHaveBeenCalledWith("agent-2");
  });

  it("renders empty, unknown, and untargeted activity rows safely", async () => {
    getAgentActivity.mockResolvedValueOnce({
      events: [event("2", { taskId: null, agentId: "", type: "server:future" as AgentActivityEvent["type"] })],
      nextCursor: null,
    });
    render(<AgentActivityPanel projectId="project" range={range} />);

    await screen.findByText("Completed work 2");
    expect(screen.getByText("Activity")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(screen.queryByRole("button", { name: /Open (task|agent)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
  });

  it("requests older rows with the returned cursor and never duplicates the rendered timeline", async () => {
    getAgentActivity.mockResolvedValueOnce({ events: [event("4"), event("3")], nextCursor: "3" });
    getAgentActivity.mockResolvedValueOnce({ events: [event("3"), event("2")], nextCursor: null });
    render(<AgentActivityPanel projectId="project" range={range} />);

    await screen.findByText("Completed work 4");
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));

    await waitFor(() => expect(getAgentActivity).toHaveBeenLastCalledWith(expect.objectContaining({ before: "3", limit: 50 })));
    await screen.findByText("Completed work 2");
    expect(screen.getAllByText("Completed work 3")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
  });

  it("refetches with each timeline filter and omits inactive filters", async () => {
    getAgentActivity.mockResolvedValue({ events: [event("2")], nextCursor: null });
    render(<AgentActivityPanel projectId="project" range={range} />);
    await screen.findByText("Completed work 2");
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));

    fireEvent.change(screen.getByLabelText("Filter by agent"), { target: { value: "agent-2" } });
    await waitFor(() => expect(getAgentActivity).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "project", agentId: "agent-2" })));
    fireEvent.change(screen.getByLabelText("Filter by task"), { target: { value: "FN-2" } });
    await waitFor(() => expect(getAgentActivity).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "agent-2", taskId: "FN-2" })));
    fireEvent.change(screen.getByLabelText("Filter by event type"), { target: { value: "task:completed" } });
    await waitFor(() => expect(getAgentActivity).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "agent-2", taskId: "FN-2", type: "task:completed" })));
    expect(getAgentActivity.mock.calls[0][0]).not.toHaveProperty("agentId");
    expect(getAgentActivity.mock.calls[0][0]).not.toHaveProperty("taskId");
    expect(getAgentActivity.mock.calls[0][0]).not.toHaveProperty("type");
  });

  it("renders the empty state after a successful empty page", async () => {
    getAgentActivity.mockResolvedValueOnce({ events: [], nextCursor: null });
    render(<AgentActivityPanel projectId="project" range={range} />);
    await waitFor(() => expect(screen.getByTestId("cc-area-agent-activity-empty")).toBeInTheDocument());
  });
});
