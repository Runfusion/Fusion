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

describe("AgentDetailView — logs, tasks, and runs", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token-usage")) {
        return new Response(JSON.stringify({
          last24h: { totalInputTokens: 100, totalCachedTokens: 50, totalCacheWriteTokens: 10, totalOutputTokens: 20, nTasks: 2, hitRatio: 0.3333 },
          last7d: { totalInputTokens: 200, totalCachedTokens: 100, totalCacheWriteTokens: 20, totalOutputTokens: 40, nTasks: 3, hitRatio: 0.3333 },
          allTime: { totalInputTokens: 300, totalCachedTokens: 150, totalCacheWriteTokens: 30, totalOutputTokens: 60, nTasks: 4, hitRatio: 0.3333 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });

describe("Logs tab", () => {
  it("loads latest run logs lazily for agents without a current task", async () => {
    const latestRun = {
      id: "run-1001",
      agentId: "agent-001",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: null,
      status: "active",
    } as AgentHeartbeatRun;
    mockFetchAgent.mockResolvedValue(createMockAgent({
      taskId: undefined,
      activeRun: latestRun,
      completedRuns: [],
    }));
    mockFetchAgentRuns.mockResolvedValue([latestRun]);
    mockFetchAgentRunLogs.mockResolvedValue([
      { timestamp: "2024-01-01T00:01:00.000Z", taskId: "agent-run", text: "First entry", type: "text" },
      { timestamp: "2024-01-01T00:02:00.000Z", taskId: "agent-run", text: "Second entry", type: "text" },
    ]);

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

    expect(mockFetchAgentRuns).not.toHaveBeenCalled();
    expect(mockFetchAgentRunLogs).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Logs"));

    await waitFor(() => {
      expect(mockFetchAgentRuns).toHaveBeenCalledWith("agent-001", 1, undefined);
      expect(mockFetchAgentRunLogs).toHaveBeenCalledWith("agent-001", "run-1001", undefined);
    });

    expect(screen.getByText("Latest run · run-1001")).toBeInTheDocument();
    await waitFor(() => {
      const viewer = screen.getByTestId("agent-log-viewer");
      expect(viewer.textContent).toContain("First entry");
      expect(viewer.textContent).toContain("Second entry");
    });
  });

  it("renders log entries in chronological order (oldest first)", async () => {
    const latestRun = {
      id: "run-1002",
      agentId: "agent-001",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: null,
      status: "active",
    } as AgentHeartbeatRun;
    mockFetchAgent.mockResolvedValue(createMockAgent({
      taskId: undefined,
      activeRun: latestRun,
      completedRuns: [],
    }));
    mockFetchAgentRuns.mockResolvedValue([latestRun]);
    mockFetchAgentRunLogs.mockResolvedValue([
      { timestamp: "2024-01-01T00:01:00.000Z", taskId: "agent-run", text: "Oldest entry", type: "text" },
      { timestamp: "2024-01-01T00:02:00.000Z", taskId: "agent-run", text: "Middle entry", type: "text" },
      { timestamp: "2024-01-01T00:03:00.000Z", taskId: "agent-run", text: "Newest entry", type: "text" },
    ]);

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

    fireEvent.click(screen.getByText("Logs"));

    await waitFor(() => {
      expect(screen.getByText("Oldest entry")).toBeInTheDocument();
    });

    const viewerText = screen.getByTestId("agent-log-viewer").textContent ?? "";
    expect(viewerText.indexOf("Oldest entry")).toBeLessThan(viewerText.indexOf("Middle entry"));
    expect(viewerText.indexOf("Middle entry")).toBeLessThan(viewerText.indexOf("Newest entry"));
  });

  it("renders tool details collapsed by default", async () => {
    const latestRun = {
      id: "run-1003",
      agentId: "agent-001",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: null,
      status: "active",
    } as AgentHeartbeatRun;
    mockFetchAgent.mockResolvedValue(createMockAgent({
      taskId: undefined,
      activeRun: latestRun,
      completedRuns: [],
    }));
    mockFetchAgentRuns.mockResolvedValue([latestRun]);
    mockFetchAgentRunLogs.mockResolvedValue([
      {
        timestamp: "2024-01-01T00:00:00.000Z",
        taskId: "agent-run",
        type: "tool",
        text: "ls -la packages/",
        detail: "very long tool output",
      },
    ]);

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByText("Logs"));
    await screen.findByText("ls -la packages/");
    const toggle = await screen.findByTestId("tool-detail-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("agent-log-viewer")).toBeInTheDocument();
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


describe("Runs Tab — click to show logs", () => {
  it("shows cache hit ratio section for permanent agents", async () => {
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await user.click(await screen.findByText("Runs"));
    await waitFor(() => {
      expect(screen.getByText("Cache hit ratio")).toBeInTheDocument();
      expect(screen.getByText(/Last 24h:/)).toBeInTheDocument();
      expect(screen.getAllByText(/33.3%/)).toHaveLength(3);
    });
  });

  it("hides cache hit ratio section for ephemeral agents", async () => {
    const user = userEvent.setup();
    mockFetchAgent.mockResolvedValue(createMockAgent({ metadata: { type: "spawned" } as any }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token-usage")) {
        return new Response(JSON.stringify({ error: "Token usage is not available for ephemeral agents" }), { status: 400 });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await user.click(await screen.findByText("Runs"));

    await waitFor(() => {
      expect(screen.queryByText("Cache hit ratio")).not.toBeInTheDocument();
    });
  });
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

  it("keeps the active run log stream subscribed across run-list polling", async () => {
    const intervalCallbacks: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === "function") {
        intervalCallbacks.push(callback as () => void);
      }
      return 1 as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(((id?: ReturnType<typeof setInterval>) => {
      void id;
    }) as typeof clearInterval);

    try {
      const activeRun = {
        id: "run-live-1",
        agentId: "agent-001",
        startedAt: "2024-01-01T00:00:00.000Z",
        endedAt: null,
        status: "active",
      } as AgentHeartbeatRun;
      mockFetchAgent.mockResolvedValue(createMockAgent({
        activeRun,
        completedRuns: [],
      }));
      mockFetchAgentRuns.mockResolvedValue([activeRun]);
      mockFetchAgentRunLogs.mockResolvedValue([]);
      mockFetchAgentRunDetail.mockResolvedValue(activeRun);

      render(
        <AgentDetailView
          agentId="agent-001"
          onClose={vi.fn()}
          addToast={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Runs")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("Runs"));

      await waitFor(() => {
        expect(screen.getByText("Live Run")).toBeInTheDocument();
      });

      const activeRunButton = screen.getAllByRole("button").find(
        (btn) => btn.getAttribute("aria-label")?.includes("run-live")
          && btn.getAttribute("aria-label")?.includes("active"),
      );
      expect(activeRunButton).toBeTruthy();
      fireEvent.click(activeRunButton!);

      await waitFor(() => {
        expect(mockFetchAgentRunLogs).toHaveBeenCalledWith("agent-001", "run-live-1", undefined);
      });

      const streamUrl = "/api/agents/agent-001/runs/run-live-1/logs/stream";
      expect(
        mockSubscribeSse.mock.calls.filter(([url]) => url === streamUrl),
      ).toHaveLength(1);

      await act(async () => {
        intervalCallbacks.forEach((callback) => callback());
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(mockFetchAgentRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
      expect(
        mockSubscribeSse.mock.calls.filter(([url]) => url === streamUrl),
      ).toHaveLength(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("fetches and displays logs when clicking a completed run", async () => {
    const mockLogs: AgentLogEntry[] = [
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


});
