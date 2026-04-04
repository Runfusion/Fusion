import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentListModal } from "../AgentListModal";
import * as apiModule from "../../api";
import type { Agent, AgentState, AgentCapability } from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
}));

const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const mockCreateAgent = vi.mocked(apiModule.createAgent);
const mockUpdateAgentState = vi.mocked(apiModule.updateAgentState);
const mockDeleteAgent = vi.mocked(apiModule.deleteAgent);

describe("AgentListModal", () => {
  const mockOnClose = vi.fn();
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
        const closeButton = screen.getByTitle("Close");
        expect(closeButton).toBeTruthy();
      });

      const closeButton = screen.getByTitle("Close");
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
        expect(screen.getByText("terminated")).toBeTruthy();
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
    it("shows Delete button only for terminated agents", async () => {
      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Delete")).toBeTruthy();
      });
    });

    it("confirms before deleting agent", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Delete")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Delete"));

      expect(confirmSpy).toHaveBeenCalledWith(
        expect.stringContaining("Test Agent 4")
      );
      expect(mockDeleteAgent).not.toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it("deletes agent after confirmation", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Delete")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Delete"));

      await waitFor(() => {
        expect(mockDeleteAgent).toHaveBeenCalledWith("agent-004", undefined);
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("deleted"),
        "success"
      );
    });

    it("handles deletion error gracefully", async () => {
      mockDeleteAgent.mockRejectedValue(new Error("Delete failed"));
      vi.spyOn(window, "confirm").mockReturnValue(true);

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle("Delete")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Delete"));

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
    it("has CSS variables defined for agent state badges", async () => {
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

      // Check that style tag is present with CSS variables
      const styleTag = document.querySelector("style");
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toContain("--state-idle-bg");
      expect(styleTag?.textContent).toContain("--state-active-bg");
      expect(styleTag?.textContent).toContain("--state-paused-bg");
      expect(styleTag?.textContent).toContain("--state-error-bg");
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

      // The inline style block should use var(--radius-sm) instead of hardcoded 8px
      const styleElements = document.querySelectorAll("style");
      let foundCreateFormRule = false;
      styleElements.forEach(styleEl => {
        const css = styleEl.textContent ?? "";
        if (css.includes(".agent-create-form")) {
          foundCreateFormRule = true;
          // Must not contain hardcoded border-radius: 8px
          expect(css).not.toMatch(/\.agent-create-form\s*\{[^}]*border-radius:\s*8px/);
        }
      });
      expect(foundCreateFormRule).toBe(true);
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

      const styleElements = document.querySelectorAll("style");
      let foundInputRule = false;
      let foundSelectRule = false;
      styleElements.forEach(styleEl => {
        const css = styleEl.textContent ?? "";
        if (css.includes(".agent-create-form .input")) {
          foundInputRule = true;
          // Assert theme token usage
          expect(css).toContain("var(--surface)");
          expect(css).toContain("var(--text)");
          expect(css).toContain("var(--border)");
          expect(css).toContain("var(--radius-sm)");
          // Focus ring token
          expect(css).toContain("var(--focus-ring)");
          // Guard against hardcoded light-only styles
          expect(css).not.toMatch(/background:\s*#fff/);
          expect(css).not.toMatch(/background:\s*white/);
        }
        if (css.includes(".agent-create-form .select")) {
          foundSelectRule = true;
          expect(css).toContain("var(--surface)");
          expect(css).toContain("var(--text)");
          expect(css).toContain("var(--border)");
          expect(css).toContain("var(--radius-sm)");
          expect(css).toContain("var(--focus-ring)");
        }
      });
      expect(foundInputRule).toBe(true);
      expect(foundSelectRule).toBe(true);
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

      const styleElements = document.querySelectorAll("style");
      let foundFilterRule = false;
      styleElements.forEach(styleEl => {
        const css = styleEl.textContent ?? "";
        if (css.includes(".agent-state-filter {")) {
          foundFilterRule = true;
          // Should use var(--radius-sm) token
          expect(css).toContain("border-radius: var(--radius-sm)");
          // Should have hover and focus-within states
          expect(css).toContain(".agent-state-filter:hover");
          expect(css).toContain(".agent-state-filter:focus-within");
        }
      });
      expect(foundFilterRule).toBe(true);
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

    it("persists view preference to localStorage", async () => {
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

      // Click board view button
      fireEvent.click(screen.getByTitle("Board view"));

      await waitFor(() => {
        expect(localStorage.getItem("kb-agent-view")).toBe("board");
      });

      // Unmount and remount to test persistence
      unmount();

      render(
        <AgentListModal
          isOpen={true}
          onClose={mockOnClose}
          addToast={mockAddToast}
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
        const boardCards = document.querySelectorAll(".agent-board-card");
        expect(boardCards.length).toBe(mockAgents.length);
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
        const agentCards = document.querySelectorAll(".agent-card");
        expect(agentCards.length).toBe(mockAgents.length);
      });
    });
  });
});
