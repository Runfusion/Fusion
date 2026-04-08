import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentsView } from "../AgentsView";
import type { Agent, AgentCapability, AgentState } from "../../api";

vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
  fetchAgentStats: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
  startAgentRun: vi.fn(),
  fetchModels: vi.fn(() => Promise.resolve({ models: [] })),
}));

import {
  fetchAgents,
  fetchAgentStats,
  updateAgent,
  updateAgentState,
  deleteAgent,
  startAgentRun,
} from "../../api";

const mockAgents: Agent[] = [
  {
    id: "agent-001",
    name: "Mobile Executor",
    role: "executor" as AgentCapability,
    state: "active" as AgentState,
    taskId: "FN-101",
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
  {
    id: "agent-002",
    name: "Mobile Reviewer",
    role: "reviewer" as AgentCapability,
    state: "idle" as AgentState,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
];

const eventSourceFactory = vi.fn(() => ({
  addEventListener: vi.fn(),
  close: vi.fn(),
}));

describe("AgentsView mobile adaptations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal("EventSource", eventSourceFactory as unknown as typeof EventSource);

    vi.mocked(fetchAgents).mockResolvedValue(mockAgents);
    vi.mocked(fetchAgentStats).mockResolvedValue({
      total: 2,
      byState: { active: 1, idle: 1 },
      byRole: { executor: 1, reviewer: 1 },
    });
    vi.mocked(updateAgent).mockResolvedValue(mockAgents[0]);
    vi.mocked(updateAgentState).mockResolvedValue(mockAgents[0]);
    vi.mocked(deleteAgent).mockResolvedValue(undefined);
    vi.mocked(startAgentRun).mockResolvedValue({
      id: "run-1",
      agentId: "agent-001",
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active",
    });
  });

  it("renders board view grid and board cards", async () => {
    const { container } = render(<AgentsView addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Agents")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Board view" }));

    await waitFor(() => {
      expect(container.querySelector(".agent-board")).toBeTruthy();
      expect(container.querySelectorAll(".agent-board-card").length).toBeGreaterThan(0);
    });
  });

  it("renders list view cards", async () => {
    const { container } = render(<AgentsView addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Agents")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "List view" }));

    await waitFor(() => {
      expect(container.querySelector(".agent-list")).toBeTruthy();
      expect(container.querySelectorAll(".agent-card").length).toBeGreaterThan(0);
    });
  });

  it("renders agent controls, filter, and action buttons", async () => {
    const { container } = render(<AgentsView addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Agents")).toBeTruthy());

    expect(container.querySelector(".agent-controls")).toBeTruthy();
    expect(container.querySelector(".agent-state-filter")).toBeTruthy();
    expect(container.querySelector(".agent-controls-actions")).toBeTruthy();
  });

  it("switches between board, list, and tree views", async () => {
    const { container } = render(<AgentsView addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Agents")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Tree view" }));
    await waitFor(() => expect(container.querySelector(".agent-tree__view")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Board view" }));
    await waitFor(() => expect(container.querySelector(".agent-board")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    await waitFor(() => expect(container.querySelector(".agent-list")).toBeTruthy());
  });

  it("renders state filter select with expected options", async () => {
    render(<AgentsView addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Filter agents by state")).toBeTruthy());

    const select = screen.getByLabelText("Filter agents by state") as HTMLSelectElement;
    expect(select).toBeTruthy();

    const optionValues = Array.from(select.options).map((option) => option.value);
    expect(optionValues).toEqual(["all", "idle", "active", "running", "paused", "error", "terminated"]);
  });
});
