import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentsView } from "../AgentsView";
import * as apiModule from "../../api";
import type { Agent, AgentState, AgentCapability, OrgTreeNode } from "../../api";
import { scopedKey } from "../../utils/projectStorage";

// Mock the API module
vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
  fetchAgentStats: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
  startAgentRun: vi.fn(),
  fetchOrgTree: vi.fn(),
  fetchSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 1 }),
  updateSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [] }),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
}));

vi.mock("../AgentDetailView", () => ({
  AgentDetailView: ({ agentId }: { agentId: string }) => <div data-testid="agent-detail-view">Agent detail: {agentId}</div>,
}));

const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const mockCreateAgent = vi.mocked(apiModule.createAgent);
const mockUpdateAgent = vi.mocked(apiModule.updateAgent);
const mockUpdateAgentState = vi.mocked(apiModule.updateAgentState);
const mockDeleteAgent = vi.mocked(apiModule.deleteAgent);
const mockStartAgentRun = vi.mocked(apiModule.startAgentRun);
const mockFetchOrgTree = vi.mocked((apiModule as any).fetchOrgTree);
const mockFetchAgentStats = vi.mocked((apiModule as any).fetchAgentStats);
const mockFetchSettings = vi.mocked((apiModule as any).fetchSettings);
const mockUpdateSettings = vi.mocked((apiModule as any).updateSettings);

describe("AgentsView", () => {
  const mockAddToast = vi.fn();
  const projectId = "proj_123";

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
      runtimeConfig: { heartbeatIntervalMs: 30000 },
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
    mockUpdateAgent.mockResolvedValue(mockAgents[0]);
    mockUpdateAgentState.mockResolvedValue({ ...mockAgents[0], state: "active" });
    mockDeleteAgent.mockResolvedValue(undefined);
    mockStartAgentRun.mockResolvedValue({
      id: "run-001",
      agentId: "agent-001",
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active",
    });
    mockFetchOrgTree.mockResolvedValue([]);
    mockFetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
    mockUpdateSettings.mockResolvedValue({});
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
      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);
      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledWith({ includeEphemeral: false }, projectId);
      });
    });

    it("renders empty state when no agents", async () => {
      mockFetchAgents.mockResolvedValue([]);
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        expect(screen.getByText("No agents found")).toBeTruthy();
        expect(screen.getByText("Create an agent to get started")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Create Agent" })).toBeTruthy();
      });
    });

    it("opens the create dialog from the empty state CTA", async () => {
      mockFetchAgents.mockResolvedValue([]);
      render(<AgentsView addToast={mockAddToast} />);

      const cta = await screen.findByRole("button", { name: "Create Agent" });
      fireEvent.click(cta);

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Create new agent" })).toBeTruthy();
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

    it("shows terminated agents when explicitly filtered", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Switch to terminated filter
      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "terminated" } });

      await waitFor(() => {
        expect(screen.getAllByText("terminated").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("displays agent task when working on one", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        expect(screen.getAllByText("FN-001").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("shows heartbeat interval control on agent cards with 5m minimum presets", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Set heartbeat interval for Test Agent 2")).toBeTruthy();
      });

      // Agent 2 has heartbeatIntervalMs: 30000 (30s) which should be clamped to 5m
      expect(screen.getByDisplayValue("5m")).toBeTruthy();

      // Verify all expected presets are present
      const select = screen.getByLabelText("Set heartbeat interval for Test Agent 2") as HTMLSelectElement;
      const options = Array.from(select.options).map(o => o.text);
      expect(options).toContain("5m");
      expect(options).toContain("48h");
      expect(options).toContain("72h");
      expect(options).toContain("1w");

      // Verify old sub-5m presets are NOT present
      expect(options).not.toContain("1s");
      expect(options).not.toContain("5s");
      expect(options).not.toContain("10s");
      expect(options).not.toContain("30s");
      expect(options).not.toContain("1m");
    });

    it("uses the system default heartbeat interval when runtime config is unset", async () => {
      mockFetchAgents.mockResolvedValue([
        {
          ...mockAgents[1],
          runtimeConfig: {},
        },
      ]);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Set heartbeat interval for Test Agent 2")).toBeTruthy();
      });

      const intervalSelect = screen.getByLabelText("Set heartbeat interval for Test Agent 2") as HTMLSelectElement;
      expect(intervalSelect.value).toBe("3600000");
      expect(intervalSelect.options[intervalSelect.selectedIndex]?.text).toBe("1h");
    });

    it("updates agent heartbeat interval from preset dropdown", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Set heartbeat interval for Test Agent 2")).toBeTruthy();
      });

      // Change from 5m (clamped from 30s) to 15m
      const intervalSelect = screen.getByLabelText("Set heartbeat interval for Test Agent 2");
      fireEvent.change(intervalSelect, { target: { value: "900000" } });

      await waitFor(() => {
        expect(mockUpdateAgent).toHaveBeenCalledWith(
          "agent-002",
          expect.objectContaining({
            runtimeConfig: expect.objectContaining({ heartbeatIntervalMs: 900000 }),
          }),
          undefined,
        );
      });
    });

    it("shows Custom... option in dropdown that reveals typed input", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Set heartbeat interval for Test Agent 2")).toBeTruthy();
      });

      const intervalSelect = screen.getByLabelText("Set heartbeat interval for Test Agent 2") as HTMLSelectElement;

      // Change to Custom... option
      fireEvent.change(intervalSelect, { target: { value: "__custom__" } });

      await waitFor(() => {
        // Should show custom input with minutes field
        expect(screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      });
    });

    it("can enter custom minutes value and save it", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Set heartbeat interval for Test Agent 2")).toBeTruthy();
      });

      // Select Custom... option
      const intervalSelect = screen.getByLabelText("Set heartbeat interval for Test Agent 2");
      fireEvent.change(intervalSelect, { target: { value: "__custom__" } });

      await waitFor(() => {
        expect(screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2")).toBeTruthy();
      });

      // Enter 7 minutes
      const customInput = screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2");
      fireEvent.change(customInput, { target: { value: "7" } });

      // Click Save
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        // Should save 7 minutes = 420000 ms
        expect(mockUpdateAgent).toHaveBeenCalledWith(
          "agent-002",
          expect.objectContaining({
            runtimeConfig: expect.objectContaining({ heartbeatIntervalMs: 420000 }),
          }),
          undefined,
        );
      });
    });

    it("clamps custom value 1-4 minutes to 5 minutes with info toast", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Set heartbeat interval for Test Agent 2")).toBeTruthy();
      });

      // Select Custom... option
      const intervalSelect = screen.getByLabelText("Set heartbeat interval for Test Agent 2");
      fireEvent.change(intervalSelect, { target: { value: "__custom__" } });

      await waitFor(() => {
        expect(screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2")).toBeTruthy();
      });

      // Enter 3 minutes
      const customInput = screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2");
      fireEvent.change(customInput, { target: { value: "3" } });

      // Click Save
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        // Should save 5 minutes (minimum) = 300000 ms
        expect(mockUpdateAgent).toHaveBeenCalledWith(
          "agent-002",
          expect.objectContaining({
            runtimeConfig: expect.objectContaining({ heartbeatIntervalMs: 300000 }),
          }),
          undefined,
        );
        // Should show info toast about clamping
        expect(mockAddToast).toHaveBeenCalledWith(
          expect.stringContaining("5 minutes (minimum)"),
          "success",
        );
      });
    });

    it("does not save when custom input is empty", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Set heartbeat interval for Test Agent 2")).toBeTruthy();
      });

      // Select Custom... option
      const intervalSelect = screen.getByLabelText("Set heartbeat interval for Test Agent 2");
      fireEvent.change(intervalSelect, { target: { value: "__custom__" } });

      await waitFor(() => {
        expect(screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2")).toBeTruthy();
      });

      // Clear the pre-filled value to empty
      const customInput = screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2");
      fireEvent.change(customInput, { target: { value: "" } });

      // Wait for state to update
      await waitFor(() => {
        expect((customInput as HTMLInputElement).value).toBe("");
      });

      // Click Save with empty input
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      // Should not call updateAgent
      expect(mockUpdateAgent).not.toHaveBeenCalled();
      // Should show error toast
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("enter a heartbeat interval"),
        "error",
      );
    });

    it("does not save when custom input is non-numeric", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Set heartbeat interval for Test Agent 2")).toBeTruthy();
      });

      // Select Custom... option
      const intervalSelect = screen.getByLabelText("Set heartbeat interval for Test Agent 2");
      fireEvent.change(intervalSelect, { target: { value: "__custom__" } });

      await waitFor(() => {
        expect(screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2")).toBeTruthy();
      });

      // Clear and enter non-numeric value
      const customInput = screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2");
      fireEvent.change(customInput, { target: { value: "abc" } });

      // Wait for state to update
      await waitFor(() => {
        expect((customInput as HTMLInputElement).value).toBe("abc");
      });

      // Click Save
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      // Should not call updateAgent
      expect(mockUpdateAgent).not.toHaveBeenCalled();
      // Should show error toast
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("valid number"),
        "error",
      );
    });

    it("does not save when custom input is zero or negative", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Set heartbeat interval for Test Agent 2")).toBeTruthy();
      });

      // Select Custom... option
      const intervalSelect = screen.getByLabelText("Set heartbeat interval for Test Agent 2");
      fireEvent.change(intervalSelect, { target: { value: "__custom__" } });

      await waitFor(() => {
        expect(screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2")).toBeTruthy();
      });

      // Enter 0
      const customInput = screen.getByLabelText("Custom heartbeat interval in minutes for Test Agent 2");
      fireEvent.change(customInput, { target: { value: "0" } });

      // Wait for state to update
      await waitFor(() => {
        expect((customInput as HTMLInputElement).value).toBe("0");
      });

      // Click Save
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      // Should not call updateAgent
      expect(mockUpdateAgent).not.toHaveBeenCalled();
      // Should show error toast
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("greater than 0"),
        "error",
      );
    });

    it("shows refresh button", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      // Use findBy to ensure React has flushed all pending state updates before asserting.
      // This prevents act(...) warnings from any async effects triggered during render.
      const refreshBtn = await screen.findByTitle("Refresh");
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
        expect(boardCards.length).toBe(4);
      });
    });

    it("persists view toggle preference to project-scoped localStorage", async () => {
      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);

      await waitFor(() => {
        expect(screen.getByText("Agents")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Board view"));

      await waitFor(() => {
        expect(localStorage.getItem(scopedKey("fn-agent-view", projectId))).toBe("board");
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

  describe("Org Chart view", () => {
    const orgTree: OrgTreeNode[] = [
      {
        agent: {
          id: "agent-root-1",
          name: "Chief Agent",
          role: "scheduler",
          state: "active",
          lastHeartbeatAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
        children: [
          {
            agent: {
              id: "agent-child-1",
              name: "Director One",
              role: "executor",
              state: "running",
              lastHeartbeatAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              metadata: {},
            },
            children: [
              {
                agent: {
                  id: "agent-grandchild-1",
                  name: "Manager Alpha",
                  role: "reviewer",
                  state: "idle",
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  metadata: {},
                },
                children: [],
              },
            ],
          },
          {
            agent: {
              id: "agent-child-2",
              name: "Director Two",
              role: "triage",
              state: "paused",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              metadata: {},
            },
            children: [],
          },
        ],
      },
      {
        agent: {
          id: "agent-root-2",
          name: "Independent Lead",
          role: "engineer",
          state: "error",
          lastError: "Agent stalled",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
        children: [],
      },
    ];

    it("renders org chart toggle with aria attributes and activates org view", async () => {
      mockFetchOrgTree.mockResolvedValue(orgTree);
      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);

      const orgButton = screen.getByRole("button", { name: "Org Chart view" });
      expect(orgButton.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(orgButton);

      await waitFor(() => {
        expect(orgButton.className).toContain("active");
        expect(orgButton.getAttribute("aria-pressed")).toBe("true");
      });

      await waitFor(() => {
        expect(mockFetchOrgTree).toHaveBeenCalledWith(projectId, { includeEphemeral: false });
      });
    });

    it("renders org chart nodes and opens detail view when clicking a node", async () => {
      mockFetchOrgTree.mockResolvedValue(orgTree);
      render(<AgentsView addToast={mockAddToast} />);

      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      await waitFor(() => {
        expect(screen.getByText("Chief Agent")).toBeTruthy();
        expect(screen.getByText("Director One")).toBeTruthy();
        expect(screen.getByText("Manager Alpha")).toBeTruthy();
        expect(screen.getByText("Independent Lead")).toBeTruthy();
        expect(screen.getAllByText(/Healthy|Idle|Paused|Unresponsive|Agent stalled/).length).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getByText("Director One"));

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("agent-child-1");
      });
    });

    it("shows org chart empty state when API returns no nodes", async () => {
      mockFetchOrgTree.mockResolvedValue([]);
      render(<AgentsView addToast={mockAddToast} />);

      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      await waitFor(() => {
        expect(screen.getByText("No agents found")).toBeTruthy();
        expect(screen.getByText("Create an agent to get started")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Create Agent" })).toBeTruthy();
      });
    });

    it("shows loading state while org chart request is in flight", async () => {
      let resolveOrgTree: ((value: OrgTreeNode[]) => void) | undefined;
      mockFetchOrgTree.mockImplementation(
        () =>
          new Promise<OrgTreeNode[]>((resolve) => {
            resolveOrgTree = resolve;
          }),
      );

      render(<AgentsView addToast={mockAddToast} />);
      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      await waitFor(() => {
        expect(screen.getByText("Loading org chart...")).toBeTruthy();
      });

      resolveOrgTree?.([]);

      await waitFor(() => {
        expect(screen.queryByText("Loading org chart...")).toBeNull();
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
        expect(mockFetchAgents).toHaveBeenCalledWith({ state: "active", includeEphemeral: false }, undefined);
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
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ state: "idle", includeEphemeral: false }, undefined);
      });

      fireEvent.change(filterSelect, { target: { value: "all" } });

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ includeEphemeral: false }, undefined);
      });
    });
  });

  describe("show system agents toggle", () => {
    it("renders the system agents checkbox", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Show system agents")).toBeTruthy();
      });

      // Checkbox should be unchecked by default
      const checkbox = screen.getByLabelText("Show system agents") as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });

    it("passes includeEphemeral: false by default to fetchAgents", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Default call should include includeEphemeral: false
      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ includeEphemeral: false }, undefined);
      });
    });

    it("toggles system agents visibility when checkbox is clicked", async () => {
      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      const checkbox = screen.getByLabelText("Show system agents");
      fireEvent.click(checkbox);

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ includeEphemeral: true }, projectId);
      });
    });

    it("combines system agents toggle with state filter", async () => {
      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // First enable system agents toggle
      const checkbox = screen.getByLabelText("Show system agents");
      fireEvent.click(checkbox);

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ includeEphemeral: true }, projectId);
      });

      // Then filter by state
      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "active" } });

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ state: "active", includeEphemeral: true }, projectId);
      });
    });

    it("shows system agents in agent list when checkbox is enabled", async () => {
      const systemAgents: Agent[] = [
        {
          id: "agent-sys-001",
          name: "executor-FN-TEST",
          role: "executor" as AgentCapability,
          state: "terminated" as AgentState,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: { agentKind: "task-worker" },
        },
      ];

      // Mock returns only normal agents by default (excluding terminated)
      mockFetchAgents.mockResolvedValue(mockAgents.slice(0, 3));

      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);

      await waitFor(() => {
        expect(screen.getByText("Test Agent 1")).toBeTruthy();
      });

      // Normal agents should be visible
      expect(screen.queryByText("executor-FN-TEST")).toBeNull();

      // Update mock to return system agents too (next call)
      mockFetchAgents.mockResolvedValueOnce([...mockAgents.slice(0, 3), ...systemAgents]);

      // Enable system agents toggle
      const checkbox = screen.getByLabelText("Show system agents");
      fireEvent.click(checkbox);

      // Now the agents should be reloaded with system agents included
      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledWith({ includeEphemeral: true }, projectId);
        expect(screen.getByText("executor-FN-TEST")).toBeTruthy();
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

      // Wait for the dialog to settle after the model fetch completes
      await waitFor(() => {
        expect(screen.getByPlaceholderText("e.g. Frontend Reviewer")).toBeTruthy();
      });
    });

    it("does not allow proceeding with empty name", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      // Wait for the dialog to settle after the model fetch completes
      await waitFor(() => {
        const nextBtn = screen.getByText("Next");
        expect(nextBtn).toBeTruthy();
      });

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

  describe("Run Now button", () => {
    it("shows Run Now button for active agent without taskId", async () => {
      const activeWithoutTaskId = { ...mockAgents[1] };
      delete activeWithoutTaskId.taskId;
      mockFetchAgents.mockResolvedValue([
        mockAgents[0],
        activeWithoutTaskId,
        mockAgents[2],
        mockAgents[3],
      ]);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Run Now")).toBeTruthy();
      });
    });

    it("Run Now button calls startAgentRun for active agent without taskId", async () => {
      const activeWithoutTaskId = { ...mockAgents[1] };
      delete activeWithoutTaskId.taskId;
      mockFetchAgents.mockResolvedValue([
        mockAgents[0],
        activeWithoutTaskId,
        mockAgents[2],
        mockAgents[3],
      ]);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Run Now")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Run Now"));

      await waitFor(() => {
        expect(mockStartAgentRun).toHaveBeenCalledWith(
          "agent-002",
          undefined,
          expect.objectContaining({
            source: "on_demand",
            triggerDetail: "Triggered from dashboard",
          }),
        );
      });
    });
  });

  describe("delete agent", () => {
    it("shows Delete button for idle and terminated agents in default view", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const deleteButtons = screen.getAllByTitle("Delete");
        expect(deleteButtons.length).toBeGreaterThanOrEqual(2);
      });

      expect(screen.getByText("Test Agent 4")).toBeTruthy();
    });

    it("shows Delete button for terminated agents when explicitly filtered", async () => {
      render(<AgentsView addToast={mockAddToast} />);

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

    it("confirms before deleting terminated agent (from terminated filter)", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Switch to terminated filter to see terminated agent
      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "terminated" } });

      await waitFor(() => {
        expect(screen.getByText("Test Agent 4")).toBeTruthy();
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

    it("deletes terminated agent after confirmation (from terminated filter)", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("All States")).toBeTruthy();
      });

      // Switch to terminated filter to see terminated agent
      const filterSelect = screen.getByDisplayValue("All States");
      fireEvent.change(filterSelect, { target: { value: "terminated" } });

      await waitFor(() => {
        expect(screen.getByText("Test Agent 4")).toBeTruthy();
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

    it("deletes idle agent after confirmation (from default view)", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const deleteButtons = screen.getAllByTitle("Delete");
        expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
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

  describe("active agents panel selection", () => {
    it("renders active agents panel when agents are active", async () => {
      // agent-002 is active with taskId FN-001
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Active Agents (1)")).toBeTruthy();
      });

      // Should have a live agent card for the active agent
      const liveAgentCards = document.querySelectorAll(".live-agent-card");
      expect(liveAgentCards.length).toBe(1);
    });

    it("opens AgentDetailView when clicking an active agent card", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Active Agents (1)")).toBeTruthy();
      });

      // Find and click the live agent card
      const liveAgentCard = document.querySelector(".live-agent-card");
      expect(liveAgentCard).toBeTruthy();

      fireEvent.click(liveAgentCard!);

      await waitFor(() => {
        // Should open detail view for agent-002 (the active agent)
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("agent-002");
      });
    });

    it("opens AgentDetailView when pressing Enter on an active agent card", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Active Agents (1)")).toBeTruthy();
      });

      // Find the live agent card
      const liveAgentCard = document.querySelector(".live-agent-card") as HTMLElement;
      expect(liveAgentCard).toBeTruthy();

      // Focus and press Enter
      liveAgentCard.focus();
      fireEvent.keyDown(liveAgentCard, { key: "Enter" });

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("agent-002");
      });
    });

    it("opens AgentDetailView when pressing Space on an active agent card", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Active Agents (1)")).toBeTruthy();
      });

      // Find the live agent card
      const liveAgentCard = document.querySelector(".live-agent-card") as HTMLElement;
      expect(liveAgentCard).toBeTruthy();

      // Focus and press Space
      liveAgentCard.focus();
      fireEvent.keyDown(liveAgentCard, { key: " " });

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("agent-002");
      });
    });

    it("live agent cards have proper accessibility attributes", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Active Agents (1)")).toBeTruthy();
      });

      const liveAgentCard = document.querySelector(".live-agent-card") as HTMLElement;
      expect(liveAgentCard).toBeTruthy();

      // Check accessibility attributes
      expect(liveAgentCard.getAttribute("role")).toBe("button");
      expect(liveAgentCard.getAttribute("tabIndex")).toBe("0");
      expect(liveAgentCard.getAttribute("aria-label")).toBe("Select agent Test Agent 2");
    });

    it("does not show active agents panel when no agents are active", async () => {
      // Create agents with no active ones
      const inactiveAgents: Agent[] = [
        {
          id: "agent-005",
          name: "Idle Agent",
          role: "executor" as AgentCapability,
          state: "idle" as AgentState,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
      ];
      mockFetchAgents.mockResolvedValue(inactiveAgents);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.queryByText("Active Agents")).toBeNull();
      });
    });

    it("opens AgentDetailView for spawned agents in the active panel", async () => {
      // Simulate spawned agents by having multiple active agents
      const spawnedAgents: Agent[] = [
        ...mockAgents,
        {
          id: "spawned-001",
          name: "Spawned Worker",
          role: "custom" as AgentCapability,
          state: "active" as AgentState,
          taskId: "FN-100",
          lastHeartbeatAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        },
      ];
      mockFetchAgents.mockResolvedValue(spawnedAgents);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Active Agents (2)")).toBeTruthy();
      });

      // Find and click the spawned agent card
      const liveAgentCards = document.querySelectorAll(".live-agent-card");
      expect(liveAgentCards.length).toBe(2);

      // Click on the spawned agent
      const spawnedCard = Array.from(liveAgentCards).find(
        card => card.textContent?.includes("Spawned Worker")
      );
      expect(spawnedCard).toBeTruthy();

      fireEvent.click(spawnedCard!);

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("spawned-001");
      });
    });
  });

  describe("global heartbeat multiplier", () => {
    it("renders the global heartbeat speed control", async () => {
      mockFetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Heartbeat Speed")).toBeTruthy();
      });

      // Check the slider and preset are rendered
      expect(screen.getByRole("slider", { name: "Heartbeat Speed" })).toBeTruthy();
      expect(screen.getByLabelText("Heartbeat speed preset")).toBeTruthy();

      // Check helper text
      expect(screen.getByText(/Scales all agent heartbeat intervals/)).toBeTruthy();
    });

    it("loads heartbeat multiplier from settings", async () => {
      mockFetchSettings.mockResolvedValue({ heartbeatMultiplier: 2.5 });
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const slider = screen.getByRole("slider", { name: "Heartbeat Speed" }) as HTMLInputElement;
        expect(slider.value).toBe("2.5");
      });
    });

    it("saves heartbeat multiplier when slider changes", async () => {
      mockFetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Heartbeat Speed")).toBeTruthy();
      });

      // Change the slider
      const slider = screen.getByRole("slider", { name: "Heartbeat Speed" });
      fireEvent.change(slider, { target: { value: "3" } });

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith({ heartbeatMultiplier: 3 }, undefined);
        expect(mockAddToast).toHaveBeenCalledWith("Heartbeat speed set to ×3.0", "success");
      });
    });

    it("saves heartbeat multiplier when preset is selected", async () => {
      mockFetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Heartbeat Speed")).toBeTruthy();
      });

      // Change the preset
      const preset = screen.getByLabelText("Heartbeat speed preset") as HTMLSelectElement;
      fireEvent.change(preset, { target: { value: "0.5" } });

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith({ heartbeatMultiplier: 0.5 }, undefined);
      });
    });

    it("disables control while saving", async () => {
      mockFetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
      mockUpdateSettings.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByLabelText("Heartbeat Speed")).toBeTruthy();
      });

      // Change the slider - this should start the save
      const slider = screen.getByRole("slider", { name: "Heartbeat Speed" });
      fireEvent.change(slider, { target: { value: "2" } });

      // Both controls should be disabled while saving
      await waitFor(() => {
        expect(slider).toBeDisabled();
      });
    });
  });
});
