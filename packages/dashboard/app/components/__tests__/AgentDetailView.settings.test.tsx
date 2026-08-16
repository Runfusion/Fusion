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
  mockFetchSettings,
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

/*
FNXC:AgentSettingsTestLatency 2026-08-15-21:10:
FN-2707 fake-timer pattern for the Settings config autosave debounce (CONFIG_AUTOSAVE_DEBOUNCE_MS = 700ms),
which previously ran on real timers so every autosave test paid the debounce in wall-clock time.
Mount/navigation must stay on real timers (the floating-window shell and initial agent load hang under a
faked scheduler), so fake timers are enabled mid-test via beginAutosaveFakeTimers() just before the field
edit that arms the debounce, advanced inside act(), and discarded (not run) on restore so no autosave fires
into an unmounted tree.
RTL v16's asyncWrapper only advances fake time through a GLOBAL `jest.advanceTimersByTime` (vitest defines
no `jest`), so without the scoped jest shim below every userEvent call deadlocks on a faked setTimeout(0).
The shim exists only while fake timers are armed and is deleted in afterEach.
*/
const AUTOSAVE_DEBOUNCE_ADVANCE_MS = 750;

const setupUser = () =>
  userEvent.setup({
    advanceTimers: (ms) => {
      if (vi.isFakeTimers()) {
        vi.advanceTimersByTime(ms);
      }
    },
  });

const beginAutosaveFakeTimers = () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  (globalThis as any).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };
};

const advanceAutosaveDebounce = async () => {
  await act(async () => {
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_ADVANCE_MS);
  });
};

describe("AgentDetailView — budget settings and autosave", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
  });

  afterEach(() => {
    delete (globalThis as any).jest;
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

describe("Budget Settings", () => {
  const navigateToSettings = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Settings"));
  };

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

    const user = setupUser();
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

  // FNXC:AgentSettingsTestLatency 2026-08-15-21:20: aggregate control contract — merges the former
  // per-control field-presence test with the empty-prefill test (one mount covers both; FN-5048 trim).
  it("renders all Budget Settings fields, empty when budgetConfig is not set", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {},
    }));

    const user = setupUser();
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

      expect(screen.getByLabelText("Reset Day")).toBeInTheDocument();
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

    const user = setupUser();
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

  it("shows inherited role thinking without materializing an agent override", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      role: "merger" as AgentCapability,
      roles: ["merger"] as AgentCapability[],
      metadata: { builtInWorkflowRole: true, workflowRole: "merger" },
      runtimeConfig: { enabled: false },
    }));
    mockFetchSettings.mockResolvedValue({
      defaultProviderOverride: "anthropic",
      defaultModelIdOverride: "claude-project",
      defaultThinkingLevelOverride: "high",
    } as any);

    const user = setupUser();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToSettings(user);

    await screen.findByLabelText("Agent Model thinking level");
    expect(screen.getByTestId("custom-model-dropdown")).toHaveAttribute("data-default-thinking-level", "high");
  });

  it("calls updateAgent with correct budgetConfig in runtimeConfig on save", async () => {
    mockUpdateAgent.mockResolvedValue(createMockAgent() as any);

    const user = setupUser();
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

    const user = setupUser();
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

    const user = setupUser();
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

    const user = setupUser();
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

  // FNXC:AgentSettingsTestLatency 2026-08-15-21:20: the five per-field validation cases share one
  // tabular skeleton (edit invalid value -> Save -> inline error); condensed to it.each with every
  // original case preserved as a row (FN-5048 trim).
  it.each([
    {
      label: "non-numeric token budget",
      budgetPeriod: undefined,
      field: "Token Budget",
      value: "abc",
      error: /Token Budget.*must be a valid number/,
    },
    {
      label: "token budget <= 0",
      budgetPeriod: undefined,
      field: "Token Budget",
      value: "0",
      error: /Token Budget.*must be greater than 0/,
    },
    {
      label: "usage threshold outside 1-100 range",
      budgetPeriod: undefined,
      field: "Usage Threshold (%)",
      value: "150",
      error: /Usage Threshold.*must be between 1 and 100/,
    },
    {
      label: "invalid reset day with weekly period",
      budgetPeriod: "weekly" as const,
      field: "Reset Day",
      value: "7", // Invalid: 7 is not in 0-6 range
      error: /Reset Day.*must be between 0.*6.*for weekly/,
    },
    {
      label: "invalid reset day with monthly period",
      budgetPeriod: "monthly" as const,
      field: "Reset Day",
      value: "32", // Invalid: 32 is not in 1-31 range
      error: /Reset Day.*must be between 1 and 31.*for monthly/,
    },
  ])("shows validation error for $label", async ({ budgetPeriod, field, value, error }) => {
    if (budgetPeriod) {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        runtimeConfig: {
          budgetConfig: {
            budgetPeriod,
          },
        },
      }));
    }

    const user = setupUser();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />
    );

    await navigateToSettings(user);

    if (budgetPeriod) {
      const periodSelect = await screen.findByLabelText("Budget Period");
      await user.selectOptions(periodSelect, budgetPeriod);
    }

    const input = await screen.findByLabelText(field);
    await user.clear(input);
    await user.type(input, value);

    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(screen.getByText(error)).toBeInTheDocument();
    });
  });

  it("enables Save Settings button when budget field is changed", async () => {
    const user = setupUser();
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

    const user = setupUser();
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

    const user = setupUser();
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

  // FNXC:AgentSettingsTestLatency 2026-08-15-21:20: the standalone "shows Reset Budget button when
  // budget limit is configured" presence test was folded into the click test below, which waits for
  // the same button under the same budget-status shape before clicking (FN-5048 trim).
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

    const user = setupUser();
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
    const user = setupUser();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    beginAutosaveFakeTimers();

    const heartbeatInput = screen.getByLabelText("Heartbeat Interval (s)");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "45");
    await advanceAutosaveDebounce();

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    expect(mockUpdateAgent.mock.calls[0]?.[1]).toMatchObject({
      runtimeConfig: expect.objectContaining({ heartbeatIntervalMs: 45_000 }),
    });
  });

  it("does not autosave while validation errors are present", async () => {
    const user = setupUser();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    beginAutosaveFakeTimers();

    const heartbeatInput = screen.getByLabelText("Heartbeat Interval (s)");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "abc");

    await waitFor(() => {
      expect(screen.getByText('"Heartbeat Interval" must be a valid number')).toBeInTheDocument();
    });
    await advanceAutosaveDebounce();
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

    const user = setupUser();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    beginAutosaveFakeTimers();

    const heartbeatInput = screen.getByLabelText("Heartbeat Timeout (s)");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "90");
    await advanceAutosaveDebounce();

    await waitFor(() => {
      expect(screen.getByText("Saving changes…")).toBeInTheDocument();
    }, { timeout: 3000 });

    resolveSave?.();
    await waitFor(() => {
      expect(screen.getByText("All changes saved")).toBeInTheDocument();
    });
  });

  it("debounces rapid edits into a single autosave using latest value", async () => {
    const user = setupUser();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    beginAutosaveFakeTimers();

    const heartbeatInput = screen.getByLabelText("Heartbeat Interval (s)");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "1");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "12");
    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "123");
    await advanceAutosaveDebounce();

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

    const user = setupUser();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    beginAutosaveFakeTimers();

    const select = screen.getByLabelText("Heartbeat Scope Discipline") as HTMLSelectElement;
    expect(select.value).toBe("lite");

    await user.selectOptions(select, "off");
    await advanceAutosaveDebounce();

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

    const user = setupUser();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    beginAutosaveFakeTimers();

    const select = screen.getByLabelText("Heartbeat Scope Discipline") as HTMLSelectElement;
    await user.selectOptions(select, "");
    await advanceAutosaveDebounce();

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

    const user = setupUser();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    beginAutosaveFakeTimers();

    const select = screen.getByLabelText("Heartbeat Prompt Template") as HTMLSelectElement;
    await user.selectOptions(select, "compact");
    await advanceAutosaveDebounce();

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

    const user = setupUser();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    beginAutosaveFakeTimers();

    const select = screen.getByLabelText("Heartbeat Prompt Template") as HTMLSelectElement;
    await user.selectOptions(select, "");
    await advanceAutosaveDebounce();

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalled();
    }, { timeout: 3000 });

    const latestPayload = mockUpdateAgent.mock.calls.at(-1)?.[1] as { runtimeConfig?: Record<string, unknown> };
    expect(latestPayload.runtimeConfig).toBeDefined();
    expect(latestPayload.runtimeConfig).not.toHaveProperty("heartbeatPromptTemplate");
  });
});

});
