import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { AgentListModal } from "../AgentListModal";
import * as apiModule from "../../api";
import type { Agent, AgentState, AgentCapability } from "../../api";
import { scopedKey } from "../../utils/projectStorage";

// Mock the API module
vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const mockCreateAgent = vi.mocked(apiModule.createAgent);
const mockUpdateAgentState = vi.mocked(apiModule.updateAgentState);
const mockDeleteAgent = vi.mocked(apiModule.deleteAgent);

import { loadAllAppCss } from "../../test/cssFixture";
const readStyles = () => loadAllAppCss();

describe("AgentListModal", () => {
  const mockOnClose = vi.fn();
  const mockAddToast = vi.fn();
  const TEST_PROJECT_ID = "proj-123";
  const AGENT_VIEW_KEY = scopedKey("fn-agent-view", TEST_PROJECT_ID);

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
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockFetchAgents.mockResolvedValue(mockAgents);
    mockCreateAgent.mockResolvedValue(mockAgents[0]);
    mockUpdateAgentState.mockResolvedValue({ ...mockAgents[0], state: "active" });
    mockDeleteAgent.mockResolvedValue(undefined);
  });

  describe("modal visibility", () => {
    it("renders when isOpen is true", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });
    });

    it("does not render when isOpen is false", () => {
      const { container } = render(
        <AgentListModal
          isOpen={false}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it("calls onClose when clicking the overlay", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      const overlay = document.querySelector(".modal-overlay");
      if (overlay) {
        fireEvent.click(overlay);
        expect(mockOnClose).toHaveBeenCalled();
      }
    });

    it("calls onClose when clicking the close button", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        const closeButton = screen.getByRole("button", { name: "Close" });
        expect(closeButton).toBeTruthy();
      });

      const closeButton = screen.getByRole("button", { name: "Close" });
      fireEvent.click(closeButton);
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe("agent list display", () => {
    it("fetches agents on mount", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalled();
      });
    });

    it("displays agent names", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Test Agent 1")).toBeTruthy();
        expect(screen.getByText("Test Agent 2")).toBeTruthy();
      });
    });

    it("displays agent states as badges", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("idle")).toBeTruthy();
        expect(screen.getByText("active")).toBeTruthy();
        expect(screen.getByText("paused")).toBeTruthy();
        // Terminated agents are hidden in default "All States" view
        expect(screen.queryByText("terminated")).toBeNull();
      });
    });

    it("shows terminated agents when explicitly filtered", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Switch to terminated filter
      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "terminated" } });

      await waitFor(() => {
        expect(screen.getByText("terminated")).toBeTruthy();
        expect(screen.getByText("Test Agent 4")).toBeTruthy();
      });
    });

    it("displays agent roles", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Executor")).toBeTruthy();
        expect(screen.getByText("Triage")).toBeTruthy();
      });
    });

    it("displays task ID when agent is working on a task", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("FN-001")).toBeTruthy();
      });
    });

    it("shows empty state when no agents exist", async () => {
      mockFetchAgents.mockResolvedValue([]);

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("No agents found")).toBeTruthy();
        expect(screen.getByText("Create an agent to get started")).toBeTruthy();
      });
    });

    it("shows health status for agents", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        // Active agent with heartbeat should show "Healthy"
        expect(screen.getByText("Healthy")).toBeTruthy();
      });
    });

    it("renders health badges via data attributes instead of inline color styles", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      const healthyBadge = await screen.findByText("Healthy");
      const badge = healthyBadge.closest(".agent-list-health-badge") as HTMLElement | null;

      expect(badge).toBeTruthy();
      expect(badge).toHaveAttribute("data-health", "active");
      expect(badge).not.toHaveAttribute("style");
    });
  });

  describe("agent creation", () => {
    it("shows create form when clicking New Agent button", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      const newAgentButton = screen.getByText("New Agent");
      fireEvent.click(newAgentButton);

      expect(screen.getByPlaceholderText("Agent name...")).toBeTruthy();
    });

    it("creates agent with name and role", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      // Open create form
      fireEvent.click(screen.getByText("New Agent"));

      // Fill in agent name
      const nameInput = screen.getByPlaceholderText("Agent name...");
      fireEvent.change(nameInput, { target: { value: "My New Agent" } });

      // Select role - find by class within the create form
      const roleSelect = document.querySelector(".agent-create-form .select") as HTMLSelectElement;
      expect(roleSelect).toBeTruthy();
      fireEvent.change(roleSelect, { target: { value: "executor" } });

      // Click create button
      const createButton = screen.getByText("Create");
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledWith(
          {
            name: "My New Agent",
            role: "executor",
          },
          undefined
        );
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("My New Agent"),
        "success"
      );
    });

    it("does not create agent with empty name", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      const createButton = screen.getByText("Create");
      fireEvent.click(createButton);

      expect(mockCreateAgent).not.toHaveBeenCalled();
    });

    it("handles creation error gracefully", async () => {
      mockCreateAgent.mockRejectedValue(new Error("Creation failed"));

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      const nameInput = screen.getByPlaceholderText("Agent name...");
      fireEvent.change(nameInput, { target: { value: "Fail Agent" } });

      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          expect.stringContaining("Creation failed"),
          "error"
        );
      });
    });
  });

  describe("agent state changes", () => {
    it("shows Start button for idle agents", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        const startButtons = screen.getAllByTitle("Activate");
        expect(startButtons.length).toBeGreaterThan(0);
      });
    });

    it("transitions idle agent to active", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      const startButton = screen.getByTitle("Activate");
      fireEvent.click(startButton);

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "active", undefined);
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("active"),
        "success"
      );
    });

    it("shows Pause and Stop buttons for active agents", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        // Get all agent cards and find the one with active state
        const agentCards = document.querySelectorAll(".agent-card");
        expect(agentCards.length).toBeGreaterThan(0);
      });

      // Find the agent card for the active agent (agent-002)
      const agentCards = document.querySelectorAll(".agent-card");
      let activeCard: Element | null = null;
      agentCards.forEach(card => {
        if (card.textContent?.includes("agent-002")) {
          activeCard = card;
        }
      });
      expect(activeCard).toBeTruthy();

      // Check for Pause and Stop buttons within the active card
      const pauseButton = activeCard?.querySelector('[title="Pause"]');
      const stopButton = activeCard?.querySelector('[title="Stop"]');
      expect(pauseButton).toBeTruthy();
      expect(stopButton).toBeTruthy();
    });

    it("pauses active agent", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        const agentCards = document.querySelectorAll(".agent-card");
        expect(agentCards.length).toBeGreaterThan(0);
      });

      // Find the agent card for the active agent (agent-002)
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

    it("stops active agent", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        const agentCards = document.querySelectorAll(".agent-card");
        expect(agentCards.length).toBeGreaterThan(0);
      });

      // Find the agent card for the active agent (agent-002)
      const agentCards = document.querySelectorAll(".agent-card");
      let activeCard: Element | null = null;
      agentCards.forEach(card => {
        if (card.textContent?.includes("agent-002")) {
          activeCard = card;
        }
      });
      expect(activeCard).toBeTruthy();

      const stopButton = activeCard?.querySelector('[title="Stop"]') as HTMLElement;
      expect(stopButton).toBeTruthy();
      fireEvent.click(stopButton);

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-002", "terminated", undefined);
      });
    });

    it("shows Resume button for paused agents", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Resume")).toBeTruthy();
      });
    });

    it("resumes paused agent", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Resume")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Resume"));

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-003", "active", undefined);
      });
    });

    it("shows Start button for terminated agents", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "terminated" } });

      await waitFor(() => {
        expect(screen.getByTitle("Start")).toBeTruthy();
      });
    });

    it("starts terminated agent", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "terminated" } });

      await waitFor(() => {
        expect(screen.getByTitle("Start")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Start"));

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-004", "active", undefined);
      });
    });

    it("optimistically updates list card state before API resolves", async () => {
      let resolveTransition: (() => void) | null = null;
      const transitionPromise = new Promise<Agent>((resolve) => {
        resolveTransition = () => resolve({ ...mockAgents[0], state: "active" });
      });
      mockUpdateAgentState.mockImplementationOnce(() => transitionPromise);

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Activate"));

      await waitFor(() => {
        const agentCards = Array.from(document.querySelectorAll(".agent-card"));
        const targetCard = agentCards.find((card) => card.textContent?.includes("agent-001"));
        expect(targetCard?.textContent).toContain("active");
        expect(targetCard?.querySelector('[title="Pause"]')).toBeTruthy();
      });

      resolveTransition?.();
      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "active", undefined);
      });
    });

    it("rolls back optimistic list state when API call fails", async () => {
      let rejectTransition: ((error: Error) => void) | null = null;
      const transitionPromise = new Promise<Agent>((_, reject) => {
        rejectTransition = reject;
      });
      mockUpdateAgentState.mockImplementationOnce(() => transitionPromise);

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Activate"));

      await waitFor(() => {
        const agentCards = Array.from(document.querySelectorAll(".agent-card"));
        const targetCard = agentCards.find((card) => card.textContent?.includes("agent-001"));
        expect(targetCard?.textContent).toContain("active");
      });

      rejectTransition?.(new Error("Invalid transition"));

      await waitFor(() => {
        const agentCards = Array.from(document.querySelectorAll(".agent-card"));
        const targetCard = agentCards.find((card) => card.textContent?.includes("agent-001"));
        expect(targetCard?.textContent).toContain("idle");
      });
    });

    it("prevents concurrent state changes while transition is in-flight", async () => {
      let resolveTransition: (() => void) | null = null;
      const transitionPromise = new Promise<Agent>((resolve) => {
        resolveTransition = () => resolve({ ...mockAgents[0], state: "active" });
      });
      mockUpdateAgentState.mockImplementationOnce(() => transitionPromise);

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Activate"));

      await waitFor(() => {
        const agentCards = Array.from(document.querySelectorAll(".agent-card"));
        const targetCard = agentCards.find((card) => card.textContent?.includes("agent-001"));
        const pauseButton = targetCard?.querySelector('[title="Pause"]') as HTMLButtonElement | null;
        expect(pauseButton).toBeTruthy();
        expect(pauseButton?.disabled).toBe(true);
      });

      const agentCards = Array.from(document.querySelectorAll(".agent-card"));
      const targetCard = agentCards.find((card) => card.textContent?.includes("agent-001"));
      const pauseButton = targetCard?.querySelector('[title="Pause"]') as HTMLButtonElement | null;
      if (pauseButton) {
        fireEvent.click(pauseButton);
      }

      expect(mockUpdateAgentState).toHaveBeenCalledTimes(1);

      resolveTransition?.();
      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "active", undefined);
      });
    });

    it("handles state change errors gracefully", async () => {
      mockUpdateAgentState.mockRejectedValue(new Error("Invalid transition"));

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Activate"));

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          expect.stringContaining("Invalid transition"),
          "error"
        );
      });
    });
  });

  describe("agent deletion", () => {
    it("shows Delete button for idle agents in default view (terminated filtered out)", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        // In default "All States" view, only idle agent (agent-001) should have delete button
        // Terminated agents (agent-004) are filtered out
        const deleteButtons = screen.getAllByTitle("Delete");
        expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
      });

      // Verify terminated agent is not visible
      expect(screen.queryByText("Test Agent 4")).toBeNull();
    });

    it("shows Delete button for terminated agents when explicitly filtered", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Switch to terminated filter
      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "terminated" } });

      await waitFor(() => {
        expect(screen.getByText("Test Agent 4")).toBeTruthy();
        // Now we should see the Delete button for terminated agent
        expect(screen.getAllByTitle("Delete").length).toBeGreaterThanOrEqual(1);
      });

      // Verify Start button appears for terminated agent
      const agentCards = document.querySelectorAll(".agent-card");
      let terminatedCard: Element | null = null;
      agentCards.forEach(card => {
        if (card.textContent?.includes("agent-004")) terminatedCard = card;
      });
      const terminatedStartBtn = terminatedCard?.querySelector('[title="Start"]');
      expect(terminatedStartBtn).toBeTruthy();
    });

    it("confirms before deleting terminated agent (from terminated filter)", async () => {
      mockConfirm.mockResolvedValueOnce(false);

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Switch to terminated filter to see terminated agent
      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "terminated" } });

      await waitFor(() => {
        expect(screen.getByText("Test Agent 4")).toBeTruthy();
        expect(screen.getAllByTitle("Delete").length).toBeGreaterThanOrEqual(1);
      });

      // Find delete button for terminated agent (agent-004)
      const agentCards = document.querySelectorAll(".agent-card");
      let terminatedCard: Element | null = null;
      agentCards.forEach(card => {
        if (card.textContent?.includes("agent-004")) terminatedCard = card;
      });
      const terminatedDeleteBtn = terminatedCard?.querySelector('[title="Delete"]') as HTMLElement;
      fireEvent.click(terminatedDeleteBtn);

      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Delete Agent",
        message: 'Delete agent "Test Agent 4"? This cannot be undone.',
        danger: true,
      });
      expect(mockDeleteAgent).not.toHaveBeenCalled();
    });

    it("deletes terminated agent after confirmation (from terminated filter)", async () => {

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Switch to terminated filter to see terminated agent
      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "terminated" } });

      await waitFor(() => {
        expect(screen.getByText("Test Agent 4")).toBeTruthy();
      });

      // Find delete button for terminated agent (agent-004)
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

    it("deletes idle agent after confirmation (from default view)", async () => {

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        // Only idle agent (agent-001) should have delete button in default view
        // Terminated agent (agent-004) is filtered out
        const deleteButtons = screen.getAllByTitle("Delete");
        expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
      });

      // Find delete button for idle agent (agent-001)
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

    it("handles deletion error gracefully", async () => {
      mockDeleteAgent.mockRejectedValue(new Error("Delete failed"));

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        // Only idle agent (agent-001) should have delete button in default view
        const deleteButtons = screen.getAllByTitle("Delete");
        expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
      });

      // Click the idle agent's delete button
      const agentCards = document.querySelectorAll(".agent-card");
      let idleCard: Element | null = null;
      agentCards.forEach(card => {
        if (card.textContent?.includes("agent-001")) idleCard = card;
      });
      const idleDeleteBtn = idleCard?.querySelector('[title="Delete"]') as HTMLElement;
      fireEvent.click(idleDeleteBtn);

      await waitFor(() => {
        expect(mockAddToast).toHaveBeenCalledWith(
          expect.stringContaining("Delete failed"),
          "error"
        );
      });
    });
  });

  describe("agent filtering", () => {
    it("filters agents by state", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      const filterSelect = screen.getByLabelText("Filter agents by state");
      fireEvent.change(filterSelect, { target: { value: "active" } });

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledWith({ state: "active" }, undefined);
      });
    });

    it("clears filter when selecting 'all'", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      const filterSelect = screen.getByLabelText("Filter agents by state");
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

  describe("refresh functionality", () => {
    it("refreshes agent list when clicking refresh button", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

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

  describe("CSS variables for agent states", () => {
    it("uses CSS variables for agent state badges via global styles.css", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      const styles = readStyles();
      expect(styles).toContain('.agent-list-modal .agent-board-badge[data-state="idle"]');
      expect(styles).toContain('var(--state-idle-bg)');
      expect(styles).toContain('.agent-list-modal .agent-list-state-badge[data-state="error"]');
      expect(styles).toContain('.agent-list-modal .agent-list-health-badge[data-health="active"]');
      expect(styles).toContain('.agent-list-modal .agent-board-health[data-health="error"]');
    });
  });

  describe("create form styling parity", () => {
    it("renders create form with dashboard token-based styling", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      // The create form container is rendered
      const createForm = document.querySelector(".agent-create-form");
      expect(createForm).toBeTruthy();

      const styles = readStyles();
      expect(styles).toContain('.agent-list-modal .agent-create-form');
      expect(styles).toContain('border-radius: var(--radius-md)');
      expect(styles).not.toMatch(/\.agent-list-modal \.agent-create-form\s*\{[^}]*border-radius:\s*8px/);
    });

    it("create form input and select use theme tokens", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      const styles = readStyles();
      expect(styles).toContain('.agent-list-modal .agent-create-form .input');
      expect(styles).toContain('.agent-list-modal .agent-create-form .input');
      expect(styles).toContain('flex: 1;');
      expect(styles).toContain('min-width: 0;');
      expect(styles).toContain('var(--surface)');
      expect(styles).toContain('var(--text)');
      expect(styles).toContain('var(--border)');
      expect(styles).toContain('var(--radius-sm)');
      expect(styles).toContain('var(--focus-ring)');
      expect(styles).not.toMatch(/background:\s*#fff/);
      expect(styles).not.toMatch(/background:\s*white/);
    });

    it("renders filter with styled container matching AgentsView", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Styled filter container exists
      const filterContainer = document.querySelector(".agent-state-filter");
      expect(filterContainer).toBeTruthy();

      // Select has correct aria-label
      const filterSelect = screen.getByLabelText("Filter agents by state");
      expect(filterSelect).toBeTruthy();
      expect(filterSelect).toHaveValue("all");
    });

    it("filter CSS uses dashboard tokens for border-radius", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      const styles = readStyles();
      expect(styles).toContain('.agent-state-filter {');
      expect(styles).toContain('border-radius: var(--radius-sm)');
      expect(styles).toContain('.agent-state-filter:hover');
      expect(styles).toContain('.agent-state-filter:focus-within');
    });
  });

  describe("view toggle", () => {
    beforeEach(() => {
      // Clear localStorage before each test
      localStorage.clear();
    });

    it("toggles between board and list views", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      // Initially should show list view (default)
      const boardButton = screen.getByTitle("Board view");
      const listButton = screen.getByTitle("List view");

      expect(boardButton).toBeTruthy();
      expect(listButton).toBeTruthy();

      // Click board view button
      fireEvent.click(boardButton);

      // Should now show board layout (agent-board class)
      await waitFor(() => {
        const boardContainer = document.querySelector(".agent-board");
        expect(boardContainer).toBeTruthy();
      });

      // Click list view button
      fireEvent.click(listButton);

      // Should now show list layout (agent-list class)
      await waitFor(() => {
        const listContainer = document.querySelector(".agent-list");
        expect(listContainer).toBeTruthy();
      });
    });

    it("persists view preference to project-scoped localStorage", async () => {
      const { unmount } = render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
          projectId={TEST_PROJECT_ID}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      // Click board view button
      fireEvent.click(screen.getByTitle("Board view"));

      await waitFor(() => {
        expect(localStorage.getItem(AGENT_VIEW_KEY)).toBe("board");
      });

      // Unmount and remount to test persistence
      unmount();

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
          projectId={TEST_PROJECT_ID}
        />
      );

      await waitFor(() => {
        // Should restore board view from localStorage
        const boardContainer = document.querySelector(".agent-board");
        expect(boardContainer).toBeTruthy();
      });
    });

    it("board view shows compact agent cards", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      // Switch to board view
      fireEvent.click(screen.getByTitle("Board view"));

      await waitFor(() => {
        // Board view should render compact cards
        // 4 agents total, but terminated (agent-004) is filtered out in default view
        const boardCards = document.querySelectorAll(".agent-board-card");
        expect(boardCards.length).toBe(3);
      });

      // Check that board view elements are present
      expect(document.querySelector(".agent-board-icon")).toBeTruthy();
      expect(document.querySelector(".agent-board-name")).toBeTruthy();
      expect(document.querySelector(".agent-board-badge")).toBeTruthy();

      // Board view should NOT have the detailed card body elements
      const cardBodies = document.querySelectorAll(".agent-card-body");
      expect(cardBodies.length).toBe(0);
    });

    it("board view cards show action buttons", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      // Switch to board view
      fireEvent.click(screen.getByTitle("Board view"));

      await waitFor(() => {
        const boardCards = document.querySelectorAll(".agent-board-card");
        expect(boardCards.length).toBeGreaterThan(0);
      });

      // Find an idle agent card and verify Start button exists
      const startButtons = document.querySelectorAll(".agent-board-actions .btn");
      expect(startButtons.length).toBeGreaterThan(0);

      // Click a start button to verify it works
      const firstStartButton = startButtons[0] as HTMLElement;
      fireEvent.click(firstStartButton);

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalled();
      });
    });

    it("defaults to list view when no localStorage preference exists", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        // Should default to list view (detailed card layout)
        const listContainer = document.querySelector(".agent-list");
        expect(listContainer).toBeTruthy();

        // Detailed cards should be present
        // 4 agents total, but terminated (agent-004) is filtered out in default view
        const agentCards = document.querySelectorAll(".agent-card");
        expect(agentCards.length).toBe(3);
      });
    });
  });

  describe("modal styling and layout hooks", () => {
    it("uses modal--wide sizing class on the modal container", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      // Modal uses the wide variant
      const modal = document.querySelector(".modal.modal--wide");
      expect(modal).toBeTruthy();
    });

    it("renders modal-title element for header consistency", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        const title = document.querySelector(".modal-title");
        expect(title).toBeTruthy();
        expect(title?.textContent).toContain("Agents");
      });
    });

    it("renders content area with agent-modal-content class", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        const content = document.querySelector(".agent-modal-content");
        expect(content).toBeTruthy();
      });
    });

    it("board/list toggle still switches containers after styling changes", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      // Default is list
      expect(document.querySelector(".agent-list")).toBeTruthy();
      expect(document.querySelector(".agent-board")).toBeFalsy();

      // Switch to board
      fireEvent.click(screen.getByTitle("Board view"));

      await waitFor(() => {
        expect(document.querySelector(".agent-board")).toBeTruthy();
      });
      expect(document.querySelector(".agent-list")).toBeFalsy();

      // Switch back to list
      fireEvent.click(screen.getByTitle("List view"));

      await waitFor(() => {
        expect(document.querySelector(".agent-list")).toBeTruthy();
      });
      expect(document.querySelector(".agent-board")).toBeFalsy();
    });

    it("controls bar has wrapper classes that allow responsive stacking", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      // Controls container exists
      const controls = document.querySelector(".agent-controls");
      expect(controls).toBeTruthy();

      // Filter container exists with its wrapper class
      const filter = document.querySelector(".agent-state-filter");
      expect(filter).toBeTruthy();
    });

    it("create form retains stackable wrapper class", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      // Create form has its class
      const form = document.querySelector(".agent-create-form");
      expect(form).toBeTruthy();

      // Input and select are present inside the form
      const input = form?.querySelector(".input");
      const select = form?.querySelector(".select");
      expect(input).toBeTruthy();
      expect(select).toBeTruthy();
    });

    it("cards have hover transition affordances in CSS", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      const styles = readStyles();
      expect(styles).toContain('.agent-list-modal .agent-card:hover');
      expect(styles).toContain('.agent-list-modal .agent-board-card:hover');
      expect(styles).toContain('transition: background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);');
    });

    it("CSS includes responsive media queries for mobile", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      const styles = readStyles();

      expect(styles).toContain("@media (max-width: 768px)");
      expect(styles).toContain("@media (max-width: 640px)");
      expect(styles).toContain("grid-template-columns: repeat(auto-fill, minmax(calc(var(--space-xl) * 6 + var(--space-lg)), 1fr))");
      expect(styles).toContain(".agent-list-modal .agent-controls");
      expect(styles).toContain(".agent-list-modal .agent-create-form");
      expect(styles).toContain("grid-template-columns: 1fr");
    });

    it("no regressions in open/close behavior after styling changes", async () => {
      const { unmount } = render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      // Close via close button
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(mockOnClose).toHaveBeenCalledTimes(1);

      // Unmount and verify closed state works
      unmount();

      const { container } = render(
        <AgentListModal
          isOpen={false}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      expect(container.firstChild).toBeNull();
    });
  });
});
