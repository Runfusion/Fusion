import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { loadAllAppCss } from "../../test/cssFixture";
import { AgentsView } from "../AgentsView";
import * as apiModule from "../../api";
import type { Agent, AgentState, AgentCapability, OrgTreeNode } from "../../api";
import { scopedKey } from "../../utils/projectStorage";
import { ORG_CHART_LAYOUT_STORAGE_KEY } from "../agentsOrgChartLayout";

// Mock the API module
vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
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
    fetchPluginRuntimes: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    startAgentOnboardingStreaming: vi.fn().mockResolvedValue({ sessionId: "onb-1" }),
    respondToAgentOnboarding: vi.fn().mockResolvedValue({ type: "question", data: { id: "q1", type: "text", question: "?" } }),
    retryAgentOnboardingSession: vi.fn().mockResolvedValue({ success: true, sessionId: "onb-1" }),
    stopAgentOnboardingGeneration: vi.fn().mockResolvedValue({ success: true }),
    cancelAgentOnboarding: vi.fn().mockResolvedValue(undefined),
  });
});

vi.mock("../ExperimentalAgentOnboardingModal", () => ({
  ExperimentalAgentOnboardingModal: ({ isOpen, onClose, onUseDraft }: { isOpen: boolean; onClose: () => void; onUseDraft: (draft: any) => void }) => {
    if (!isOpen) return null;
    return (
      <div role="dialog" aria-label="AI Interview">
        <p>Draft ready for review</p>
        <button type="button" onClick={onClose}>Cancel</button>
        <button
          type="button"
          onClick={() =>
            onUseDraft({
              name: "Interview Draft Agent",
              role: "reviewer",
              title: "Drafted Title",
              instructionsText: "Drafted instructions",
              thinkingLevel: "low",
              maxTurns: 10,
            })
          }
        >
          Apply draft to agent form
        </button>
      </div>
    );
  },
}));

vi.mock("../AgentDetailView", () => ({
  AgentDetailView: ({ agentId, inline, onClose, showInlineBackButton, initialTab, initialRunId, preferActiveRun, onMutationSuccess }: { agentId: string; inline?: boolean; onClose?: () => void; showInlineBackButton?: boolean; initialTab?: string; initialRunId?: string | null; preferActiveRun?: boolean; onMutationSuccess?: (context: { agentId: string; deleted?: boolean }) => void | Promise<void> }) => (
    <div data-testid="agent-detail-view" data-inline={inline ? "true" : "false"} data-initial-tab={initialTab ?? "dashboard"} data-initial-run-id={initialRunId ?? ""} data-prefer-active-run={preferActiveRun ? "true" : "false"}>
      {showInlineBackButton ? (
        <button type="button" aria-label="Back to agents" onClick={onClose}>Agents</button>
      ) : null}
      <button type="button" onClick={() => void onMutationSuccess?.({ agentId })}>Trigger detail mutation success</button>
      Agent detail: {agentId}
    </div>
  ),
  relativeTime: () => "just now",
}));

const mockViewportMode = vi.fn<() => "mobile" | "tablet" | "desktop">(() => "desktop");

vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => mockViewportMode(),
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
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
const mockClipboardWriteText = vi.fn();
const mockResizeObserverObserve = vi.fn();
const mockResizeObserverDisconnect = vi.fn();

describe("AgentsView", () => {
  const mockAddToast = vi.fn();
  const projectId = "proj_123";

  const mockAgents: Agent[] = [
    {
      id: "agent-001",
      name: "Test Agent 1",
      role: "executor" as AgentCapability,
      state: "idle" as AgentState,
      totalInputTokens: 100,
      totalOutputTokens: 20,
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
      totalInputTokens: 10,
      totalOutputTokens: 5,
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
      state: "error" as AgentState,
      totalInputTokens: 1,
      totalOutputTokens: 1,
      createdAt: new Date(Date.now() - 259200000).toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class {
      observe = mockResizeObserverObserve;
      disconnect = mockResizeObserverDisconnect;
    });
    mockViewportMode.mockReturnValue("desktop");
    mockClipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mockClipboardWriteText },
    });
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
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

  const openControlsPanel = async () => {
    const trigger = await screen.findByRole("button", { name: "Controls" });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Agent controls" })).toBeTruthy();
    });
    return trigger;
  };

  const openOverviewPanel = async () => {
    const toggle = await screen.findByRole("button", { name: /Overview/i });
    if (toggle.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(toggle);
    }
    await waitFor(() => {
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });
    return toggle;
  };

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

    it("shows pending approval badge when agent has pending approvals", async () => {
      mockFetchAgents.mockResolvedValueOnce([
        { ...mockAgents[0], id: "agent-pending", name: "Pending Agent", pendingApprovalCount: 2 },
      ]);
      mockFetchAgentStats.mockResolvedValueOnce({ total: 1, byState: {}, byRole: {} });

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Pending approvals")).toBeInTheDocument();
        expect(screen.getByText("2")).toBeInTheDocument();
      });
    });

    it("formats skill badge labels from SKILL.md paths", async () => {
      mockFetchAgents.mockResolvedValueOnce([
        {
          ...mockAgents[0],
          id: "agent-skills",
          name: "Skill Agent",
          metadata: {
            skills: ["auto::skills/../../.agents/skills/review/SKILL.md"],
          },
        },
      ]);
      mockFetchAgentStats.mockResolvedValueOnce({ total: 1, byState: {}, byRole: {} });

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("review")).toBeInTheDocument();
      });
      expect(screen.queryByText("auto::skills/../../.agents/skills/review/SKILL.md")).toBeNull();
      expect(screen.getByText("review")).toHaveAttribute("title", "auto::skills/../../.agents/skills/review/SKILL.md");
    });

    it("renders cross-pane overview above split layout", async () => {
      const { container } = render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(container.querySelector(".agents-overview-bar")).toBeTruthy();
        expect(container.querySelector(".agents-split-layout")).toBeTruthy();
      });

      const overview = container.querySelector(".agents-overview-bar");
      const splitLayout = container.querySelector(".agents-split-layout");
      expect(overview?.nextElementSibling).toBe(splitLayout);
      const sidebar = container.querySelector(".agents-split-sidebar");
      expect(sidebar).toBeTruthy();
      expect(sidebar?.querySelector(".agents-overview-bar")).toBeNull();
      expect(container.querySelector(".agents-split-detail")).toBeTruthy();
      expect(screen.getByText("Select an agent")).toBeInTheDocument();
      expect(screen.getByText("Choose an agent from the sidebar to view details")).toBeInTheDocument();
    });

    it("opens inline detail pane and marks selected card", async () => {
      const { container } = render(<AgentsView addToast={mockAddToast} />);

      const detailButton = await screen.findByRole("button", { name: "View details for Test Agent 1" });
      fireEvent.click(detailButton);

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveAttribute("data-inline", "true");
      });

      expect(container.querySelector(".agent-card--selected")).toBeTruthy();
    });

    it("keeps desktop selection in detail pane without rendering sidebar quick-controls strip", async () => {
      const { container } = render(<AgentsView addToast={mockAddToast} />);

      const detailButton = await screen.findByRole("button", { name: "View details for Test Agent 2" });
      fireEvent.click(detailButton);

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveAttribute("data-inline", "true");
      });

      expect(container.querySelector(".agent-card--selected")).toBeTruthy();
      expect(container.querySelector(".agents-sidebar-quick-controls")).toBeNull();
    });

    it("supports mobile drill-in detail with back navigation", async () => {
      mockViewportMode.mockReturnValue("mobile");
      const { container } = render(<AgentsView addToast={mockAddToast} />);

      expect(container.querySelector(".agents-split-layout")).toBeTruthy();
      expect(container.querySelector(".agents-view-content")).toBeTruthy();
      expect(container.querySelector(".agents-split-sidebar")).toBeTruthy();
      expect(container.querySelector(".agents-split-detail--hidden-mobile")).toBeTruthy();

      fireEvent.click(await screen.findByRole("button", { name: "View details for Test Agent 1" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Back to agents" })).toBeTruthy();
        expect(screen.getByTestId("agent-detail-view")).toHaveAttribute("data-inline", "true");
      });

      expect(container.querySelector(".agents-split-sidebar--hidden-mobile")).toBeTruthy();
      expect(container.querySelector(".agents-split-detail--hidden-mobile")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Back to agents" }));

      await waitFor(() => {
        expect(screen.getByText("Select an agent")).toBeInTheDocument();
      });
      expect(container.querySelector(".agents-split-detail--hidden-mobile")).toBeTruthy();
    });

    it("closes mobile detail and shows org chart when switching views", async () => {
      mockViewportMode.mockReturnValue("mobile");
      mockFetchOrgTree.mockResolvedValue([
        {
          agent: {
            id: "agent-org-1",
            name: "Org Lead",
            role: "scheduler",
            state: "active",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: {},
          },
          children: [],
        },
      ]);

      render(<AgentsView addToast={mockAddToast} />);

      fireEvent.click(await screen.findByRole("button", { name: "View details for Test Agent 1" }));
      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      await waitFor(() => {
        expect(screen.queryByTestId("agent-detail-view")).toBeNull();
        expect(screen.getByTestId("agent-org-chart")).toBeTruthy();
        expect(screen.getByText("Org Lead")).toBeTruthy();
      });
    });

    it("collapses mobile overview after selecting an active agent card", async () => {
      mockViewportMode.mockReturnValue("mobile");
      render(<AgentsView addToast={mockAddToast} />);

      const overviewToggle = await openOverviewPanel();
      fireEvent.click(await screen.findByRole("button", { name: /select agent test agent 2/i }));

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("agent-002");
        expect(overviewToggle.getAttribute("aria-expanded")).toBe("false");
      });
    });

    it("keeps desktop overview open after selecting an active agent card", async () => {
      mockViewportMode.mockReturnValue("desktop");
      render(<AgentsView addToast={mockAddToast} />);

      const overviewToggle = await openOverviewPanel();
      fireEvent.click(await screen.findByRole("button", { name: /select agent test agent 2/i }));

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("agent-002");
        expect(overviewToggle.getAttribute("aria-expanded")).toBe("true");
      });
    });

    it("shows a loading indicator while the initial agents fetch is pending", async () => {
      let resolveAgents: ((value: Agent[]) => void) | undefined;
      mockFetchAgents.mockImplementationOnce(
        () =>
          new Promise<Agent[]>((resolve) => {
            resolveAgents = resolve;
          }),
      );

      render(<AgentsView addToast={mockAddToast} />);

      const loadingStatus = await screen.findByRole("status");
      expect(loadingStatus).toHaveTextContent("Loading agents...");
      expect(loadingStatus.getAttribute("aria-live")).toBe("polite");

      resolveAgents?.(mockAgents);
      await waitFor(() => {
        expect(screen.queryByText("Loading agents...")).toBeNull();
      });
    });

    it("hides the loading indicator once agents finish loading", async () => {
      let resolveAgents: ((value: Agent[]) => void) | undefined;
      mockFetchAgents.mockImplementationOnce(
        () =>
          new Promise<Agent[]>((resolve) => {
            resolveAgents = resolve;
          }),
      );

      render(<AgentsView addToast={mockAddToast} />);

      expect(await screen.findByText("Loading agents...")).toBeTruthy();

      resolveAgents?.(mockAgents);

      await waitFor(() => {
        expect(screen.queryByText("Loading agents...")).toBeNull();
        expect(screen.getAllByText("Test Agent 1").length).toBeGreaterThan(0);
      });
    });

    it("keeps existing agents visible during refresh loads", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getAllByText("Test Agent 1").length).toBeGreaterThan(0);
      });

      let resolveRefresh: ((value: Agent[]) => void) | undefined;
      mockFetchAgents.mockImplementationOnce(
        () =>
          new Promise<Agent[]>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

      fireEvent.click(screen.getByTitle("Refresh"));

      await waitFor(() => {
        expect(screen.queryByText("Loading agents...")).toBeNull();
        expect(screen.getAllByText("Test Agent 1").length).toBeGreaterThan(0);
      });

      resolveRefresh?.(mockAgents);
      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledTimes(2);
      });
    });

    it("keeps New Agent directly accessible on desktop while controls live in popup", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      expect(screen.getByRole("button", { name: "New Agent" })).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: "Agent controls" })).toBeNull();

      await openControlsPanel();
      expect(screen.getByLabelText("Filter agents by state")).toBeTruthy();
      expect(screen.getByLabelText("Show system agents")).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Import" }).length).toBeGreaterThan(0);
      expect(screen.getByRole("slider", { name: "Heartbeat Speed" })).toBeTruthy();
      expect(screen.getByLabelText("Heartbeat speed preset")).toBeTruthy();
    });

    it("moves import and new-agent actions into the controls popup on mobile", async () => {
      mockViewportMode.mockReturnValue("mobile");
      render(<AgentsView addToast={mockAddToast} />);

      expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
      expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull();

      await openControlsPanel();
      expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "New Agent" })).toBeTruthy();
    });

    it("closes controls popup on Escape and outside click", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      const trigger = await openControlsPanel();

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Agent controls" })).toBeNull();
      });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(trigger);
      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Agent controls" })).toBeTruthy();
      });

      fireEvent.mouseDown(document.body);
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Agent controls" })).toBeNull();
      });
    });

    it("keeps metrics and active agents collapsed behind overview disclosure by default", async () => {
      const { container } = render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(container.querySelector(".agent-list")).toBeTruthy();
      });

      const overviewToggle = screen.getByRole("button", { name: /Overview/i });
      expect(overviewToggle.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector(".agent-metrics-bar")).toBeNull();
      expect(container.querySelector(".active-agents-panel")).toBeNull();

      fireEvent.click(overviewToggle);

      await waitFor(() => {
        expect(overviewToggle.getAttribute("aria-expanded")).toBe("true");
        expect(container.querySelector(".agent-metrics-bar")).toBeTruthy();
        expect(container.querySelector(".active-agents-panel")).toBeTruthy();
      });
    });

    it("fetches agents only once on mount (regression: no duplicate initial load path)", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledTimes(1);
        expect(mockFetchAgentStats).toHaveBeenCalledTimes(1);
      });

      // Ensure the single-load path still powers dependent UI sections.
      await openOverviewPanel();
      expect(await screen.findByText("Active Agents (1)")).toBeTruthy();
    });

    it("renders token stats derived from the currently displayed agents", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      // Token-usage panel now lives inside the controls popup, not in the
      // main view body — open the controls panel before asserting.
      await openControlsPanel();

      await waitFor(() => {
        expect(screen.getByText("Token Usage by Agent")).toBeTruthy();
      });

      expect(screen.getByText("Input Tokens")).toBeTruthy();
      expect(screen.getByText("111")).toBeTruthy();
      expect(screen.getByText("Output Tokens")).toBeTruthy();
      expect(screen.getByText("26")).toBeTruthy();
      expect(screen.getByText("Combined Tokens")).toBeTruthy();
      expect(screen.getByText("137")).toBeTruthy();

      const tokenRows = screen.getAllByRole("row");
      expect(tokenRows[1]).toHaveTextContent("Test Agent 1");
      expect(tokenRows[2]).toHaveTextContent("Test Agent 2");
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
        expect(screen.getAllByText("error").length).toBeGreaterThanOrEqual(1);
      });
    });

    describe("active agent card highlight", () => {
      it.each(["active", "running"] as const)("applies active highlight state classes across views for %s agents", async (state) => {
        const highlightAgent: Agent = {
          id: `agent-highlight-${state}`,
          name: `Highlight ${state}`,
          role: "executor",
          state,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        };

        mockFetchAgents.mockResolvedValue([highlightAgent]);
        mockFetchAgentStats.mockResolvedValue({ total: 1, byState: { [state]: 1 }, byRole: { executor: 1 } });
        mockFetchOrgTree.mockResolvedValue([{ agent: highlightAgent, children: [] }]);

        render(<AgentsView addToast={mockAddToast} />);

        await waitFor(() => {
          expect(document.querySelector(`.agent-card--${state}`)).toBeTruthy();
        });

        fireEvent.click(screen.getByRole("button", { name: "Board view" }));
        await waitFor(() => {
          expect(document.querySelector(`.agent-board-card--${state}`)).toBeTruthy();
        });

        fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));
        await waitFor(() => {
          expect(document.querySelector(`.org-chart-node-card--${state}`)).toBeTruthy();
        });
      });

      it("keeps paused agents out of active highlight classes", async () => {
        render(<AgentsView addToast={mockAddToast} />);

        const pausedAgentCard = await screen.findByText("Test Agent 3");
        const pausedCard = pausedAgentCard.closest(".agent-card");

        expect(pausedCard).toBeTruthy();
        expect(pausedCard?.classList.contains("agent-card--paused")).toBe(true);
        expect(pausedCard?.classList.contains("agent-card--active")).toBe(false);
      });
    });

    it("displays agent task when working on one", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await waitFor(() => {
        expect(screen.getAllByText("FN-001").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("renders explicit View Details button on list cards", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "View details for Test Agent 1" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "View details for Test Agent 2" })).toBeTruthy();
      });

      expect(screen.getAllByText("Details").length).toBeGreaterThanOrEqual(4);
    });

    it("keeps a visible icon affordance on split-sidebar action buttons when labels are compacted", async () => {
      const { container } = render(<AgentsView addToast={mockAddToast} />);

      const sidebarCard = await waitFor(() => {
        const card = container.querySelector(".agents-split-sidebar .agent-card");
        expect(card).toBeTruthy();
        return card as HTMLElement;
      });
      const actions = sidebarCard.querySelector(".agent-card-actions");
      const primaryGroup = sidebarCard.querySelector(".agent-card-actions-group--primary");
      const secondaryGroup = sidebarCard.querySelector(".agent-card-actions-group--secondary");
      const detailsButton = within(sidebarCard).getByRole("button", { name: "View details for Test Agent 1" });

      expect(actions).toBeTruthy();
      expect(primaryGroup).toBeTruthy();
      expect(secondaryGroup).toBeTruthy();
      expect(primaryGroup?.querySelector("button")).toBeTruthy();
      expect(secondaryGroup?.contains(detailsButton)).toBe(true);
      expect(detailsButton.querySelector("svg")).toBeTruthy();
      expect(sidebarCard.querySelectorAll(".agent-card-action-label").length).toBeGreaterThan(0);
    });

    it("uses a grid-and-wrap containment contract for split-sidebar action rows", () => {
      const css = loadAllAppCss();

      expect(css).toMatch(/\.agent-card-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*\}/);
      expect(css).toMatch(/\.agent-card-actions-group\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;[^}]*\}/);
      expect(css).not.toContain(".agents-split-sidebar .agent-card-actions .agent-card-action-label {\n  display: none;\n}");
      expect(css).toContain("@container agent-card-actions (max-width: calc(var(--space-2xl) * 9))");
      expect(css).toContain(".agents-split-sidebar .agent-card-actions {\n    grid-template-columns: minmax(0, 1fr);\n  }");
      expect(css).toContain(".agents-split-sidebar .agent-card-actions .agent-card-action-label {\n    display: none;\n  }");
    });

    it("opens matching detail view when clicking View Details button", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "View details for Test Agent 3" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "View details for Test Agent 3" }));

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("agent-003");
      });
    });

    it("refreshes left-pane list immediately when detail pane reports a successful mutation", async () => {
      mockFetchAgents
        .mockResolvedValueOnce(mockAgents)
        .mockResolvedValueOnce([
          { ...mockAgents[0], name: "Renamed Agent" },
          ...mockAgents.slice(1),
        ]);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getAllByText("Test Agent 1").length).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getByRole("button", { name: "View details for Test Agent 1" }));
      fireEvent.click(await screen.findByRole("button", { name: "Trigger detail mutation success" }));

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledTimes(2);
        expect(screen.getAllByText("Renamed Agent").length).toBeGreaterThan(0);
      });
    });

    it("opens detail view when clicking anywhere on the agent card body", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getAllByText("Test Agent 1").length).toBeGreaterThan(0);
      });

      const clickableCard = Array.from(document.querySelectorAll(".agent-card--clickable")).find((element) =>
        element.textContent?.includes("Test Agent 1"),
      ) as HTMLElement | undefined;
      expect(clickableCard).toBeTruthy();

      fireEvent.click(clickableCard!);

      await waitFor(() => {
        const detail = screen.getByTestId("agent-detail-view");
        expect(detail).toHaveTextContent("agent-001");
        expect(detail).toHaveAttribute("data-initial-tab", "dashboard");
        expect(detail).toHaveAttribute("data-initial-run-id", "");
      });
    });

    it("opens agent detail in Runs context when clicking Running control", async () => {
      const runningAgent: Agent = {
        id: "agent-005",
        name: "Runner",
        role: "executor",
        state: "running",
        activeRun: {
          id: "run-555",
          agentId: "agent-005",
          startedAt: new Date().toISOString(),
          endedAt: null,
          status: "active",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };
      mockFetchAgents.mockResolvedValue([runningAgent]);
      mockFetchAgentStats.mockResolvedValue({ total: 1, byState: { running: 1 }, byRole: { executor: 1 } });

      render(<AgentsView addToast={mockAddToast} />);

      const runningButton = await screen.findByRole("button", { name: "View live run details for Runner" });
      fireEvent.click(runningButton);

      await waitFor(() => {
        const detail = screen.getByTestId("agent-detail-view");
        expect(detail).toHaveTextContent("agent-005");
        expect(detail).toHaveAttribute("data-initial-tab", "runs");
        expect(detail).toHaveAttribute("data-initial-run-id", "");
        expect(detail).toHaveAttribute("data-prefer-active-run", "true");
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

    it("renders Last/Next heartbeat timestamps without seconds", async () => {
      const lastHeartbeatAt = "2026-05-04T14:23:45.000Z";
      mockFetchAgents.mockResolvedValueOnce([
        {
          ...mockAgents[1],
          lastHeartbeatAt,
          runtimeConfig: { heartbeatIntervalMs: 300000 },
        },
      ]);
      mockFetchAgentStats.mockResolvedValueOnce({ total: 1, byState: { active: 1 }, byRole: { triage: 1 } });

      render(<AgentsView addToast={mockAddToast} />);

      const lastAt = new Date(lastHeartbeatAt);
      const nextAt = new Date(lastAt.getTime() + 300000);
      const expectedLast = `Last: ${lastAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      const expectedNext = `Next: ${nextAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

      await waitFor(() => {
        expect(screen.getByText(expectedLast)).toBeTruthy();
        expect(screen.getByText(expectedNext)).toBeTruthy();
      });

      expect(screen.queryByText(/Last: .*:\d{2}:\d{2}/)).toBeNull();
      expect(screen.queryByText(/Next: .*:\d{2}:\d{2}/)).toBeNull();
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

    it("renders compact error indicator and opens modal with copy/github actions", async () => {
      const errorAgent: Agent = {
        ...mockAgents[0],
        id: "agent-error",
        name: "Error Agent",
        state: "error",
        lastError: "something broke",
      };
      mockFetchAgents.mockResolvedValueOnce([errorAgent]);
      mockFetchAgentStats.mockResolvedValueOnce({ total: 1, byState: { error: 1 }, byRole: { executor: 1 } });

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Open error details" })).toBeTruthy();
      });

      expect(screen.queryByText("something broke")).toBeNull();
      expect(screen.queryByLabelText("Agent error details")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open error details" }));

      expect(screen.getByLabelText("Agent error details")).toBeTruthy();
      expect(screen.getAllByText("something broke").length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole("button", { name: "Copy error to clipboard" }));
      await waitFor(() => {
        expect(mockClipboardWriteText).toHaveBeenCalledWith("something broke");
      });

      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      fireEvent.click(screen.getByRole("link", { name: "Report on GitHub" }));
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("https://github.com/Runfusion/Fusion/issues/new?"),
        "_blank",
        "noopener,noreferrer",
      );
      expect(openSpy.mock.calls[0]?.[0]).toContain("Surface%3A+AgentsView+list");
      openSpy.mockRestore();
    });

    it("does not render error display without error state and lastError", async () => {
      mockFetchAgents.mockResolvedValueOnce([
        { ...mockAgents[0], id: "error-no-text", name: "Error No Text", state: "error", lastError: undefined },
        { ...mockAgents[0], id: "active-with-text", name: "Active With Text", state: "active", lastError: "should not show" },
      ]);
      mockFetchAgentStats.mockResolvedValueOnce({ total: 2, byState: { error: 1, active: 1 }, byRole: { executor: 2 } });

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByText("Error No Text")).toBeTruthy();
        expect(screen.getByText("Active With Text")).toBeTruthy();
      });

      expect(screen.queryByText("should not show")).toBeNull();
      expect(screen.queryByRole("button", { name: "Open error details" })).toBeNull();
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
          metadata: {
            skills: ["auto::skills/../../.agents/skills/review/SKILL.md", "auto::skills/../../.agents/skills/fusion/SKILL.md"],
          },
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
      const { container } = render(<AgentsView addToast={mockAddToast} />);

      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      await waitFor(() => {
        expect(screen.getByText("Chief Agent")).toBeTruthy();
        expect(screen.getByText("Director One")).toBeTruthy();
        expect(screen.getByText("Manager Alpha")).toBeTruthy();
        expect(screen.getByText("Independent Lead")).toBeTruthy();
        expect(screen.getAllByText(/Healthy|Idle|Paused|Unresponsive|Agent stalled/).length).toBeGreaterThan(0);
      });

      expect(container.querySelector(".agents-split-layout")).toBeNull();
      expect(container.querySelector(".agents-org-full-view")).toBeTruthy();

      fireEvent.click(screen.getByText("Director One"));

      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("agent-child-1");
        expect(screen.getByRole("button", { name: "Back to org chart" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Back to agents" })).toBeNull();
      });

      fireEvent.click(screen.getByRole("button", { name: "Back to org chart" }));

      await waitFor(() => {
        expect(screen.queryByTestId("agent-detail-view")).toBeNull();
        expect(screen.getByTestId("agent-org-chart")).toBeTruthy();
      });

      expect(container.querySelector("[class*='org-chart-node-card--'].agent-card--selected")).toBeTruthy();
    });

    it("keeps org chart node metadata compact without skill badges", async () => {
      mockFetchOrgTree.mockResolvedValue(orgTree);
      render(<AgentsView addToast={mockAddToast} />);

      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      await waitFor(() => {
        expect(screen.getByText("Chief Agent")).toBeTruthy();
      });

      const rootCard = document.querySelector('[class*="org-chart-node-card--"]');
      expect(rootCard).toBeTruthy();
      expect(within(rootCard as HTMLElement).queryByText("review")).toBeNull();
      expect(within(rootCard as HTMLElement).queryByText("fusion")).toBeNull();
      expect(within(rootCard as HTMLElement).queryByText("+1")).toBeNull();
      expect((rootCard as HTMLElement).querySelector(".org-chart-node__skill")).toBeNull();
    });

    it("sizes org chart subtree containers based on descendant leaf counts", async () => {
      mockFetchOrgTree.mockResolvedValue(orgTree);
      const { container } = render(<AgentsView addToast={mockAddToast} />);

      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      await waitFor(() => {
        expect(screen.getByText("Chief Agent")).toBeTruthy();
      });

      const rootNode = screen.getByText("Chief Agent").closest(".org-chart-node") as HTMLElement;
      const nestedParentNode = screen.getByText("Director One").closest(".org-chart-node") as HTMLElement;
      const leafNode = screen.getByText("Manager Alpha").closest(".org-chart-node") as HTMLElement;
      const rootChildren = rootNode.querySelector(":scope > .org-chart-children") as HTMLElement;

      expect(rootNode.style.getPropertyValue("--org-chart-subtree-leaves")).toBe("2");
      expect(nestedParentNode.style.getPropertyValue("--org-chart-subtree-leaves")).toBe("1");
      expect(leafNode.style.getPropertyValue("--org-chart-subtree-leaves")).toBe("1");
      expect(rootChildren).toBeTruthy();
      expect(rootChildren.className).toContain("org-chart-children");
      expect(rootChildren.style.getPropertyValue("--org-chart-first-child-leaves")).toBe("1");
      expect(rootChildren.style.getPropertyValue("--org-chart-last-child-leaves")).toBe("1");
      expect(container.querySelectorAll(".org-chart-node--has-children").length).toBeGreaterThan(0);
    });

    it("uses tokenized connector edge offsets for org chart child bars", () => {
      const css = loadAllAppCss();
      expect(css).toContain("--org-chart-first-child-center-offset");
      expect(css).toContain("--org-chart-last-child-center-offset");
      expect(css).toContain("left: var(--org-chart-first-child-center-offset)");
      expect(css).toContain("right: var(--org-chart-last-child-center-offset)");
      expect(css).toContain(".org-chart-children > .org-chart-node::before");
    });

    it("keeps a compact mobile Agents label visible, anchors the controls popup to the action row, and expands view toggles to 36px touch targets", () => {
      const css = loadAllAppCss();
      expect(css).toContain(".agents-view-primary-actions {\n  position: relative;");
      expect(css).toContain(".agent-controls-panel {\n  position: absolute;\n  top: calc(100% + var(--space-sm));\n  right: 0;");
      expect(css).toContain(".agents-view-title h2 {\n    display: block;\n    font-size: var(--space-lg);");
      expect(css).toContain(".agent-controls-mobile-actions {");
      expect(css).toContain(".agent-controls-mobile-actions .btn {");
      expect(css).toContain(".agents-view-controls .view-toggle .view-toggle-btn {");
      expect(css).toContain("min-width: calc(var(--space-lg) * 2 + var(--space-xs));");
      expect(css).toContain("min-height: calc(var(--space-lg) * 2 + var(--space-xs));");
    });

    it("switches org chart to vertical layout mode when estimated width exceeds viewport", async () => {
      const clientWidthSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
      mockFetchOrgTree.mockResolvedValue(orgTree);
      render(<AgentsView addToast={mockAddToast} />);

      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      await waitFor(() => {
        const chart = screen.getByTestId("agent-org-chart");
        expect(chart.getAttribute("data-layout-mode")).toBe("vertical");
        expect(chart.className).toContain("agent-org-chart--vertical");
      });

      fireEvent.click(screen.getByText("Director One"));
      await waitFor(() => {
        expect(screen.getByTestId("agent-detail-view")).toHaveTextContent("agent-child-1");
      });
      clientWidthSpy.mockRestore();
    });

    it("keeps org chart horizontal layout mode when viewport is wide enough", async () => {
      const clientWidthSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1920);
      mockFetchOrgTree.mockResolvedValue(orgTree);
      render(<AgentsView addToast={mockAddToast} />);

      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      await waitFor(() => {
        const chart = screen.getByTestId("agent-org-chart");
        expect(chart.getAttribute("data-layout-mode")).toBe("horizontal");
        expect(chart.className).not.toContain("agent-org-chart--vertical");
      });
      clientWidthSpy.mockRestore();
    });

    it("supports toggling org chart layout preference and persists it", async () => {
      const clientWidthSpy = vi.spyOn(window.HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1920);
      localStorage.setItem(scopedKey("fn-agent-view", projectId), "org");
      localStorage.setItem(scopedKey(ORG_CHART_LAYOUT_STORAGE_KEY, projectId), "vertical");
      mockFetchOrgTree.mockResolvedValue(orgTree);
      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);

      const chart = await screen.findByTestId("agent-org-chart");
      const toggle = screen.getByTestId("agent-org-chart-layout-toggle");
      const horizontalButton = within(toggle).getByRole("button", { name: "Horizontal layout" });
      const verticalButton = within(toggle).getByRole("button", { name: "Vertical layout" });
      const autoButton = within(toggle).getByRole("button", { name: "Automatic layout" });

      expect(verticalButton.getAttribute("aria-pressed")).toBe("true");
      expect(horizontalButton.getAttribute("aria-pressed")).toBe("false");
      expect(autoButton.getAttribute("aria-pressed")).toBe("false");
      expect(chart.getAttribute("data-layout-mode")).toBe("vertical");

      fireEvent.click(horizontalButton);
      await waitFor(() => {
        expect(chart.getAttribute("data-layout-mode")).toBe("horizontal");
        expect(localStorage.getItem(scopedKey(ORG_CHART_LAYOUT_STORAGE_KEY, projectId))).toBe("horizontal");
      });

      fireEvent.click(autoButton);
      await waitFor(() => {
        expect(chart.getAttribute("data-layout-mode")).toBe("horizontal");
        expect(localStorage.getItem(scopedKey(ORG_CHART_LAYOUT_STORAGE_KEY, projectId))).toBe("auto");
      });

      fireEvent.click(verticalButton);
      await waitFor(() => {
        expect(chart.getAttribute("data-layout-mode")).toBe("vertical");
      });

      clientWidthSpy.mockRestore();
    });

    it("shows mobile zoom controls for org chart and keeps node selection working", async () => {
      mockViewportMode.mockReturnValue("mobile");
      mockFetchOrgTree.mockResolvedValue(orgTree);
      const { container } = render(<AgentsView addToast={mockAddToast} />);

      fireEvent.click(screen.getByRole("button", { name: "Org Chart view" }));

      const controls = await screen.findByTestId("agent-org-chart-controls");
      expect(controls).toBeTruthy();
      expect(screen.getByText("100%")).toBeTruthy();

      const viewport = screen.getByTestId("agent-org-chart-viewport");
      expect(viewport).toBeTruthy();
      const canvas = container.querySelector(".agent-org-chart-canvas");
      expect(canvas?.className).toContain("agent-org-chart-canvas--zoom-100");

      fireEvent.click(within(controls).getByTitle("Zoom in"));
      await waitFor(() => {
        expect(screen.getByText("125%")).toBeTruthy();
        expect(container.querySelector(".agent-org-chart-canvas")?.className).toContain("agent-org-chart-canvas--zoom-125");
      });

      fireEvent.click(within(controls).getByTitle("Fit org chart"));
      await waitFor(() => {
        expect(screen.getByText("100%")).toBeTruthy();
        expect(container.querySelector(".agent-org-chart-canvas")?.className).toContain("agent-org-chart-canvas--zoom-100");
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
      await openControlsPanel();

      // Styled filter container exists
      const filterContainer = document.querySelector(".agent-state-filter");
      expect(filterContainer).toBeTruthy();

      // Select has correct aria-label
      const filterSelect = screen.getByLabelText("Filter agents by state");
      expect(filterSelect).toBeTruthy();
    });

    it("can filter agents by state", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await openControlsPanel();

      const filterSelect = screen.getByLabelText("Filter agents by state");
      fireEvent.change(filterSelect, { target: { value: "active" } });

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledWith({ state: "active", includeEphemeral: false }, undefined);
      });
    });

    it("clears filter when selecting 'all'", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await openControlsPanel();

      const filterSelect = screen.getByLabelText("Filter agents by state");
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
      await openControlsPanel();

      // Checkbox should be unchecked by default
      const checkbox = screen.getByLabelText("Show system agents") as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });

    it("passes includeEphemeral: false by default to fetchAgents", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      // Default call should include includeEphemeral: false
      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ includeEphemeral: false }, undefined);
      });
    });

    it("toggles system agents visibility when checkbox is clicked", async () => {
      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);
      await openControlsPanel();

      const checkbox = screen.getByLabelText("Show system agents");
      fireEvent.click(checkbox);

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ includeEphemeral: true }, projectId);
      });
    });

    it("combines system agents toggle with state filter", async () => {
      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);
      await openControlsPanel();

      // First enable system agents toggle
      const checkbox = screen.getByLabelText("Show system agents");
      fireEvent.click(checkbox);

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ includeEphemeral: true }, projectId);
      });

      // Then filter by state
      const filterSelect = screen.getByLabelText("Filter agents by state");
      fireEvent.change(filterSelect, { target: { value: "active" } });

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenLastCalledWith({ state: "active", includeEphemeral: true }, projectId);
      });
    });

    it("hides system agents by default and reveals them when Show system agents is enabled", async () => {
      const systemAgents: Agent[] = [
        {
          id: "agent-sys-001",
          name: "executor-FN-TEST",
          role: "executor" as AgentCapability,
          state: "active" as AgentState,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: { agentKind: "task-worker" },
        },
      ];

      // Return system agent even when includeEphemeral is false to verify
      // client-side filtering still hides it unless the toggle is enabled.
      mockFetchAgents.mockResolvedValue([...mockAgents.slice(0, 3), ...systemAgents]);

      render(<AgentsView addToast={mockAddToast} projectId={projectId} />);

      await waitFor(() => {
        expect(screen.getAllByText("Test Agent 1").length).toBeGreaterThan(0);
      });

      expect(screen.queryByText("executor-FN-TEST")).toBeNull();

      await openControlsPanel();
      const checkbox = screen.getByLabelText("Show system agents");
      fireEvent.click(checkbox);

      await waitFor(() => {
        expect(mockFetchAgents).toHaveBeenCalledWith({ includeEphemeral: true }, projectId);
        expect(screen.getAllByText("executor-FN-TEST").length).toBeGreaterThan(0);
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

      // Step 0: switch to Custom tab and fill in agent name
      fireEvent.click(screen.getByRole("tab", { name: "Custom agent" }));
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

      // Presets tab is default and custom fields appear after switching tabs
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "Preset personas", selected: true })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("tab", { name: "Custom agent" }));
      expect(screen.getByPlaceholderText("e.g. Frontend Reviewer")).toBeTruthy();
    });

    it("keeps legacy dialog launch when agent onboarding flag is disabled", async () => {
      render(<AgentsView addToast={mockAddToast} agentOnboardingEnabled={false} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Create new agent" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "AI Interview" })).toBeNull();
      });
    });

    it("keeps New Agent launch on the standard dialog when agent onboarding flag is enabled", async () => {
      render(<AgentsView addToast={mockAddToast} agentOnboardingEnabled={true} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Create new agent" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "AI Interview" })).toBeTruthy();
      });
    });

    it("launches interview from AgentsView and only applies draft after review confirmation", async () => {
      render(<AgentsView addToast={mockAddToast} agentOnboardingEnabled={true} />);

      await waitFor(() => {
        expect(screen.getByText("New Agent")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("New Agent"));
      fireEvent.click(screen.getByRole("button", { name: "AI Interview" }));

      const interviewDialog = await screen.findByRole("dialog", { name: "AI Interview" });
      expect(screen.getByText("Draft ready for review")).toBeTruthy();
      expect(mockCreateAgent).not.toHaveBeenCalled();

      fireEvent.click(within(interviewDialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "AI Interview" })).toBeNull();
      });
      expect(mockCreateAgent).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "AI Interview" }));
      await screen.findByRole("dialog", { name: "AI Interview" });
      fireEvent.click(screen.getByRole("button", { name: "Apply draft to agent form" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      fireEvent.click(screen.getByRole("tab", { name: "Custom agent" }));
      const nameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
      expect(nameInput.value).toBe("Interview Draft Agent");
      expect(mockCreateAgent).not.toHaveBeenCalled();
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

      fireEvent.click(screen.getByRole("tab", { name: "Custom agent" }));
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
      });

      expect(mockStartAgentRun).not.toHaveBeenCalled();
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
      const activeCard = Array.from(document.querySelectorAll(".agent-card")).find(
        (card) => card.textContent?.includes("agent-002")
      ) ?? null;
      expect(activeCard).toBeTruthy();

      const pauseButton = (activeCard as Element | null)?.querySelector('[title="Pause"]') as HTMLElement;
      expect(pauseButton).toBeTruthy();
      fireEvent.click(pauseButton);

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-002", "paused", undefined);
      });
    });

    it("can resume paused agent without manual run trigger", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Resume")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Resume"));

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-003", "active", undefined);
      });

      expect(mockStartAgentRun).not.toHaveBeenCalled();
    });

    it("optimistically updates the card state before state API resolves", async () => {
      let resolveTransition!: () => void;
      const transitionPromise = new Promise<Agent>((resolve) => {
        resolveTransition = () => resolve({ ...mockAgents[0], state: "active" });
      });
      mockUpdateAgentState.mockImplementationOnce(() => transitionPromise);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Activate"));

      await waitFor(() => {
        const agentCards = Array.from(document.querySelectorAll(".agent-card"));
        const targetCard = agentCards.find((card) => card.textContent?.includes("agent-001"));
        expect(targetCard).toBeTruthy();
        expect(targetCard?.textContent).toContain("active");
      });

      resolveTransition?.();
      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "active", undefined);
      });
    });

    it("rolls back optimistic state when the state API fails", async () => {
      let rejectTransition!: (error: Error) => void;
      const transitionPromise = new Promise<Agent>((_, reject) => {
        rejectTransition = reject;
      });
      mockUpdateAgentState.mockImplementationOnce(() => transitionPromise);

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        expect(screen.getByTitle("Activate")).toBeTruthy();
      });

      fireEvent.click(screen.getByTitle("Activate"));

      await waitFor(() => {
        const agentCards = Array.from(document.querySelectorAll(".agent-card"));
        const targetCard = agentCards.find((card) => card.textContent?.includes("agent-001"));
        expect(targetCard?.textContent).toContain("active");
      });

      rejectTransition?.(new Error("State change failed"));

      await waitFor(() => {
        const agentCards = Array.from(document.querySelectorAll(".agent-card"));
        const targetCard = agentCards.find((card) => card.textContent?.includes("agent-001"));
        expect(targetCard?.textContent).toContain("idle");
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("State change failed"),
        "error"
      );
    });

    it("prevents concurrent state transitions for the same agent", async () => {
      let resolveTransition!: () => void;
      const transitionPromise = new Promise<Agent>((resolve) => {
        resolveTransition = () => resolve({ ...mockAgents[0], state: "active" });
      });
      mockUpdateAgentState.mockImplementationOnce(() => transitionPromise);

      render(<AgentsView addToast={mockAddToast} />);

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

    it("does not start run when pausing agent", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const agentCards = document.querySelectorAll(".agent-card");
        expect(agentCards.length).toBeGreaterThan(0);
      });

      // Find the active agent card
      const activeCard = Array.from(document.querySelectorAll(".agent-card")).find(
        (card) => card.textContent?.includes("agent-002")
      ) ?? null;

      const pauseButton = (activeCard as Element | null)?.querySelector('[title="Pause"]') as HTMLElement;
      fireEvent.click(pauseButton);

      await waitFor(() => {
        expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-002", "paused", undefined);
      });

      // startAgentRun should NOT be called when pausing
      expect(mockStartAgentRun).not.toHaveBeenCalled();
    });
  });

  describe("Run Now button", () => {
    it("renders compact sidebar action controls with visible icon affordances (FN-3902/FN-3923)", async () => {
      const activeWithoutTaskId = { ...mockAgents[1] };
      delete activeWithoutTaskId.taskId;
      mockFetchAgents.mockResolvedValue([
        mockAgents[0],
        activeWithoutTaskId,
        mockAgents[2],
        mockAgents[3],
      ]);

      render(<AgentsView addToast={mockAddToast} />);

      const runNowButton = await screen.findByTitle("Run Now");
      const pauseButton = await screen.findByTitle("Pause");
      const activeCard = runNowButton.closest(".agent-card");
      const detailsButton = activeCard?.querySelector('[aria-label^="View details for "]') as HTMLButtonElement | null;

      expect(detailsButton).toBeTruthy();
      expect(runNowButton.querySelector(".agent-card-action-label")).toBeTruthy();
      expect(pauseButton.querySelector(".agent-card-action-label")).toBeTruthy();
      expect(detailsButton?.querySelector(".agent-card-action-label")).toBeTruthy();
      expect(detailsButton?.querySelector("svg")).toBeTruthy();
    });

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
    it("shows Delete button for idle and paused agents in default view", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const deleteButtons = screen.getAllByTitle("Delete");
        expect(deleteButtons.length).toBeGreaterThanOrEqual(2);
      });
    });

    it("does not show Delete button for active agents", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const allCards = Array.from(document.querySelectorAll(".agent-card"));
        const activeCard = allCards.find((card) => card.textContent?.includes("agent-002")) ?? null;

        expect((activeCard as Element | null)?.querySelector('[title="Delete"]')).toBeFalsy();
      });
    });

    it("shows Delete button for paused agents", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const allCards = Array.from(document.querySelectorAll(".agent-card"));
        const pausedCard = allCards.find((card) => card.textContent?.includes("agent-003")) ?? null;

        expect((pausedCard as Element | null)?.querySelector('[title="Delete"]')).toBeTruthy();
      });
    });

    it("deletes idle agent after confirmation (from default view)", async () => {

      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const deleteButtons = screen.getAllByTitle("Delete");
        expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
      });

      // Find the delete button for idle agent (agent-001)
      const idleCard = Array.from(document.querySelectorAll(".agent-card")).find(
        (card) => card.textContent?.includes("agent-001")
      ) ?? null;
      const idleDeleteBtn = (idleCard as Element | null)?.querySelector('[title="Delete"]') as HTMLElement;
      fireEvent.click(idleDeleteBtn);

      await waitFor(() => {
        expect(mockDeleteAgent).toHaveBeenCalledWith("agent-001", undefined);
      });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.stringContaining("deleted"),
        "success"
      );
    });

    it("deletes paused agent after confirmation (from default view)", async () => {
      render(<AgentsView addToast={mockAddToast} />);

      await waitFor(() => {
        const pausedCard = Array.from(document.querySelectorAll(".agent-card")).find(
          (card) => card.textContent?.includes("agent-003"),
        ) ?? null;
        const pausedDeleteBtn = (pausedCard as Element | null)?.querySelector('[title="Delete"]') as HTMLElement;
        expect(pausedDeleteBtn).toBeTruthy();
        fireEvent.click(pausedDeleteBtn);
      });

      await waitFor(() => {
        expect(mockDeleteAgent).toHaveBeenCalledWith("agent-003", undefined);
      });
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
      await openOverviewPanel();

      await waitFor(() => {
        expect(screen.getByText("Active Agents (1)")).toBeTruthy();
      });

      // Should have a live agent card for the active agent
      const liveAgentCards = document.querySelectorAll(".live-agent-card");
      expect(liveAgentCards.length).toBe(1);
    });

    it("opens AgentDetailView when clicking an active agent card", async () => {
      render(<AgentsView addToast={mockAddToast} />);
      await openOverviewPanel();

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
      await openOverviewPanel();

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
      await openOverviewPanel();

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
      await openOverviewPanel();

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
      await openOverviewPanel();

      await waitFor(() => {
        expect(screen.queryByText(/^Active Agents \(/)).toBeNull();
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
      await openOverviewPanel();

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
      await openControlsPanel();

      // Check the slider and preset are rendered
      expect(screen.getByRole("slider", { name: "Heartbeat Speed" })).toBeTruthy();
      expect(screen.getByLabelText("Heartbeat speed preset")).toBeTruthy();

      // Check helper text
      expect(screen.getByText(/Scales all agent heartbeat intervals/)).toBeTruthy();
    });

    it("loads heartbeat multiplier from settings", async () => {
      mockFetchSettings.mockResolvedValue({ heartbeatMultiplier: 2.5 });
      render(<AgentsView addToast={mockAddToast} />);
      await openControlsPanel();

      const slider = screen.getByRole("slider", { name: "Heartbeat Speed" }) as HTMLInputElement;
      expect(slider.value).toBe("2.5");
    });

    it("saves heartbeat multiplier when slider changes", async () => {
      mockFetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
      render(<AgentsView addToast={mockAddToast} />);
      await openControlsPanel();

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
      await openControlsPanel();

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
      await openControlsPanel();

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
