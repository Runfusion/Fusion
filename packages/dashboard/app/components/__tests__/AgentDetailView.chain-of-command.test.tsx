import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { loadAllAppCss } from "../../test/cssFixture";
import type { AgentHeartbeatRun } from "../../api";
import type { AgentLogEntry } from "@fusion/core";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../../utils/heartbeatIntervals";
import {
  MOCK_SKILLS,
  createMockAgent,
  mockConfirm,
  mockDeleteAgent,
  mockFetchAgent,
  mockFetchAgentBudgetStatus,
  mockFetchAgentChildren,
  mockFetchAgentLogsWithMeta,
  mockFetchAgentMailbox,
  mockFetchAgentMemoryFile,
  mockFetchAgentMemoryFiles,
  mockFetchAgentRunDetail,
  mockFetchAgentRunLogs,
  mockFetchAgentRuns,
  mockFetchAgentTasks,
  mockFetchAgents,
  mockFetchChainOfCommand,
  mockFetchCompanies,
  mockFetchDiscoveredSkills,
  mockFetchModels,
  mockFetchPluginRuntimes,
  mockFetchSkillContent,
  mockFetchWorkspaceFileContent,
  mockMarkMessageRead,
  mockResetAgentBudget,
  mockSaveAgentMemoryFile,
  mockSaveWorkspaceFileContent,
  mockStartAgentRun,
  mockSubscribeSse,
  mockUpdateAgent,
  mockUpdateAgentInstructions,
  mockUpdateAgentMemory,
  mockUpdateAgentSoul,
  mockUpdateAgentState,
  mockUpdateGlobalSettings,
  mockUpgradeAgentHeartbeatProcedure,
  setupAgentDetailMocks,
} from "./AgentDetailView.test-helpers";
import { AgentDetailView } from "../AgentDetailView";

describe("AgentDetailView — chain of command", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
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
    const resolvedChain = [{ id: "agent-001", name: "Test Agent" } as AgentDetail];
    const resolveChainCalls: Array<(agents: AgentDetail[]) => void> = [];
    mockFetchChainOfCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveChainCalls.push(resolve as (agents: AgentDetail[]) => void);
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

    // React Strict Mode and concurrent rendering can trigger extra effect passes.
    // Make late calls auto-resolve so the loading state can settle deterministically.
    mockFetchChainOfCommand.mockResolvedValue(resolvedChain as any);

    await act(async () => {
      // Allow any additional in-flight calls to register before resolving all pendings.
      await Promise.resolve();
      while (resolveChainCalls.length > 0) {
        const resolve = resolveChainCalls.shift();
        resolve?.(resolvedChain);
        await Promise.resolve();
      }
    });

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

it("opens directly to Runs tab and auto-expands the provided initial run", async () => {
  const runId = "run-001";
  mockFetchAgentRunLogs.mockResolvedValueOnce([
    {
      timestamp: "2024-01-01T00:00:00.000Z",
      taskId: "agent-run",
      text: "Run log line",
      type: "text",
    } as AgentLogEntry,
  ]);
  mockFetchAgentRunDetail.mockResolvedValueOnce({
    id: runId,
    agentId: "agent-001",
    startedAt: "2024-01-01T00:00:00.000Z",
    endedAt: null,
    status: "active",
    systemPrompt: "System prompt text",
  } as AgentHeartbeatRun);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
      initialTab="runs"
      initialRunId={runId}
    />,
  );

  await waitFor(() => {
    expect(mockFetchAgentRunLogs).toHaveBeenCalledWith("agent-001", runId, undefined);
    expect(mockFetchAgentRunDetail).toHaveBeenCalledWith("agent-001", runId, undefined);
  });

  await waitFor(() => {
    expect(screen.getByText("Run log line")).toBeInTheDocument();
    expect(screen.getByText("System Prompt")).toBeInTheDocument();
  });
});

it("shows run error in modal and launches prefilled GitHub issue", async () => {
  const runId = "run-error";
  mockFetchAgentRuns.mockResolvedValueOnce([
    {
      id: runId,
      agentId: "agent-001",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: "2024-01-01T00:01:00.000Z",
      status: "failed",
    } as AgentHeartbeatRun,
  ]);
  mockFetchAgentRunLogs.mockResolvedValueOnce([]);
  mockFetchAgentRunDetail.mockResolvedValueOnce({
    id: runId,
    agentId: "agent-001",
    startedAt: "2024-01-01T00:00:00.000Z",
    endedAt: "2024-01-01T00:01:00.000Z",
    status: "failed",
    stderrExcerpt: "fatal: exploded",
  } as AgentHeartbeatRun);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
      initialTab="runs"
      initialRunId={runId}
    />,
  );

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Open error details" })).toBeInTheDocument();
  });

  expect(screen.queryByText("fatal: exploded")).toBeNull();
  expect(screen.queryByLabelText("Agent error details")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open error details" }));
  expect(screen.getByLabelText("Agent error details")).toBeInTheDocument();
  expect(screen.getByText("fatal: exploded")).toBeInTheDocument();

  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  fireEvent.click(screen.getByRole("link", { name: "Report on GitHub" }));
  expect(openSpy).toHaveBeenCalledWith(
    expect.stringContaining("https://github.com/Runfusion/Fusion/issues/new?"),
    "_blank",
    "noopener,noreferrer",
  );
  expect(openSpy.mock.calls[0]?.[0]).toContain("run-error");
  openSpy.mockRestore();
});

it("renders Run Now in header for active and idle states only", async () => {
  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Run now for Test Agent" })).toBeInTheDocument();
  });

  cleanup();
  mockFetchAgent.mockResolvedValueOnce(createMockAgent({ state: "idle", taskId: undefined }));
  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Run now for Test Agent" })).toBeInTheDocument();
  });

  cleanup();
  mockFetchAgent.mockResolvedValueOnce(createMockAgent({ state: "running", taskId: undefined }));
  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Run now for Test Agent" })).not.toBeInTheDocument();
  });
});

it("starts run from header and refreshes runs without runs-tab Run Now", async () => {
  const addToast = vi.fn();
  const user = userEvent.setup();
  mockFetchAgentRuns.mockResolvedValue([
    {
      id: "run-001",
      agentId: "agent-001",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: null,
      status: "active",
    } as AgentHeartbeatRun,
  ]);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={addToast}
    />,
  );

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Run now for Test Agent" })).toBeInTheDocument();
  });

  await user.click(screen.getByRole("button", { name: "Run now for Test Agent" }));

  await waitFor(() => {
    expect(mockStartAgentRun).toHaveBeenCalledWith("agent-001", undefined, {
      source: "on_demand",
      triggerDetail: "Triggered from dashboard",
    });
  });

  await waitFor(() => {
    expect(addToast).toHaveBeenCalledWith("Heartbeat run started for Test Agent", "success");
  });

  await user.click(screen.getByText("Runs"));

  const initialRunFetchCalls = mockFetchAgentRuns.mock.calls.length;
  await waitFor(() => {
    expect(initialRunFetchCalls).toBeGreaterThan(0);
  });

  await user.click(screen.getByRole("button", { name: "Run now for Test Agent" }));

  await waitFor(() => {
    expect(mockFetchAgentRuns.mock.calls.length).toBeGreaterThan(initialRunFetchCalls);
  });

  expect(screen.getAllByRole("button", { name: "Run now for Test Agent" })).toHaveLength(1);
});

it("auto-expands the active run when opened from running control context", async () => {
  const activeRunId = "run-001";
  mockFetchAgentRunLogs.mockResolvedValueOnce([
    {
      timestamp: "2024-01-01T00:00:00.000Z",
      taskId: "agent-run",
      text: "Active run log line",
      type: "text",
    } as AgentLogEntry,
  ]);
  mockFetchAgentRunDetail.mockResolvedValueOnce({
    id: activeRunId,
    agentId: "agent-001",
    startedAt: "2024-01-01T00:00:00.000Z",
    endedAt: null,
    status: "active",
    systemPrompt: "Active run system prompt",
  } as AgentHeartbeatRun);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
      initialTab="runs"
      initialRunId={null}
      preferActiveRun
    />,
  );

  await waitFor(() => {
    expect(mockFetchAgentRunLogs).toHaveBeenCalledWith("agent-001", activeRunId, undefined);
    expect(mockFetchAgentRunDetail).toHaveBeenCalledWith("agent-001", activeRunId, undefined);
  });

  await waitFor(() => {
    expect(screen.getByText("System Prompt")).toBeInTheDocument();
    const viewer = screen.getByTestId("agent-log-viewer");
    expect(viewer.textContent).toContain("Active run log line");
  });
});


});
