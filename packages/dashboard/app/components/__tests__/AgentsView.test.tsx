import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentsView } from "../AgentsView";
import * as apiModule from "../../api";
import type { Agent, AgentState, AgentCapability } from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
  fetchAgentStats: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
  startAgentRun: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue({ models: [] }),
}));

const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const mockCreateAgent = vi.mocked(apiModule.createAgent);
const mockUpdateAgentState = vi.mocked(apiModule.updateAgentState);
const mockDeleteAgent = vi.mocked(apiModule.deleteAgent);
const mockStartAgentRun = vi.mocked(apiModule.startAgentRun);
const mockFetchAgentStats = vi.mocked((apiModule as any).fetchAgentStats);

describe("AgentsView", () => {
  const mockAddToast = vi.fn();

  const mockAgents: Agent[] = [
    {
      id: "agent-001",
      name: "Test Agent 1",
      role: "executor" as AgentCapability,
      state: "idle" as AgentState,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
    {
      id: "agent-002",
      name: "Test Agent 2",
      role: "triage" as AgentCapability,
      state: "active" as AgentState,
      taskId: "FN-001",
      lastHeartbeatAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
    {
      id: "agent-003",
      name: "Test Agent 3",
      role: "custom" as AgentCapability,
      state: "paused" as AgentState,
      createdAt: new Date(Date.now() - 172800000).toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
    {
      id: "agent-004",
      name: "Test Agent 4",
      role: "reviewer" as AgentCapability,
      state: "terminated" as AgentState,
      createdAt: new Date(Date.now() - 259200000).toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchAgents.mockResolvedValue(mockAgents);
    mockFetchAgentStats.mockResolvedValue({ total: 4, byState: {}, byRole: {} });
    mockCreateAgent.mockResolvedValue(mockAgents[0]);
    mockUpdateAgentState.mockResolvedValue({ ...mockAgents[0], state: "active" });
    mockDeleteAgent.mockResolvedValue(undefined);
    mockStartAgentRun.mockResolvedValue({
      id: "run-001",
      agentId: "agent-001",
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active",
    });
  });

  describe("rendering", () => {
    it("renders the agents view header", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });
    });

    it("renders agent list on mount", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        // Active agents may appear in both ActiveAgentsPanel and main list
        expect(screen.getAllByText("Test Agent 1").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("Test Agent 2").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("fetches agents on mount", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalled();
      });
    });

    it("passes projectId to agent fetches", async () => {
      render(<AgentsView addToast={mockAddToast} projectId="proj_123" />);
      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledWith(undefined, "proj_123");
      });
    });

    it("renders empty state when no agents", async () => {
      mockFetchAgents.mockResolvedValue([]);
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        expect(screen.getByText("No agents found")).toBeTruthy();
        expect(screen.getByText("Create an agent to get started")).toBeTruthy();
      });
    });

    it("displays agent states", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        expect(screen.getAllByText("idle").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("active").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("paused").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("terminated").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("displays agent task when working on one", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        expect(screen.getAllByText("FN-001").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("shows refresh button", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      const refreshBtn = screen.getByTitle("Refresh");
      expect(refreshBtn).toBeTruthy();
    });
  });

  describe("view toggle (list/board)", () => {
    it("can toggle between list and board view", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getAllByText("Test Agent 1").length).toBeGreaterThanOrEqual(1);
      });

      // Initially should show list view (default)
      expect(document.querySelector(".agent-list")).toBeTruthy();

      // Switch to board view
      fireEvent.click(screen.getByTitle("Board view"));

      await waitFor(() => {
        expect(document.querySelector(".agent-board")).toBeTruthy();
      });

      // Switch back to list view
      fireEvent.click(screen.getByTitle("List view"));

      await waitFor(() => {
        expect(document.querySelector(".agent-list")).toBeTruthy();
      });
    });

    it("board view shows compact cards", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Board view"));

      await waitFor(() => {
        const boardCards = document.querySelectorAll(".agent-board-card");
        expect(boardCards.length).toBe(mockAgents.length);
      });
    });

    it("persists view toggle preference to localStorage", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Board view"));

      await waitFor(() => {
        expect(localStorage.getItem("kb-agent-view")).toBe("board");
      });
    });

    it("defaults to list view when no localStorage preference exists", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const listContainer = document.querySelector(".agent-list");
        expect(listContainer).toBeTruthy();
      });
    });

    it("marks board view button as active when in board mode", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      const boardBtn = screen.getByTitle("Board view");
      fireEvent.click(boardBtn);

      await waitFor(() => {
        expect(boardBtn.className).toContain("active");
        expect(boardBtn.getAttribute("aria-pressed")).toBe("true");
      });
    });
  });

  describe("filter agents by state", () => {
    it("renders the state filter with styled container", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Styled filter container exists
      const filterContainer = document.querySelector(".agent-state-filter");
      expect(filterContainer).toBeTruthy();

      // Select has correct aria-label
      const filterSelect = screen.getByLabelText("Filter agents by state");
      expect(filterSelect).toBeTruthy();
    });

    it("can filter agents by state", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "active" } });

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledWith({ state: "active" }, undefined);
      });
    });

    it("clears filter when selecting 'all'", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "idle" } });

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ state: "idle" }, undefined);
      });

      fireEvent.change(filterSelect, { target: { value: "all" } });

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith(undefined, undefined);
      });
    });
  });

  describe("create new agent", () => {
    it("can create new agent via multi-step dialog", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      // Open create dialog
      fireEvent.click(screen.getByText("New Agent"));

      // Step 0: Fill in agent name
      const nameInput = screen.getByPlaceholderText("e.g. Frontend Reviewer");
      fireEvent.change(nameInput, { target: { value: "My Agent" } });

      // Click Next to step 1
      fireEvent.click(screen.getByText("Next"));

      // Step 1: Model selection - click Next
      fireEvent.click(screen.getByText("Next"));

      // Step 2: Review - click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "My Agent",
            role: "custom",
          }),
          undefined,
        );
      });
    });

    it("shows create dialog when clicking New Agent button", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      expect(screen.getByPlaceholderText("e.g. Frontend Reviewer")).toBeTruthy();
    });

    it("does not allow proceeding with empty name", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      // Next button should be disabled when name is empty
      const nextBtn = screen.getByText("Next");
      expect(nextBtn.hasAttribute("disabled")).toBe(true);
    });

    it("handles creation error gracefully", async () => {
      mockCreateAgent.mockRejectedValue(new Error("Creation failed"));

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      const nameInput = screen.getByPlaceholderText("e.g. Frontend Reviewer");
      fireEvent.change(nameInput, { target: { value: "Fail Agent" } });

      // Navigate through steps
      fireEvent.click(screen.getByText("Next"));
      fireEvent.click(screen.getByText("Next"));
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        // Error should be shown somewhere (dialog or toast)
        const errorShown = screen.queryByText(/Creation failed/) !== null ||
          document.body.textContent?.includes("Creation failed");
        expect(errorShown).toBe(true);
      });
    });
  });

  describe("change agent state", () => {
    it("can change agent state - activate idle agent", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Activate"));

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "active", undefined);
        expect(mockStartAgentRun).toHaveBeenCalledWith("agent-001", undefined);
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("active"),
        "success"
      );
    });

    it("can pause active agent", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const agentCards = document.querySelectorAll(".agent-card");
        expect(agentCards.length).toBeGreaterThan(0);
      });

      // Find the active agent card
      const agentCards = document.querySelectorAll(".agent-card");
      let activeCard: Element | null = null;
      agentCards.forEach(card => {
        if (card.textContent?.includes("agent-002")) {
          activeCard = card;
        }
      });
      expect(activeCard).toBeTruthy();

      const pauseButton = activeCard?.querySelector('[title="Pause"]') as HTMLElement;
      expect(pauseButton).toBeTruthy();
      fireEvent.click(pauseButton);

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-002", "paused", undefined);
      });
    });

    it("can resume paused agent", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Resume")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Resume"));

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-003", "active", undefined);
        expect(mockStartAgentRun).toHaveBeenCalledWith("agent-003", undefined);
      });
    });

    it("handles state change error gracefully", async () => {
      mockUpdateAgentState.mockRejectedValue(new Error("State change failed"));

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Activate"));

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          expect.stringContaining("State change failed"),
          "error"
        );
      });
    });

    it("shows error toast when startAgentRun fails but still updates state", async () => {
      mockStartAgentRun.mockRejectedValue(new Error("Run failed"));

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Activate"));

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "active", undefined);
        expect(mockStartAgentRun).toHaveBeenCalledWith("agent-001", undefined);
        expect(mockAddToast).toHaveBeenCalledWith(
          expect.stringContaining("failed to start run"),
          "error"
        );
      });
    });

    it("does not start run when pausing agent", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const agentCards = document.querySelectorAll(".agent-card");
        expect(agentCards.length).toBeGreaterThan(0);
      });

      // Find the active agent card
      const agentCards = document.querySelectorAll(".agent-card");
      let activeCard: Element | null = null;
      agentCards.forEach(card => {
        if (card.textContent?.includes("agent-002")) {
          activeCard = card;
        }
      });

      const pauseButton = activeCard?.querySelector('[title="Pause"]') as HTMLElement;
      fireEvent.click(pauseButton);

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-002", "paused", undefined);
      });

      // startAgentRun should NOT be called when pausing
      expect(mockStartAgentRun).not.toHaveBeenCalled();
    });
  });

  describe("delete agent", () => {
    it("shows Delete button for idle and terminated agents", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        // There should be multiple Delete buttons: one for idle (agent-001) and one for terminated (agent-004)
        const deleteButtons = screen.getAllByTitle("Delete");
        expect(deleteButtons.length).toBeGreaterThanOrEqual(2);
      });
    });

    it("does not show Delete button for active or paused agents", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        // Find the active agent card (agent-002)
        const agentCards = document.querySelectorAll(".agent-card");
        let activeCard: Element | null = null;
        let pausedCard: Element | null = null;
        agentCards.forEach(card => {
          if (card.textContent?.includes("agent-002")) activeCard = card;
          if (card.textContent?.includes("agent-003")) pausedCard = card;
        });

        // Active and paused agents should not have delete buttons
        expect(activeCard?.querySelector('[title="Delete"]')).toBeFalsy();
        expect(pausedCard?.querySelector('[title="Delete"]')).toBeFalsy();
      });
    });

    it("confirms before deleting agent", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        // Click the delete button for the terminated agent (agent-004)
        const agentCards = document.querySelectorAll(".agent-card");
        let terminatedCard: Element | null = null;
        agentCards.forEach(card => {
          if (card.textContent?.includes("agent-004")) terminatedCard = card;
        });
        const terminatedDeleteBtn = terminatedCard?.querySelector('[title="Delete"]') as HTMLElement;
        expect(terminatedDeleteBtn).toBeTruthy();
        fireEvent.click(terminatedDeleteBtn);
      });

      expect(confirmSpy).toHaveBeenCalledWith(
        expect.stringContaining("Test Agent 4")
      );
      expect(mockDeleteAgent).not.toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it("deletes agent after confirmation", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getAllByTitle("Delete").length).toBeGreaterThanOrEqual(2);
      });

      // Find the delete button for terminated agent (agent-004)
      const agentCards = document.querySelectorAll(".agent-card");
      let terminatedCard: Element | null = null;
      agentCards.forEach(card => {
        if (card.textContent?.includes("agent-004")) terminatedCard = card;
      });
      const terminatedDeleteBtn = terminatedCard?.querySelector('[title="Delete"]') as HTMLElement;
      fireEvent.click(terminatedDeleteBtn);

      await waitFor(() => {
        expect(mockDeleteAgent).toHaveBeenCalledWith("agent-004", undefined);
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("deleted"),
        "success"
      );
    });

    it("deletes idle agent after confirmation", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getAllByTitle("Delete").length).toBeGreaterThanOrEqual(2);
      });

      // Find the delete button for idle agent (agent-001)
      const agentCards = document.querySelectorAll(".agent-card");
      let idleCard: Element | null = null;
      agentCards.forEach(card => {
        if (card.textContent?.includes("agent-001")) idleCard = card;
      });
      const idleDeleteBtn = idleCard?.querySelector('[title="Delete"]') as HTMLElement;
      fireEvent.click(idleDeleteBtn);

      await waitFor(() => {
        expect(mockDeleteAgent).toHaveBeenCalledWith("agent-001", undefined);
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("deleted"),
        "success"
      );
    });
  });

  describe("refresh functionality", () => {
    it("refreshes agent list when clicking refresh button", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Refresh")).toBeTruthy();
      });

      mockFetchAgents.mockClear();
      fireEvent.click(screen.getByTitle("Refresh"));

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalled();
      });
    });
  });
});
