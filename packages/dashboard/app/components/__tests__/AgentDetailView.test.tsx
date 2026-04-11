import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AgentDetailView } from "../AgentDetailView";
import type { AgentCapability, AgentDetail } from "../../api";

// Mock the API functions
vi.mock("../../api", () => ({
  fetchAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
  fetchAgentLogs: vi.fn(),
  fetchAgentRunLogs: vi.fn(),
  fetchAgentChildren: vi.fn(),
  fetchAgentRuns: vi.fn(),
  fetchAgentRunDetail: vi.fn(),
  startAgentRun: vi.fn(),
  updateAgentInstructions: vi.fn(),
  updateAgentSoul: vi.fn(),
  updateAgentMemory: vi.fn(),
  fetchAgentTasks: vi.fn(),
  fetchChainOfCommand: vi.fn(),
  fetchAgentBudgetStatus: vi.fn(),
  resetAgentBudget: vi.fn(),
  fetchWorkspaceFileContent: vi.fn(),
  saveWorkspaceFileContent: vi.fn(),
}));

vi.mock("../AgentLogViewer", () => ({
  AgentLogViewer: ({ entries }: { entries: Array<{ text: string }> }) => (
    <div data-testid="agent-log-viewer">
      {entries.map((e, i) => <span key={i}>{e.text}</span>)}
    </div>
  ),
}));

import { fetchAgent, updateAgent, updateAgentState, fetchAgentChildren, fetchAgentRunLogs, fetchAgentRuns, fetchAgentRunDetail, fetchAgentTasks, fetchChainOfCommand, fetchAgentBudgetStatus, resetAgentBudget, updateAgentInstructions, fetchWorkspaceFileContent, saveWorkspaceFileContent } from "../../api";

const mockFetchAgent = vi.mocked(fetchAgent);
const mockUpdateAgent = vi.mocked(updateAgent);
const mockUpdateAgentState = vi.mocked(updateAgentState);
const mockFetchAgentChildren = vi.mocked(fetchAgentChildren);
const mockFetchAgentRunLogs = vi.mocked(fetchAgentRunLogs);
const mockFetchAgentRuns = vi.mocked(fetchAgentRuns);
const mockFetchAgentRunDetail = vi.mocked(fetchAgentRunDetail);
const mockFetchAgentTasks = vi.mocked(fetchAgentTasks);
const mockFetchChainOfCommand = vi.mocked(fetchChainOfCommand);
const mockFetchAgentBudgetStatus = vi.mocked(fetchAgentBudgetStatus);
const mockResetAgentBudget = vi.mocked(resetAgentBudget);
const mockUpdateAgentInstructions = vi.mocked(updateAgentInstructions);
const mockFetchWorkspaceFileContent = vi.mocked(fetchWorkspaceFileContent);
const mockSaveWorkspaceFileContent = vi.mocked(saveWorkspaceFileContent);

describe("AgentDetailView", () => {
  const createMockAgent = (overrides: Partial<{
    id: string;
    name: string;
    role: AgentCapability;
    state: "idle" | "active" | "paused" | "terminated";
    taskId?: string;
    runtimeConfig?: Record<string, unknown>;
  }> = {}): AgentDetail => ({
    id: "agent-001",
    name: "Test Agent",
    role: "executor" as AgentCapability,
    state: "active",
    taskId: "FN-001",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2024-01-01T00:05:00.000Z",
    metadata: {},
    runtimeConfig: overrides.runtimeConfig,
    heartbeatHistory: [],
    activeRun: {
      id: "run-001",
      agentId: "agent-001",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: null,
      status: "active",
    },
    completedRuns: [
      {
        id: "run-002",
        agentId: "agent-001",
        startedAt: "2023-12-31T00:00:00.000Z",
        endedAt: "2023-12-31T00:05:00.000Z",
        status: "completed",
      },
    ],
    ...overrides,
  } as AgentDetail);

  beforeEach(() => {
    vi.clearAllMocks();
    const mockAgent = createMockAgent();
    mockFetchAgent.mockResolvedValue(mockAgent);
    mockUpdateAgentState.mockResolvedValue(createMockAgent({ state: "paused" }));
    mockUpdateAgent.mockResolvedValue(createMockAgent() as any);
    // Default: return runs from mock agent
    mockFetchAgentRuns.mockResolvedValue([
      ...(mockAgent.activeRun ? [mockAgent.activeRun] : []),
      ...mockAgent.completedRuns,
    ]);
    mockFetchAgentRunDetail.mockResolvedValue(mockAgent.completedRuns[0]);
    mockFetchAgentChildren.mockResolvedValue([]);
    mockFetchAgentTasks.mockResolvedValue([]);
    mockFetchChainOfCommand.mockResolvedValue([mockAgent]);
    // Default: no budget limit configured
    mockFetchAgentBudgetStatus.mockResolvedValue({
      agentId: "agent-001",
      currentUsage: 0,
      budgetLimit: null,
      usagePercent: 0,
      isOverBudget: false,
      isOverThreshold: false,
      budgetPeriod: "lifetime",
      lastResetAt: null,
      nextResetAt: null,
    });
    mockResetAgentBudget.mockResolvedValue(undefined);
    // Default: empty file content
    mockFetchWorkspaceFileContent.mockResolvedValue({ content: "", mtime: "2024-01-01T00:00:00.000Z", size: 0 });
    mockSaveWorkspaceFileContent.mockResolvedValue({ success: true, mtime: "2024-01-01T00:00:00.000Z", size: 0 });
    mockUpdateAgentInstructions.mockResolvedValue({} as any);
  });

  it("shows loading state initially", () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    expect(screen.getByText(/Loading agent/i)).toBeInTheDocument();
  });

  it("defines CSS variables for agent state tokens in the global stylesheet", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      const headings = screen.getAllByRole("heading", { level: 2 });
      expect(headings.some(h => h.textContent === "Test Agent")).toBe(true);
    });

    // Verify state CSS variables are defined in the global stylesheet (styles.css)
    // (previously these were in inline style blocks, now they're in the global :root)
    const fs = await import("fs");
    const path = await import("path");
    const stylesPath = path.join(__dirname, "../../styles.css");
    const stylesContent = fs.readFileSync(stylesPath, "utf-8");
    expect(stylesContent).toContain("--state-idle-bg:");
    expect(stylesContent).toContain("--state-active-bg:");
    expect(stylesContent).toContain("--state-paused-bg:");
    expect(stylesContent).toContain("--state-error-bg:");
    expect(stylesContent).toContain("--state-idle-text:");
    expect(stylesContent).toContain("--state-active-text:");
  });

  it("uses token-based state colors for badges instead of hardcoded hex", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("active").length).toBeGreaterThan(0);
    });

    // Verify badge styles use CSS variable references for background, not hex values
    const badges = document.querySelectorAll(".badge, .inline-badge");
    badges.forEach(badge => {
      const htmlEl = badge as HTMLElement;
      const style = htmlEl.getAttribute("style") ?? "";
      // Background should use var(--state-*) references, not raw rgba() or hex
      if (style.includes("background")) {
        expect(style).toContain("var(--state-");
        // Should not use raw rgba() for state backgrounds
        expect(style).not.toMatch(/background:\s*rgba\(/);
      }
    });
  });

  it("uses token-based colors for health status instead of hardcoded hex", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      // The mock agent is active with a heartbeat from 2024, so it should show "Unresponsive"
      const hasHealthStatus = screen.queryAllByText(/Healthy|Unresponsive|Idle/).length > 0;
      expect(hasHealthStatus).toBe(true);
    });

    // Health badges in header should use var(--state-*) references, not raw hex
    const headerBadges = document.querySelectorAll(".agent-detail-badges .badge");
    headerBadges.forEach(badge => {
      const htmlEl = badge as HTMLElement;
      const style = htmlEl.getAttribute("style") ?? "";
      if (style.includes("color:") && !style.includes("var(--state-")) {
        // If the color is not a state variable, it should still be a CSS variable
        expect(style).toMatch(/color:\s*var\(/);
      }
    });
  });

  it("uses token-based color references for success and error states", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("active").length).toBeGreaterThan(0);
    });

    // Navigate to Runs tab to trigger rendering of run-related content
    fireEvent.click(screen.getByText("Runs"));

    // Verify that the global stylesheet defines --color-success and --color-error
    // (previously checked in inline style blocks, now verified by reading styles.css)
    const fs = await import("fs");
    const path = await import("path");
    const stylesPath = path.join(__dirname, "../../styles.css");
    const stylesContent = fs.readFileSync(stylesPath, "utf-8");
    expect(stylesContent).toMatch(/--color-success:/);
    expect(stylesContent).toMatch(/--color-error:/);
  });

  it("uses global design tokens instead of component-local aliases", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("active").length).toBeGreaterThan(0);
    });

    // Previously the component defined local aliases like --bg-primary, --accent, etc.
    // Now these are replaced with direct global token references in the CSS classes.
    // Verify the global stylesheet defines the real tokens that the component uses.
    const fs = await import("fs");
    const path = await import("path");
    const stylesPath = path.join(__dirname, "../../styles.css");
    const stylesContent = fs.readFileSync(stylesPath, "utf-8");
    // The component classes now use --surface, --todo, --text, --card-hover directly
    expect(stylesContent).toMatch(/--surface:/);
    expect(stylesContent).toMatch(/--todo:/);
    expect(stylesContent).toMatch(/--text:/);
    expect(stylesContent).toMatch(/--card-hover:/);
  });

  it("displays agent name in header after loading", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    // Wait for the h2 element specifically (the header title)
    await waitFor(() => {
      const headings = screen.getAllByRole("heading", { level: 2 });
      expect(headings.some(h => h.textContent === "Test Agent")).toBe(true);
    });
  });

  it("fetches the agent using the active project context", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        projectId="proj_123"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(mockFetchAgent).toHaveBeenCalledWith("agent-001", "proj_123");
    });
  });

  it("does not refetch or show loading spinner when onClose/addToast callback identities change", async () => {
    const initialOnClose = vi.fn();
    const initialAddToast = vi.fn();

    const { rerender } = render(
      <AgentDetailView
        agentId="agent-001"
        onClose={initialOnClose}
        addToast={initialAddToast}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Test Agent" })).toBeInTheDocument();
    });
    expect(mockFetchAgent).toHaveBeenCalledTimes(1);

    rerender(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    expect(mockFetchAgent).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Loading agent...")).not.toBeInTheDocument();
  });

  it("refreshes agent data without showing full-screen loading spinner after initial load", async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((value: AgentDetail) => void) | undefined;

    mockFetchAgent
      .mockImplementationOnce(async () => createMockAgent())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Test Agent" })).toBeInTheDocument();
    });

    await user.click(screen.getByTitle("Refresh"));

    await waitFor(() => {
      expect(mockFetchAgent).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText("Loading agent...")).not.toBeInTheDocument();

    resolveRefresh?.(createMockAgent({ updatedAt: "2024-01-01T00:10:00.000Z" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Test Agent" })).toBeInTheDocument();
    });
  });

  it("displays role badge", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("executor")).toBeInTheDocument();
    });
  });

  it("displays state badge", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      // There should be at least one element with "active" (could be in badge or inline-badge)
      expect(screen.getAllByText("active").length).toBeGreaterThan(0);
    });
  });

  it("shows all tabs", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
      expect(screen.getByText("Logs")).toBeInTheDocument();
      expect(screen.getByText("Runs")).toBeInTheDocument();
      expect(screen.getByText("Tasks")).toBeInTheDocument();
      expect(screen.getByText("Employees")).toBeInTheDocument();
      expect(screen.getByText("Soul")).toBeInTheDocument();
      expect(screen.getByText("Instructions")).toBeInTheDocument();
      expect(screen.getByText("Memory")).toBeInTheDocument();
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
  });

  it("renders Employees tab empty state", async () => {
    const user = userEvent.setup();
    mockFetchAgentChildren.mockResolvedValue([]);

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await user.click(await screen.findByText("Employees"));

    await waitFor(() => {
      expect(mockFetchAgentChildren).toHaveBeenCalledWith("agent-001", undefined);
      expect(screen.getByText("No employees")).toBeInTheDocument();
      expect(screen.getByText("This agent has no employees")).toBeInTheDocument();
    });
  });

  it("shows Pause button for active agent", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Pause")).toBeInTheDocument();
    });
  });

  it("shows Resume button for paused agent", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "paused" }));

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Resume")).toBeInTheDocument();
    });
  });

  it("shows Delete button for terminated agent", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "terminated" }));

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Start")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
  });

  it("shows Start button for terminated agent", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "terminated" }));
    mockUpdateAgentState.mockResolvedValue(createMockAgent({ state: "active" }));

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Start")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Start"));

    await waitFor(() => {
      expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "active", undefined);
    });
  });

  it("shows Delete button for idle agent", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "idle" }));

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
  });

  it("shows Pause and Stop buttons for running agent", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "running" }));

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Pause")).toBeInTheDocument();
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });
  });

  it("shows Retry and Stop buttons for error agent", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "error" }));

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeInTheDocument();
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });
  });

  it("renders lifecycle controls in compact layout with agent-detail-controls container", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      // Verify lifecycle controls are in the compact controls container
      const controlsContainer = document.querySelector(".agent-detail-controls");
      expect(controlsContainer).toBeTruthy();
      expect(controlsContainer?.querySelector(".btn--compact")).toBeTruthy();
    });
  });

  it("renders utility actions in separate container", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      // Verify utility actions are in the separate utility container
      const utilityContainer = document.querySelector(".agent-detail-utility-actions");
      expect(utilityContainer).toBeTruthy();
      // Refresh and Close buttons should be in utility container
      expect(utilityContainer?.querySelector('[title="Refresh"]')).toBeTruthy();
      expect(utilityContainer?.querySelector('[title="Close"]')).toBeTruthy();
    });
  });

  it("shows statistics section on dashboard", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Total Runs")).toBeInTheDocument();
    });
  });

  describe("Chain of Command", () => {
    it("renders chain-of-command section and displays agents in order", async () => {
      mockFetchChainOfCommand.mockResolvedValue([
        { id: "agent-root", name: "CEO Agent" } as AgentDetail,
        { id: "agent-middle", name: "Director Agent" } as AgentDetail,
        { id: "agent-001", name: "Test Agent" } as AgentDetail,
      ] as any);

      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Chain of Command")).toBeInTheDocument();
      });

      await waitFor(() => {
        const nodes = Array.from(document.querySelectorAll(".chain-of-command-node"));
        expect(nodes).toHaveLength(3);
        expect(nodes.map((node) => node.textContent?.trim())).toEqual([
          "CEO Agent",
          "Director Agent",
          "Test Agent",
        ]);
        expect(nodes[2].className).toContain("chain-of-command-node--current");
      });
    });

    it("navigates to ancestor agent when chain node is clicked", async () => {
      const onChildClick = vi.fn();
      mockFetchChainOfCommand.mockResolvedValue([
        { id: "agent-root", name: "CEO Agent" } as AgentDetail,
        { id: "agent-middle", name: "Director Agent" } as AgentDetail,
        { id: "agent-001", name: "Test Agent" } as AgentDetail,
      ] as any);

      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
          onChildClick={onChildClick}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("CEO Agent")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "CEO Agent" }));
      expect(onChildClick).toHaveBeenCalledWith("agent-root");
    });

    it("shows no reporting chain for empty or single-element chains", async () => {
      mockFetchChainOfCommand.mockResolvedValue([]);

      const { rerender } = render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("No reporting chain")).toBeInTheDocument();
      });

      mockFetchChainOfCommand.mockResolvedValue([{ id: "agent-001", name: "Test Agent" } as AgentDetail] as any);

      rerender(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("No reporting chain")).toBeInTheDocument();
      });
    });

    it("shows loading state while fetching chain of command", async () => {
      let resolveChain: ((agents: AgentDetail[]) => void) | undefined;
      mockFetchChainOfCommand.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveChain = resolve;
          }) as any,
      );

      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Loading reporting chain...")).toBeInTheDocument();
      });

      resolveChain?.([{ id: "agent-001", name: "Test Agent" } as AgentDetail]);

      await waitFor(() => {
        expect(screen.queryByText("Loading reporting chain...")).not.toBeInTheDocument();
      });
    });
  });

  it("displays agent ID in footer", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("agent-001")).toBeInTheDocument();
    });
  });

  it("calls API with correct agentId", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(mockFetchAgent).toHaveBeenCalledWith("agent-001", undefined);
    });
  });

  it("displays health status indicator", async () => {
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      // Health status should be either Healthy, Unresponsive, or Idle
      const healthTexts = ["Healthy", "Unresponsive", "Idle"];
      const hasHealthStatus = healthTexts.some(text => 
        document.body.textContent?.includes(text)
      );
      expect(hasHealthStatus).toBe(true);
    });
  });

  it("shows Live Run on runs tab when agent has active run", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Runs"));

    await waitFor(() => {
      expect(screen.getByText("Live Run")).toBeInTheDocument();
    });
  });

  describe("Tasks tab", () => {
    it("renders tasks returned by fetchAgentTasks", async () => {
      const user = userEvent.setup();
      mockFetchAgentTasks.mockResolvedValue([
        {
          id: "FN-201",
          title: "Implement assignment API",
          description: "",
          column: "in-progress",
          status: "executing",
          steps: [],
          dependencies: [],
          log: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ] as any);

      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await user.click(await screen.findByText("Tasks"));

      await waitFor(() => {
        expect(mockFetchAgentTasks).toHaveBeenCalledWith("agent-001", undefined);
        expect(screen.getByText("FN-201")).toBeInTheDocument();
        expect(screen.getByText("Implement assignment API")).toBeInTheDocument();
      });
    });

    it("shows empty state when no tasks are assigned", async () => {
      const user = userEvent.setup();
      mockFetchAgentTasks.mockResolvedValue([]);

      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await user.click(await screen.findByText("Tasks"));

      await waitFor(() => {
        expect(screen.getByText("No tasks assigned to this agent")).toBeInTheDocument();
      });
    });
  });

  // ── Advanced Settings (Config Tab) ────────────────────────────────────

  describe("Advanced Settings", () => {
    const navigateToSettings = async (user: ReturnType<typeof userEvent.setup>) => {
      await waitFor(() => {
        expect(screen.getByText("Settings")).toBeInTheDocument();
      });
      await user.click(screen.getByText("Settings"));
    };

    it("renders advanced settings form fields on Settings tab", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        // Heartbeat Settings section
        expect(screen.getByLabelText("Heartbeat Interval (ms)")).toBeInTheDocument();
        expect(screen.getByLabelText("Heartbeat Timeout (ms)")).toBeInTheDocument();
        // Advanced Settings section
        expect(screen.getByLabelText("Max Retries")).toBeInTheDocument();
        expect(screen.getByLabelText("Task Timeout (ms)")).toBeInTheDocument();
        expect(screen.getByLabelText("Log Level")).toBeInTheDocument();
      });
    });

    it("shows empty fields when metadata and runtimeConfig are empty", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({ metadata: {} }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        const heartbeatInput = screen.getByLabelText("Heartbeat Interval (ms)") as HTMLInputElement;
        expect(heartbeatInput.value).toBe("");
      });
    });

    it("pre-fills heartbeat fields from agent runtimeConfig", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        runtimeConfig: {
          heartbeatIntervalMs: 15000,
          heartbeatTimeoutMs: 120000,
        },
        metadata: {
          maxRetries: 5,
          logLevel: "debug",
        },
      }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        const heartbeatInput = screen.getByLabelText("Heartbeat Interval (ms)") as HTMLInputElement;
        expect(heartbeatInput.value).toBe("15000");

        const heartbeatTimeoutInput = screen.getByLabelText("Heartbeat Timeout (ms)") as HTMLInputElement;
        expect(heartbeatTimeoutInput.value).toBe("120000");

        const retriesInput = screen.getByLabelText("Max Retries") as HTMLInputElement;
        expect(retriesInput.value).toBe("5");

        const logLevelSelect = screen.getByLabelText("Log Level") as HTMLSelectElement;
        expect(logLevelSelect.value).toBe("debug");
      });
    });

    it("shows Save Settings button disabled when no changes", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({ metadata: {} }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        expect(screen.getByText("Save Settings")).toBeDisabled();
      });
    });

    it("enables Save Settings when a field is changed", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (ms)");

      await user.clear(heartbeatInput);
      await user.type(heartbeatInput, "15000");

      await waitFor(() => {
        expect(screen.getByText("Save Settings")).not.toBeDisabled();
      });
    });

    it("shows validation error for non-numeric input in number field", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      // Simulate setting a non-numeric value via React's internal value setter
      // (userEvent.type on type="number" rejects non-numeric chars, so we bypass it)
      const heartbeatInput = (await screen.findByLabelText("Heartbeat Interval (ms)")) as HTMLInputElement;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      nativeInputValueSetter?.call(heartbeatInput, 'abc');
      fireEvent.change(heartbeatInput);

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/must be a valid number/)).toBeInTheDocument();
      });
    });

    it("shows validation error for number below minimum", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const heartbeatTimeoutInput = await screen.findByLabelText("Heartbeat Timeout (ms)");

      await user.clear(heartbeatTimeoutInput);
      await user.type(heartbeatTimeoutInput, "500");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/must be at least 5,000/)).toBeInTheDocument();
      });
    });

    it("shows validation error for number above maximum", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const retriesInput = await screen.findByLabelText("Max Retries");

      await user.clear(retriesInput);
      await user.type(retriesInput, "99");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/must be at most 10/)).toBeInTheDocument();
      });
    });

    it("calls updateAgent with correct metadata and runtimeConfig on save", async () => {
      const addToast = vi.fn();
      mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToSettings(user);

      const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (ms)");

      await user.clear(heartbeatInput);
      await user.type(heartbeatInput, "15000");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(mockUpdateAgent).toHaveBeenCalledWith(
          "agent-001",
          expect.objectContaining({
            metadata: expect.any(Object),
            runtimeConfig: expect.objectContaining({ heartbeatIntervalMs: 15000 }),
          }),
          undefined,
        );
      });

      expect(addToast).toHaveBeenCalledWith("Settings saved", "success");
    });

    it("forwards projectId to updateAgent", async () => {
      const addToast = vi.fn();
      mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          projectId="proj_456"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToSettings(user);

      const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (ms)");

      await user.clear(heartbeatInput);
      await user.type(heartbeatInput, "20000");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(mockUpdateAgent).toHaveBeenCalledWith(
          "agent-001",
          expect.objectContaining({ metadata: expect.any(Object) }),
          "proj_456",
        );
      });
    });

    it("re-fetches agent after successful save", async () => {
      const addToast = vi.fn();
      mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToSettings(user);

      // Initial fetch + save-triggered refetch
      const initialFetchCount = vi.mocked(fetchAgent).mock.calls.length;

      const retriesInput = await screen.findByLabelText("Max Retries");
      await user.clear(retriesInput);
      await user.type(retriesInput, "7");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(vi.mocked(fetchAgent).mock.calls.length).toBeGreaterThan(initialFetchCount);
      });
    });

    it("shows error toast on save failure", async () => {
      const addToast = vi.fn();
      mockUpdateAgent.mockRejectedValue(new Error("Network error"));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToSettings(user);

      const retriesInput = await screen.findByLabelText("Max Retries");
      await user.clear(retriesInput);
      await user.type(retriesInput, "2");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          expect.stringContaining("Failed to save settings"),
          "error",
        );
      });
    });

    it("shows validation error for non-numeric input in number field", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      // Type "abc" directly into a text input
      const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (ms)");

      await user.clear(heartbeatInput);
      await user.type(heartbeatInput, "abc");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/must be a valid number/)).toBeInTheDocument();
      });
    });

    it("pre-fills and persists logLevel select field", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        metadata: { logLevel: "debug" },
      }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const logLevelSelect = await screen.findByLabelText("Log Level");
      expect((logLevelSelect as HTMLSelectElement).value).toBe("debug");
    });

    it("clears runtimeConfig key when heartbeat field is cleared to empty", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        runtimeConfig: { heartbeatIntervalMs: 30000 },
      }));
      mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (ms)");
      expect((heartbeatInput as HTMLInputElement).value).toBe("30000");

      await user.clear(heartbeatInput);

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(mockUpdateAgent).toHaveBeenCalledWith(
          "agent-001",
          expect.objectContaining({
            runtimeConfig: expect.not.objectContaining({ heartbeatIntervalMs: expect.anything() }),
          }),
          undefined,
        );
      });
    });

    it("persists existing non-advanced metadata keys and runtimeConfig during save", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        metadata: { customKey: "preserved" },
        runtimeConfig: { heartbeatIntervalMs: 30000, otherConfig: "also-preserved" },
      }));
      mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (ms)");

      await user.clear(heartbeatInput);
      await user.type(heartbeatInput, "45000");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        const call = mockUpdateAgent.mock.calls[0];
        const payload = (call as any)[1];
        expect(payload.metadata.customKey).toBe("preserved");
        expect(payload.runtimeConfig.heartbeatIntervalMs).toBe(45000);
        expect(payload.runtimeConfig.otherConfig).toBe("also-preserved");
      });
    });
  });

  // ── Budget Settings ──────────────────────────────────────────────────────

  describe("Budget Settings", () => {
    const navigateToSettings = async (user: ReturnType<typeof userEvent.setup>) => {
      await waitFor(() => {
        expect(screen.getByText("Settings")).toBeInTheDocument();
      });
      await user.click(screen.getByText("Settings"));
    };

    it("renders Budget Settings section with all fields", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Token Budget")).toBeInTheDocument();
        expect(screen.getByLabelText("Usage Threshold (%)")).toBeInTheDocument();
        expect(screen.getByLabelText("Budget Period")).toBeInTheDocument();
        expect(screen.getByLabelText("Reset Day")).toBeInTheDocument();
      });
    });

    it("pre-fills budget fields from existing runtimeConfig.budgetConfig", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        runtimeConfig: {
          budgetConfig: {
            tokenBudget: 1000000,
            usageThreshold: 0.8, // fraction stored, should display as 80%
            budgetPeriod: "monthly",
            resetDay: 15,
          },
        },
      }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        const tokenBudgetInput = screen.getByLabelText("Token Budget") as HTMLInputElement;
        expect(tokenBudgetInput.value).toBe("1000000");

        const thresholdInput = screen.getByLabelText("Usage Threshold (%)") as HTMLInputElement;
        expect(thresholdInput.value).toBe("80"); // Converted from 0.8 to 80

        const periodSelect = screen.getByLabelText("Budget Period") as HTMLSelectElement;
        expect(periodSelect.value).toBe("monthly");

        const resetDayInput = screen.getByLabelText("Reset Day") as HTMLInputElement;
        expect(resetDayInput.value).toBe("15");
      });
    });

    it("shows empty fields when budgetConfig is not set", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        runtimeConfig: {},
      }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        const tokenBudgetInput = screen.getByLabelText("Token Budget") as HTMLInputElement;
        expect(tokenBudgetInput.value).toBe("");

        const thresholdInput = screen.getByLabelText("Usage Threshold (%)") as HTMLInputElement;
        expect(thresholdInput.value).toBe("");

        const periodSelect = screen.getByLabelText("Budget Period") as HTMLSelectElement;
        expect(periodSelect.value).toBe("");
      });
    });

    it("calls updateAgent with correct budgetConfig in runtimeConfig on save", async () => {
      mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const tokenBudgetInput = await screen.findByLabelText("Token Budget");
      await user.clear(tokenBudgetInput);
      await user.type(tokenBudgetInput, "500000");

      const thresholdInput = await screen.findByLabelText("Usage Threshold (%)");
      await user.clear(thresholdInput);
      await user.type(thresholdInput, "75");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(mockUpdateAgent).toHaveBeenCalledWith(
          "agent-001",
          expect.objectContaining({
            runtimeConfig: expect.objectContaining({
              budgetConfig: {
                tokenBudget: 500000,
                usageThreshold: 0.75, // Converted from 75% to 0.75 fraction
              },
            }),
          }),
          undefined,
        );
      });
    });

    it("converts usage threshold percentage to fraction when saving", async () => {
      mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const thresholdInput = await screen.findByLabelText("Usage Threshold (%)");
      await user.clear(thresholdInput);
      await user.type(thresholdInput, "90");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        const call = mockUpdateAgent.mock.calls[0];
        const payload = (call as any)[1];
        expect(payload.runtimeConfig.budgetConfig.usageThreshold).toBe(0.9);
      });
    });

    it("removes budgetConfig when all budget fields are cleared", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        runtimeConfig: {
          budgetConfig: {
            tokenBudget: 1000000,
            usageThreshold: 0.8,
          },
          heartbeatIntervalMs: 30000,
        },
      }));
      mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      // Clear all budget fields
      const tokenBudgetInput = await screen.findByLabelText("Token Budget");
      await user.clear(tokenBudgetInput);

      const thresholdInput = await screen.findByLabelText("Usage Threshold (%)");
      await user.clear(thresholdInput);

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(mockUpdateAgent).toHaveBeenCalledWith(
          "agent-001",
          expect.objectContaining({
            runtimeConfig: expect.not.objectContaining({ budgetConfig: expect.anything() }),
          }),
          undefined,
        );
      });
    });

    it("preserves unrelated runtimeConfig keys when saving budget config", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        runtimeConfig: {
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 60000,
        },
      }));
      mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const tokenBudgetInput = await screen.findByLabelText("Token Budget");
      await user.clear(tokenBudgetInput);
      await user.type(tokenBudgetInput, "200000");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        const call = mockUpdateAgent.mock.calls[0];
        const payload = (call as any)[1];
        expect(payload.runtimeConfig.heartbeatIntervalMs).toBe(30000);
        expect(payload.runtimeConfig.heartbeatTimeoutMs).toBe(60000);
        expect(payload.runtimeConfig.budgetConfig.tokenBudget).toBe(200000);
      });
    });

    it("shows validation error for non-numeric token budget", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const tokenBudgetInput = await screen.findByLabelText("Token Budget");
      await user.clear(tokenBudgetInput);
      await user.type(tokenBudgetInput, "abc");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/Token Budget.*must be a valid number/)).toBeInTheDocument();
      });
    });

    it("shows validation error for token budget <= 0", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const tokenBudgetInput = await screen.findByLabelText("Token Budget");
      await user.clear(tokenBudgetInput);
      await user.type(tokenBudgetInput, "0");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/Token Budget.*must be greater than 0/)).toBeInTheDocument();
      });
    });

    it("shows validation error for usage threshold outside 1-100 range", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const thresholdInput = await screen.findByLabelText("Usage Threshold (%)");
      await user.clear(thresholdInput);
      await user.type(thresholdInput, "150");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/Usage Threshold.*must be between 1 and 100/)).toBeInTheDocument();
      });
    });

    it("shows validation error for invalid reset day with weekly period", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        runtimeConfig: {
          budgetConfig: {
            budgetPeriod: "weekly",
          },
        },
      }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      // Change period to weekly
      const periodSelect = await screen.findByLabelText("Budget Period");
      await user.selectOptions(periodSelect, "weekly");

      const resetDayInput = await screen.findByLabelText("Reset Day");
      await user.clear(resetDayInput);
      await user.type(resetDayInput, "7"); // Invalid: 7 is not in 0-6 range

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/Reset Day.*must be between 0.*6.*for weekly/)).toBeInTheDocument();
      });
    });

    it("shows validation error for invalid reset day with monthly period", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        runtimeConfig: {
          budgetConfig: {
            budgetPeriod: "monthly",
          },
        },
      }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      // Change period to monthly
      const periodSelect = await screen.findByLabelText("Budget Period");
      await user.selectOptions(periodSelect, "monthly");

      const resetDayInput = await screen.findByLabelText("Reset Day");
      await user.clear(resetDayInput);
      await user.type(resetDayInput, "32"); // Invalid: 32 is not in 1-31 range

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/Reset Day.*must be between 1 and 31.*for monthly/)).toBeInTheDocument();
      });
    });

    it("enables Save Settings button when budget field is changed", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      const tokenBudgetInput = await screen.findByLabelText("Token Budget");
      await user.clear(tokenBudgetInput);
      await user.type(tokenBudgetInput, "100000");

      await waitFor(() => {
        expect(screen.getByText("Save Settings")).not.toBeDisabled();
      });
    });

    it("shows budget progress bar when budget status has limit configured", async () => {
      // Need to mock twice: once for DashboardTab and once for ConfigTab
      mockFetchAgentBudgetStatus.mockResolvedValue({
        agentId: "agent-001",
        currentUsage: 40000,
        budgetLimit: 50000,
        usagePercent: 80,
        isOverBudget: false,
        isOverThreshold: true,
        budgetPeriod: "monthly",
        lastResetAt: "2026-01-01T00:00:00.000Z",
        nextResetAt: null,
      });

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        expect(screen.getByText("40,000 / 50,000 tokens (80% used)")).toBeInTheDocument();
      });
    });

    it("hides progress bar when no budget limit is configured", async () => {
      mockFetchAgentBudgetStatus.mockResolvedValueOnce({
        agentId: "agent-001",
        currentUsage: 10000,
        budgetLimit: null,
        usagePercent: 0,
        isOverBudget: false,
        isOverThreshold: false,
        budgetPeriod: "lifetime",
        lastResetAt: null,
        nextResetAt: null,
      });

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        // Progress bar should not be visible
        expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
      });
    });

    it("shows Reset Budget button when budget limit is configured", async () => {
      // Need to mock twice: once for DashboardTab and once for ConfigTab
      mockFetchAgentBudgetStatus.mockResolvedValue({
        agentId: "agent-001",
        currentUsage: 30000,
        budgetLimit: 50000,
        usagePercent: 60,
        isOverBudget: false,
        isOverThreshold: false,
        budgetPeriod: "lifetime",
        lastResetAt: "2026-01-01T00:00:00.000Z",
        nextResetAt: null,
      });

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        expect(screen.getByText("Reset Budget Usage")).toBeInTheDocument();
      });
    });

    it("calls resetAgentBudget when Reset Budget button is clicked", async () => {
      const addToast = vi.fn();
      // First call (ConfigTab on mount)
      mockFetchAgentBudgetStatus.mockResolvedValueOnce({
        agentId: "agent-001",
        currentUsage: 30000,
        budgetLimit: 50000,
        usagePercent: 60,
        isOverBudget: false,
        isOverThreshold: false,
        budgetPeriod: "lifetime",
        lastResetAt: "2026-01-01T00:00:00.000Z",
        nextResetAt: null,
      });
      // Second call (after reset)
      mockFetchAgentBudgetStatus.mockResolvedValueOnce({
        agentId: "agent-001",
        currentUsage: 0,
        budgetLimit: 50000,
        usagePercent: 0,
        isOverBudget: false,
        isOverThreshold: false,
        budgetPeriod: "lifetime",
        lastResetAt: "2026-04-10T00:00:00.000Z",
        nextResetAt: null,
      });

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToSettings(user);

      await waitFor(() => {
        expect(screen.getByText("Reset Budget Usage")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Reset Budget Usage"));

      await waitFor(() => {
        expect(mockResetAgentBudget).toHaveBeenCalledWith("agent-001", undefined);
        expect(addToast).toHaveBeenCalledWith("Budget usage reset successfully", "success");
      });
    });
  });

  // ── Runs Tab — Click to show logs ──────────────────────────────────

  describe("Runs Tab — click to show logs", () => {
    const navigateToRuns = async (user: ReturnType<typeof userEvent.setup>) => {
      await waitFor(() => {
        expect(screen.getByText("Runs")).toBeInTheDocument();
      });
      await user.click(screen.getByText("Runs"));
    };

    it("shows run cards as clickable with chevron indicators", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToRuns(user);

      await waitFor(() => {
        // Completed run card should be clickable (has role="button")
        const buttons = screen.getAllByRole("button");
        const runButtons = buttons.filter(btn => btn.getAttribute("aria-label")?.includes("run"));
        expect(runButtons.length).toBeGreaterThan(0);
      });
    });

    it("fetches and displays logs when clicking a completed run", async () => {
      const mockLogs = [
        { timestamp: "2024-01-01T00:01:00.000Z", taskId: "FN-001", text: "Starting task execution", type: "text" },
        { timestamp: "2024-01-01T00:02:00.000Z", taskId: "FN-001", text: "Read file: src/index.ts", type: "tool" },
      ];
      mockFetchAgentRunLogs.mockResolvedValue(mockLogs);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToRuns(user);

      // Wait for run cards to render
      await waitFor(() => {
        const runButtons = screen.getAllByRole("button").filter(
          btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
        );
        expect(runButtons.length).toBeGreaterThan(0);
      });

      // Click the completed run
      const completedRunButton = screen.getAllByRole("button").find(
        btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
      )!;
      await user.click(completedRunButton);

      // Verify fetchAgentRunLogs was called
      await waitFor(() => {
        expect(mockFetchAgentRunLogs).toHaveBeenCalled();
      });

      // Verify logs appear
      await waitFor(() => {
        expect(screen.getByText("Starting task execution")).toBeInTheDocument();
      });
    });

    it("shows loading state while fetching run logs", async () => {
      // Create a promise that won't resolve immediately
      let resolveLogs: (value: any) => void;
      mockFetchAgentRunLogs.mockImplementation(() => new Promise(r => { resolveLogs = r; }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToRuns(user);

      await waitFor(() => {
        const runButtons = screen.getAllByRole("button").filter(
          btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
        );
        expect(runButtons.length).toBeGreaterThan(0);
      });

      const completedRunButton = screen.getAllByRole("button").find(
        btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
      )!;
      await user.click(completedRunButton);

      // Should show loading state
      await waitFor(() => {
        expect(screen.getByText("Loading logs...")).toBeInTheDocument();
      });

      // Resolve to clean up
      resolveLogs!([]);
    });

    it("shows empty message when no logs available for a run", async () => {
      mockFetchAgentRunLogs.mockResolvedValue([]);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToRuns(user);

      await waitFor(() => {
        const runButtons = screen.getAllByRole("button").filter(
          btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
        );
        expect(runButtons.length).toBeGreaterThan(0);
      });

      const completedRunButton = screen.getAllByRole("button").find(
        btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
      )!;
      await user.click(completedRunButton);

      await waitFor(() => {
        expect(screen.getByText("No logs available for this run")).toBeInTheDocument();
      });
    });

    it("collapses log viewer when clicking the same run again", async () => {
      mockFetchAgentRunLogs.mockResolvedValue([
        { timestamp: "2024-01-01T00:01:00.000Z", taskId: "FN-001", text: "Test log entry", type: "text" },
      ]);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToRuns(user);

      await waitFor(() => {
        const runButtons = screen.getAllByRole("button").filter(
          btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
        );
        expect(runButtons.length).toBeGreaterThan(0);
      });

      const completedRunButton = screen.getAllByRole("button").find(
        btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
      )!;

      // Click to expand
      await user.click(completedRunButton);
      await waitFor(() => {
        expect(screen.getByText("Test log entry")).toBeInTheDocument();
      });

      // Click to collapse
      await user.click(completedRunButton);
      await waitFor(() => {
        expect(screen.queryByText("Test log entry")).not.toBeInTheDocument();
      });
    });

    it("shows toast on fetch error", async () => {
      const addToast = vi.fn();
      mockFetchAgentRunLogs.mockRejectedValue(new Error("Network error"));
      mockFetchAgentRunDetail.mockRejectedValue(new Error("Network error"));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToRuns(user);

      await waitFor(() => {
        const runButtons = screen.getAllByRole("button").filter(
          btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
        );
        expect(runButtons.length).toBeGreaterThan(0);
      });

      const completedRunButton = screen.getAllByRole("button").find(
        btn => btn.getAttribute("aria-label")?.includes("run") && btn.getAttribute("aria-label")?.includes("completed")
      )!;
      await user.click(completedRunButton);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          expect.stringContaining("Failed to load run details"),
          "error",
        );
      });
    });
  });

  // ── Instructions Tab ──────────────────────────────────────────────────────

  describe("Instructions Tab", () => {
    const navigateToInstructions = async (user: ReturnType<typeof userEvent.setup>) => {
      await waitFor(() => {
        expect(screen.getByText("Instructions")).toBeInTheDocument();
      });
      await user.click(screen.getByText("Instructions"));
    };

    it("renders Instructions tab with inline instructions and path fields", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToInstructions(user);

      await waitFor(() => {
        expect(screen.getByLabelText("Inline Instructions")).toBeInTheDocument();
        expect(screen.getByLabelText("Instructions File Path")).toBeInTheDocument();
      });
    });

    it("does not show file editor when instructions path is empty", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToInstructions(user);

      await waitFor(() => {
        expect(screen.queryByLabelText("File Content")).not.toBeInTheDocument();
      });
    });

    it("shows file editor when instructions path is set", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        instructionsPath: ".fusion/agents/test-agent.md",
      }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToInstructions(user);

      await waitFor(() => {
        expect(screen.getByLabelText("File Content")).toBeInTheDocument();
      });
    });

    it("calls fetchWorkspaceFileContent when instructions path is set", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        instructionsPath: ".fusion/agents/test-agent.md",
      }));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToInstructions(user);

      await waitFor(() => {
        expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("project", ".fusion/agents/test-agent.md");
      });
    });

    it("shows file content when fetchWorkspaceFileContent succeeds", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        instructionsPath: ".fusion/agents/test-agent.md",
      }));
      mockFetchWorkspaceFileContent.mockResolvedValue({
        content: "# Test Agent Instructions\n\nThese are the agent instructions.",
        mtime: "2024-01-01T00:00:00.000Z",
        size: 60,
      });

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToInstructions(user);

      await waitFor(() => {
        expect(screen.getByLabelText("File Content")).toHaveValue("# Test Agent Instructions\n\nThese are the agent instructions.");
      });
    });

    it("shows error toast when fetchWorkspaceFileContent fails with non-ENOENT error", async () => {
      const addToast = vi.fn();
      mockFetchAgent.mockResolvedValue(createMockAgent({
        instructionsPath: ".fusion/agents/test-agent.md",
      }));
      mockFetchWorkspaceFileContent.mockRejectedValue(new Error("Permission denied"));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToInstructions(user);

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          expect.stringContaining("Failed to load instructions file"),
          "error",
        );
      });
    });

    it("treats ENOENT as empty file (new file state)", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        instructionsPath: ".fusion/agents/new-agent.md",
      }));
      mockFetchWorkspaceFileContent.mockRejectedValue(new Error("ENOENT: file not found"));

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToInstructions(user);

      await waitFor(() => {
        // Should show empty content (new file state), not show error toast
        const fileContent = screen.getByLabelText("File Content") as HTMLTextAreaElement;
        expect(fileContent.value).toBe("");
      });
    });

    it("calls updateAgentInstructions with expected payload when saving inline instructions", async () => {
      const addToast = vi.fn();
      mockUpdateAgentInstructions.mockResolvedValue({} as any);

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToInstructions(user);

      const instructionsTextarea = await screen.findByLabelText("Inline Instructions");
      await user.clear(instructionsTextarea);
      await user.type(instructionsTextarea, "Custom instructions for the agent");

      const pathInput = await screen.findByLabelText("Instructions File Path");
      await user.clear(pathInput);
      await user.type(pathInput, ".fusion/agents/test.md");

      await user.click(screen.getByText("Save Instructions"));

      await waitFor(() => {
        expect(mockUpdateAgentInstructions).toHaveBeenCalledWith(
          "agent-001",
          {
            instructionsText: "Custom instructions for the agent",
            instructionsPath: ".fusion/agents/test.md",
          },
          undefined,
        );
      });
      expect(addToast).toHaveBeenCalledWith("Instructions saved", "success");
    });

    it("calls saveWorkspaceFileContent when saving file content", async () => {
      const addToast = vi.fn();
      mockFetchAgent.mockResolvedValue(createMockAgent({
        instructionsPath: ".fusion/agents/test.md",
      }));
      mockFetchWorkspaceFileContent.mockResolvedValue({
        content: "Original content",
        mtime: "2024-01-01T00:00:00.000Z",
        size: 16,
      });

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToInstructions(user);

      // Wait for file content to load
      await waitFor(() => {
        expect(screen.getByLabelText("File Content")).toHaveValue("Original content");
      });

      // Modify file content
      const fileContent = screen.getByLabelText("File Content");
      await user.clear(fileContent);
      await user.type(fileContent, "Updated content");

      // Save file
      await user.click(screen.getByText("Save File"));

      await waitFor(() => {
        expect(mockSaveWorkspaceFileContent).toHaveBeenCalledWith(
          "project",
          ".fusion/agents/test.md",
          "Updated content",
        );
      });
      expect(addToast).toHaveBeenCalledWith("Instructions file saved", "success");
    });

    it("disables Save Instructions button when no changes", async () => {
      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToInstructions(user);

      await waitFor(() => {
        expect(screen.getByText("Save Instructions")).toBeDisabled();
      });
    });

    it("disables Save File button when file content is not dirty", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        instructionsPath: ".fusion/agents/test.md",
      }));
      mockFetchWorkspaceFileContent.mockResolvedValue({
        content: "Original content",
        mtime: "2024-01-01T00:00:00.000Z",
        size: 16,
      });

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToInstructions(user);

      await waitFor(() => {
        expect(screen.getByText("Save File")).toBeDisabled();
      });
    });

    it("shows Unsaved changes indicator when file content is dirty", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        instructionsPath: ".fusion/agents/test.md",
      }));
      mockFetchWorkspaceFileContent.mockResolvedValue({
        content: "Original content",
        mtime: "2024-01-01T00:00:00.000Z",
        size: 16,
      });

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await navigateToInstructions(user);

      // Wait for file content to load
      await waitFor(() => {
        expect(screen.getByLabelText("File Content")).toHaveValue("Original content");
      });

      // Modify file content
      const fileContent = screen.getByLabelText("File Content");
      await user.clear(fileContent);
      await user.type(fileContent, "Modified content");

      await waitFor(() => {
        expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
      });
    });

    it("forwards projectId to updateAgentInstructions", async () => {
      const addToast = vi.fn();

      const user = userEvent.setup();
      render(
        <AgentDetailView
          agentId="agent-001"
          projectId="proj_456"
          onClose={vi.fn()}
          addToast={addToast}
        />
      );

      await navigateToInstructions(user);

      const instructionsTextarea = await screen.findByLabelText("Inline Instructions");
      await user.clear(instructionsTextarea);
      await user.type(instructionsTextarea, "Custom instructions");

      await user.click(screen.getByText("Save Instructions"));

      await waitFor(() => {
        expect(mockUpdateAgentInstructions).toHaveBeenCalledWith(
          "agent-001",
          expect.objectContaining({
            instructionsText: "Custom instructions",
          }),
          "proj_456",
        );
      });
    });
  });
});
