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

describe("AgentDetailView — budget settings and autosave", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
  });

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

  it("renders editable built-in-model thinking control and saves runtimeConfig.thinkingLevel", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        modelProvider: "openai",
        modelId: "gpt-4o",
        model: "openai/gpt-4o",
        thinkingLevel: "medium",
      },
    }));
    mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);

    const thinkingSelect = await screen.findByLabelText("Agent Model thinking level");
    expect(thinkingSelect).toHaveValue("medium");
    expect(screen.getByTestId("custom-model-dropdown")).toHaveAttribute("data-default-thinking-level", "");

    fireEvent.change(thinkingSelect, { target: { value: "high" } });
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({
            modelProvider: "openai",
            modelId: "gpt-4o",
            model: "openai/gpt-4o",
            thinkingLevel: "high",
          }),
        }),
        undefined,
      );
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
      thresholdPercent: 0.8,
      isOverBudget: false,
      isOverThreshold: true,
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
      usagePercent: null,
      thresholdPercent: null,
      isOverBudget: false,
      isOverThreshold: false,
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
      expect(screen.queryByText(/\d[\d,]*\s*\/\s*\d[\d,]* tokens/)).not.toBeInTheDocument();
    });
  });

  it("shows Reset Budget button when budget limit is configured", async () => {
    // Need to mock twice: once for DashboardTab and once for ConfigTab
    mockFetchAgentBudgetStatus.mockResolvedValue({
      agentId: "agent-001",
      currentUsage: 30000,
      budgetLimit: 50000,
      usagePercent: 60,
      thresholdPercent: 0.8,
      isOverBudget: false,
      isOverThreshold: false,
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
      thresholdPercent: 0.8,
      isOverBudget: false,
      isOverThreshold: false,
      lastResetAt: "2026-01-01T00:00:00.000Z",
      nextResetAt: null,
    });
    // Second call (after reset)
    mockFetchAgentBudgetStatus.mockResolvedValueOnce({
      agentId: "agent-001",
      currentUsage: 0,
      budgetLimit: 50000,
      usagePercent: 0,
      thresholdPercent: 0.8,
      isOverBudget: false,
      isOverThreshold: false,
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


describe("Config autosave", () => {
  const openSettings = async (user: ReturnType<typeof userEvent.setup>) => {
    const settingsTab = await screen.findByRole("button", { name: "Settings" });
    await user.click(settingsTab);
    await screen.findByText("Agent Configuration");
  };

  it("auto-saves after debounce without clicking Save Settings", async () => {
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);

    const heartbeatInput = screen.getByLabelText("Heartbeat Interval (s)");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "45");

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    expect(mockUpdateAgent.mock.calls[0]?.[1]).toMatchObject({
      runtimeConfig: expect.objectContaining({ heartbeatIntervalMs: 45_000 }),
    });
  });

  it("does not autosave while validation errors are present", async () => {
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);

    const heartbeatInput = screen.getByLabelText("Heartbeat Interval (s)");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "abc");

    await waitFor(() => {
      expect(screen.getByText('"Heartbeat Interval" must be a valid number')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledTimes(0);
    }, { timeout: 900 });
  });

  it("shows saving then saved indicator during autosave", async () => {
    const initialAgent = createMockAgent();
    const refreshedAgent = createMockAgent({
      runtimeConfig: { ...(initialAgent.runtimeConfig ?? {}), heartbeatTimeoutMs: 90_000 },
      updatedAt: "2024-01-01T00:10:00.000Z",
    });
    mockFetchAgent.mockReset();
    mockFetchAgent.mockResolvedValueOnce(initialAgent).mockResolvedValue(refreshedAgent);

    let resolveSave: (() => void) | null = null;
    mockUpdateAgent.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSave = () => resolve(createMockAgent() as any);
    }));

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);

    const heartbeatInput = screen.getByLabelText("Heartbeat Timeout (s)");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "90");

    await waitFor(() => {
      expect(screen.getByText("Saving changes…")).toBeInTheDocument();
    }, { timeout: 3000 });

    resolveSave?.();
    await waitFor(() => {
      expect(screen.getByText("All changes saved")).toBeInTheDocument();
    });
  });

  it("debounces rapid edits into a single autosave using latest value", async () => {
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);

    const heartbeatInput = screen.getByLabelText("Heartbeat Interval (s)");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "1");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "12");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "123");

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledTimes(1);
    }, { timeout: 4000 });
    expect(mockUpdateAgent.mock.calls[0]?.[1]).toMatchObject({
      runtimeConfig: expect.objectContaining({ heartbeatIntervalMs: 123_000 }),
    });
  });

  it("renders heartbeat scope discipline selector and saves override", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: { heartbeatScopeDiscipline: "lite" },
    }));

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);

    const select = screen.getByLabelText("Heartbeat Scope Discipline") as HTMLSelectElement;
    expect(select.value).toBe("lite");

    await user.selectOptions(select, "off");

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalled();
    }, { timeout: 3000 });

    expect(mockUpdateAgent.mock.calls.at(-1)?.[1]).toMatchObject({
      runtimeConfig: expect.objectContaining({ heartbeatScopeDiscipline: "off" }),
    });
  });

  it("clears heartbeat scope discipline when inherit project default is selected", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: { heartbeatScopeDiscipline: "strict" },
    }));

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);

    const select = screen.getByLabelText("Heartbeat Scope Discipline") as HTMLSelectElement;
    await user.selectOptions(select, "");

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalled();
    }, { timeout: 3000 });

    const latestPayload = mockUpdateAgent.mock.calls.at(-1)?.[1] as { runtimeConfig?: Record<string, unknown> };
    expect(latestPayload.runtimeConfig).toBeDefined();
    expect(latestPayload.runtimeConfig).not.toHaveProperty("heartbeatScopeDiscipline");
  });

  it("saves heartbeat prompt template override", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: { heartbeatPromptTemplate: "default" },
    } as any));

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);

    const select = screen.getByLabelText("Heartbeat Prompt Template") as HTMLSelectElement;
    await user.selectOptions(select, "compact");

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalled();
    }, { timeout: 3000 });

    expect(mockUpdateAgent.mock.calls.at(-1)?.[1]).toMatchObject({
      runtimeConfig: expect.objectContaining({ heartbeatPromptTemplate: "compact" }),
    });
  });

  it("clears heartbeat prompt template when inherit project default is selected", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: { heartbeatPromptTemplate: "compact" },
    } as any));

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);

    const select = screen.getByLabelText("Heartbeat Prompt Template") as HTMLSelectElement;
    await user.selectOptions(select, "");

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalled();
    }, { timeout: 3000 });

    const latestPayload = mockUpdateAgent.mock.calls.at(-1)?.[1] as { runtimeConfig?: Record<string, unknown> };
    expect(latestPayload.runtimeConfig).toBeDefined();
    expect(latestPayload.runtimeConfig).not.toHaveProperty("heartbeatPromptTemplate");
  });
});

});
