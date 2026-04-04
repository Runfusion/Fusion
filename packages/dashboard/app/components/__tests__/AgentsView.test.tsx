import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentsView } from "../AgentsView";
import * as apiModule from "../../api";
import type { Agent, AgentState, AgentCapability } from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
}));

const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const mockCreateAgent = vi.mocked(apiModule.createAgent);
const mockUpdateAgentState = vi.mocked(apiModule.updateAgentState);
const mockDeleteAgent = vi.mocked(apiModule.deleteAgent);

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
    mockCreateAgent.mockResolvedValue(mockAgents[0]);
    mockUpdateAgentState.mockResolvedValue({ ...mockAgents[0], state: "active" });
    mockDeleteAgent.mockResolvedValue(undefined);
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
        expect(screen.getByText("Test Agent 1")).toBeTruthy();
        expect(screen.getByText("Test Agent 2")).toBeTruthy();
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
        expect(screen.getByText("idle")).toBeTruthy();
        expect(screen.getByText("active")).toBeTruthy();
        expect(screen.getByText("paused")).toBeTruthy();
        expect(screen.getByText("terminated")).toBeTruthy();
      });
    });

    it("displays agent task when working on one", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        expect(screen.getByText("FN-001")).toBeTruthy();
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
        expect(screen.getByText("Test Agent 1")).toBeTruthy();
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
      expect(filterSelect).toHaveValue("all");
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
    it("can create new agent", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      // Open create form
      fireEvent.click(screen.getByText("New Agent"));

      // Fill in agent name
      const nameInput = screen.getByPlaceholderText("Agent name...");
      fireEvent.change(nameInput, { target: { value: "My Agent" } });

      // Click create button
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockCreateAgent).toHaveBeenCalledWith({
          name: "My Agent",
          role: "custom",
        }, undefined);
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("My Agent"),
        "success"
      );
    });

    it("shows create form when clicking New Agent button", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      expect(screen.getByPlaceholderText("Agent name...")).toBeTruthy();
    });

    it("does not create agent with empty name", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));
      fireEvent.click(screen.getByText("Create"));

      expect(mockCreateAgent).not.toHaveBeenCalled();
    });

    it("handles creation error gracefully", async () => {
      mockCreateAgent.mockRejectedValue(new Error("Creation failed"));

      render(<AgentsView addToast={mockAddToast} />);

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

    it("renders create form with dashboard token-based styling", async () => {
      render(<AgentsView addToast={mockAddToast} />);

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
      render(<AgentsView addToast={mockAddToast} />);

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
  });

  describe("delete agent", () => {
    it("shows Delete button only for terminated agents", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Delete")).toBeTruthy();
      });
    });

    it("confirms before deleting agent", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

      render(<AgentsView addToast={mockAddToast} />);

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

      render(<AgentsView addToast={mockAddToast} />);

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
