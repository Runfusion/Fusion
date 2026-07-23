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

describe("AgentDetailView — advanced settings", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
  });

describe("Advanced Settings", () => {
  const navigateToSettings = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Settings"));
  };

  it("opens AI Interview in edit mode and applies draft values to local settings fields", async () => {
    const user = userEvent.setup();

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);
    await user.click(await screen.findByRole("button", { name: "AI Interview" }));

    expect(await screen.findByTestId("mock-ai-interview-modal")).toBeInTheDocument();
    expect(screen.getByTestId("mock-ai-interview-mode")).toHaveTextContent("edit");
    expect(screen.getByTestId("mock-ai-existing-config").textContent).toContain("Test Agent");

    await user.click(screen.getByRole("button", { name: "Apply Draft" }));

    await waitFor(() => {
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Interviewed Agent");
      expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Draft Title");
      expect((screen.getByLabelText("Icon") as HTMLInputElement).value).toBe("🧠");
      expect((screen.getByLabelText("Role") as HTMLSelectElement).value).toBe("reviewer");
    });
    expect(mockUpdateAgent).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save Settings" }));
    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          name: "Interviewed Agent",
          role: "reviewer",
          title: "Draft Title",
          reportsTo: "agent-002",
          runtimeConfig: expect.objectContaining({ model: "openai/gpt-4o" }),
          metadata: { skills: ["skill-1"] },
        }),
        undefined,
      );
    });
  });

  it("shows settings delete control for idle and paused agents", async () => {
    const user = userEvent.setup();

    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "idle" }));
    const idleRender = render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);
    expect(await screen.findByRole("button", { name: "Delete Agent" })).toBeEnabled();
    idleRender.unmount();

    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "paused" }));
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);
    expect(await screen.findByRole("button", { name: "Delete Agent" })).toBeEnabled();
  });

  it("deletes an agent from Settings after confirmation", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "idle" }));
    const addToast = vi.fn();
    const onClose = vi.fn();
    const onMutationSuccess = vi.fn();
    const user = userEvent.setup();

    render(
      <AgentDetailView
        agentId="agent-001"
        projectId="proj_123"
        onClose={onClose}
        addToast={addToast}
        onMutationSuccess={onMutationSuccess}
      />,
    );

    await navigateToSettings(user);
    await user.click(await screen.findByRole("button", { name: "Delete Agent" }));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Delete Agent",
        message: 'Delete agent "Test Agent"? This cannot be undone.',
        danger: true,
      });
      expect(mockDeleteAgent).toHaveBeenCalledWith("agent-001", "proj_123");
      expect(addToast).toHaveBeenCalledWith('Agent "Test Agent" deleted', "success");
      expect(onMutationSuccess).toHaveBeenCalledWith({ agentId: "agent-001", deleted: true });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("does not delete from Settings when confirmation is canceled", async () => {
    mockConfirm.mockResolvedValueOnce(false);
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "idle" }));
    const addToast = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <AgentDetailView
        agentId="agent-001"
        projectId="proj_123"
        onClose={onClose}
        addToast={addToast}
      />,
    );

    await navigateToSettings(user);
    await user.click(await screen.findByRole("button", { name: "Delete Agent" }));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
    });
    expect(mockDeleteAgent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining("deleted"), "success");
  });

  it("shows settings delete control as unavailable for non-deletable states", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ state: "active" }));
    const user = userEvent.setup();

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);

    expect(await screen.findByRole("button", { name: "Delete Agent" })).toBeDisabled();
    expect(
      screen.getByText("Agent deletion is only available when state is idle or paused (current state: active)."),
    ).toBeInTheDocument();
  });

  /*
  FNXC:AgentSettingsTheming 2026-07-23-13:01:
  Settings runtime tabs and avatar actions retain their semantic roles and pending-disabled behavior while scoped CSS themes their selected, hover, and focus states. Rendered coverage keeps those controls present across avatar and runtime selections.
  */
  it("renders avatar actions for absent and existing avatars", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToSettings(user);
    expect(await screen.findByRole("button", { name: "Upload Avatar" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Remove Avatar" })).not.toBeInTheDocument();
    unmount();

    mockFetchAgent.mockResolvedValue(createMockAgent({ imageUrl: "https://example.test/avatar.png" }));
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToSettings(user);
    expect(await screen.findByRole("button", { name: "Upload Avatar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Avatar" })).toBeEnabled();
  });

  it("preserves selected and unselected runtime-tab semantics", async () => {
    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await navigateToSettings(user);

    const builtIn = await screen.findByRole("tab", { name: "Built-in Model" });
    const runtime = screen.getByRole("tab", { name: "Plugin Runtime" });
    expect(builtIn).toHaveAttribute("aria-selected", "true");
    expect(runtime).toHaveAttribute("aria-selected", "false");
    expect(builtIn).toHaveClass("active");

    await user.click(runtime);
    expect(runtime).toHaveAttribute("aria-selected", "true");
    expect(builtIn).toHaveAttribute("aria-selected", "false");
    expect(runtime).toHaveClass("active");
  });

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
      expect(screen.getByLabelText("Heartbeat Interval (s)")).toBeInTheDocument();
      expect(screen.getByLabelText("Heartbeat Timeout (s)")).toBeInTheDocument();
      // Advanced Settings section
      expect(screen.getByLabelText("Max Retries")).toBeInTheDocument();
      expect(screen.getByLabelText("Task Timeout (ms)")).toBeInTheDocument();
      expect(screen.getByLabelText("Log Level")).toBeInTheDocument();
    });
  });

  it("renders Reports To as a manager dropdown sourced from fetched agents", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);

    await waitFor(() => {
      expect(mockFetchAgents).toHaveBeenCalledWith(undefined, undefined);
    });

    const reportsToSelect = await screen.findByLabelText("Reports To") as HTMLSelectElement;
    expect(reportsToSelect.tagName).toBe("SELECT");

    const optionValues = Array.from(reportsToSelect.options).map((option) => option.value);
    expect(optionValues).toContain("");
    expect(optionValues).toContain("agent-002");
    expect(optionValues).toContain("agent-003");
    expect(optionValues).not.toContain("agent-001");
  });

  it("shows existing reportsTo value as selected manager", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ reportsTo: "agent-003" } as any));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);

    const reportsToSelect = await screen.findByLabelText("Reports To") as HTMLSelectElement;
    expect(reportsToSelect.value).toBe("agent-003");
  });

  it("preserves unknown reportsTo ids in dropdown until changed", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ reportsTo: "agent-missing" } as any));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);

    const reportsToSelect = await screen.findByLabelText("Reports To") as HTMLSelectElement;
    expect(reportsToSelect.value).toBe("agent-missing");
    expect(screen.getByRole("option", { name: "Unknown manager (agent-missing)" })).toBeInTheDocument();
  });

  it("saves selected manager id via updateAgent reportsTo", async () => {
    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);

    const reportsToSelect = await screen.findByLabelText("Reports To");
    await user.selectOptions(reportsToSelect, "agent-003");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({ reportsTo: "agent-003" }),
        undefined,
      );
    });
  });

  it("clears reportsTo when selecting No manager", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ reportsTo: "agent-002" } as any));

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);

    const reportsToSelect = await screen.findByLabelText("Reports To");
    await user.selectOptions(reportsToSelect, "");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({ reportsTo: undefined }),
        undefined,
      );
    });
  });

  it("renders model settings section and pre-fills dropdown from runtimeConfig", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        modelProvider: "openai",
        modelId: "gpt-4o",
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
      expect(screen.getByText("Model")).toBeInTheDocument();
    });

    const modelSelect = await screen.findByLabelText("Agent Model") as HTMLSelectElement;
    expect(modelSelect.value).toBe("openai/gpt-4o");
  });

  it("passes favorited providers and models to model dropdown", async () => {
    mockFetchModels.mockResolvedValueOnce({
      models: [
        { provider: "openai", id: "gpt-4o", name: "gpt-4o", reasoning: false, contextWindow: 128000 },
      ],
      favoriteProviders: ["openai"],
      favoriteModels: ["openai/gpt-4o"],
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

    const dropdown = await screen.findByTestId("custom-model-dropdown");
    expect(dropdown).toHaveAttribute("data-favorite-providers", "openai");
    expect(dropdown).toHaveAttribute("data-favorite-models", "openai/gpt-4o");
  });

  it("toggles provider and model favorites through shared favorites flow", async () => {
    mockFetchModels.mockResolvedValue({
      models: [
        { provider: "openai", id: "gpt-4o", name: "gpt-4o", reasoning: false, contextWindow: 128000 },
      ],
      favoriteProviders: ["openai"],
      favoriteModels: ["openai/gpt-4o"],
    });

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await navigateToSettings(user);

    await user.click(await screen.findByTestId("toggle-provider-favorite-openai"));
    await waitFor(() => {
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          favoriteProviders: [],
          favoriteModels: ["openai/gpt-4o"],
        }),
      );
    });

    await user.click(await screen.findByTestId("toggle-model-favorite-openai/gpt-4o"));
    await waitFor(() => {
      expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          favoriteProviders: expect.any(Array),
          favoriteModels: [],
        }),
      );
    });
  });

  it("shows runtime mode selected when agent runtimeConfig has runtimeHint", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        runtimeHint: "openclaw",
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

    const runtimeTab = screen.getByRole("tab", { name: "Plugin Runtime" });
    expect(runtimeTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByLabelText("Agent Model")).toBeNull();
    expect((screen.getByLabelText("Runtime") as HTMLSelectElement).value).toBe("openclaw");
  });

  it("saves selected model override as modelProvider/modelId/model in runtimeConfig", async () => {
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

    const modelSelect = await screen.findByLabelText("Agent Model");
    await user.selectOptions(modelSelect, "anthropic/claude-3-7-sonnet");

    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({
            modelProvider: "anthropic",
            modelId: "claude-3-7-sonnet",
            model: "anthropic/claude-3-7-sonnet",
          }),
        }),
        undefined,
      );
    });
  });

  it("saves selected plugin runtime as runtimeHint", async () => {
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
    await user.click(screen.getByText("Plugin Runtime"));
    await user.selectOptions(screen.getByLabelText("Runtime"), "hermes");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({
            runtimeHint: "hermes",
          }),
        }),
        undefined,
      );
    });

    const payload = mockUpdateAgent.mock.calls[0][1] as { runtimeConfig: Record<string, unknown> };
    expect(payload.runtimeConfig.modelProvider).toBeUndefined();
    expect(payload.runtimeConfig.modelId).toBeUndefined();
    expect(payload.runtimeConfig.model).toBeUndefined();
  });

  it("clears model override from runtimeConfig when selecting global default", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        modelProvider: "openai",
        modelId: "gpt-4o",
        model: "openai/gpt-4o",
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

    const modelSelect = await screen.findByLabelText("Agent Model");
    await user.selectOptions(modelSelect, "");

    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.not.objectContaining({
            modelProvider: expect.anything(),
            modelId: expect.anything(),
            model: expect.anything(),
          }),
        }),
        undefined,
      );
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
      const heartbeatInput = screen.getByLabelText("Heartbeat Interval (s)") as HTMLInputElement;
      expect(heartbeatInput.value).toBe("");
    });
  });

  it("shows shared system default hint for heartbeat interval", async () => {
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

    const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (s)");
    expect(heartbeatInput).toHaveAttribute("placeholder", String(DEFAULT_HEARTBEAT_INTERVAL_MS / 1000));
    expect(
      screen.getByText(`How often heartbeats are checked. Leave empty for system default (${DEFAULT_HEARTBEAT_INTERVAL_MS / 1000}s / 1h).`),
    ).toBeInTheDocument();
  });

  it("pre-fills heartbeat fields from agent runtimeConfig", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        enabled: false,
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
      const heartbeatEnabledInput = screen.getByLabelText("Heartbeat Enabled") as HTMLInputElement;
      expect(heartbeatEnabledInput.checked).toBe(false);

      const heartbeatInput = screen.getByLabelText("Heartbeat Interval (s)") as HTMLInputElement;
      expect(heartbeatInput.value).toBe("15");

      const heartbeatTimeoutInput = screen.getByLabelText("Heartbeat Timeout (s)") as HTMLInputElement;
      expect(heartbeatTimeoutInput.value).toBe("120");

      const retriesInput = screen.getByLabelText("Max Retries") as HTMLInputElement;
      expect(retriesInput.value).toBe("5");

      const logLevelSelect = screen.getByLabelText("Log Level") as HTMLSelectElement;
      expect(logLevelSelect.value).toBe("debug");
    });
  });

  it("defaults heartbeat toggle to enabled when runtimeConfig.enabled is missing", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
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
      expect((screen.getByLabelText("Heartbeat Enabled") as HTMLInputElement).checked).toBe(true);
    });
  });

  it("defaults auto-claim toggle to enabled when runtimeConfig.autoClaimRelevantTasks is missing", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
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
      expect((screen.getByLabelText("Auto-Claim Relevant Tasks") as HTMLInputElement).checked).toBe(true);
    });
  });

  it.each([
    ["undefined", undefined, false],
    ["false", false, false],
    ["true", true, true],
  ] as const)("renders engineer backlog auto-claim unchecked by default and reflects %s runtimeConfig", async (_label, engineerBacklogAutoClaim, expectedChecked) => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      role: "engineer",
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
        ...(engineerBacklogAutoClaim === undefined ? {} : { engineerBacklogAutoClaim }),
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
      expect((screen.getByLabelText("Engineer Backlog Auto-Claim") as HTMLInputElement).checked).toBe(expectedChecked);
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

  it("keeps Save Settings disabled when heartbeat runtimeConfig values are pre-filled and unchanged", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      metadata: {},
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
        heartbeatTimeoutMs: 60000,
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
      expect((screen.getByLabelText("Heartbeat Interval (s)") as HTMLInputElement).value).toBe("30");
      expect((screen.getByLabelText("Heartbeat Timeout (s)") as HTMLInputElement).value).toBe("60");
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

    const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (s)");

    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "15");

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
    const heartbeatInput = (await screen.findByLabelText("Heartbeat Interval (s)")) as HTMLInputElement;
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

    const heartbeatTimeoutInput = await screen.findByLabelText("Heartbeat Timeout (s)");

    await user.clear(heartbeatTimeoutInput);
    await user.type(heartbeatTimeoutInput, "4");

    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(screen.getByText(/must be at least 5/)).toBeInTheDocument();
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

    const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (s)");

    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "15");

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

  it("persists heartbeat enabled toggle changes on save", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        enabled: true,
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

    const heartbeatEnabledInput = await screen.findByLabelText("Heartbeat Enabled");
    await user.click(heartbeatEnabledInput);
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({ enabled: false, heartbeatIntervalMs: 30000 }),
        }),
        undefined,
      );
    });
  });

  it("defaults run-missed-heartbeat-on-startup toggle to disabled when runtimeConfig flag is missing", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
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
      expect((screen.getByLabelText("Run Missed Heartbeat On Startup") as HTMLInputElement).checked).toBe(false);
    });
  });

  it("persists run-missed-heartbeat-on-startup toggle changes on save", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        enabled: true,
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

    const toggle = await screen.findByLabelText("Run Missed Heartbeat On Startup");
    await user.click(toggle);
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({ runMissedHeartbeatOnStartup: true }),
        }),
        undefined,
      );
    });
  });

  it("persists auto-claim toggle changes on save", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        enabled: true,
        autoClaimRelevantTasks: true,
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

    const autoClaimInput = await screen.findByLabelText("Auto-Claim Relevant Tasks");
    await user.click(autoClaimInput);
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({ autoClaimRelevantTasks: false }),
        }),
        undefined,
      );
    });
  });

  it("persists engineer backlog auto-claim enabled override on save", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      role: "engineer",
      runtimeConfig: {
        enabled: true,
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

    const toggle = await screen.findByLabelText("Engineer Backlog Auto-Claim");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await user.click(toggle);
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({ engineerBacklogAutoClaim: true }),
        }),
        undefined,
      );
    });
  });

  it("persists engineer backlog auto-claim disabled override on save", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      role: "engineer",
      runtimeConfig: {
        enabled: true,
        engineerBacklogAutoClaim: true,
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

    const toggle = await screen.findByLabelText("Engineer Backlog Auto-Claim");
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await user.click(toggle);
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({ engineerBacklogAutoClaim: false }),
        }),
        undefined,
      );
    });
  });

  it("applies coordination-only preset and persists disabled auto-claim", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        enabled: true,
        autoClaimRelevantTasks: true,
        autoClaimCandidatesInPrompt: 5,
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
    await user.click(await screen.findByRole("button", { name: "Apply preset" }));

    expect((screen.getByLabelText("Auto-Claim Relevant Tasks") as HTMLInputElement).checked).toBe(false);

    await user.click(screen.getByText("Save Settings"));
    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({
            autoClaimRelevantTasks: false,
            autoClaimCandidatesInPrompt: 0,
          }),
        }),
        undefined,
      );
    });
  });

  it("defaults allow-parallel-execution toggle to checked when runtimeConfig.allowParallelExecution is undefined", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
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
      expect((screen.getByLabelText("Allow Parallel Execution") as HTMLInputElement).checked).toBe(true);
    });
  });

  it("defaults allow-parallel-execution toggle to unchecked when runtimeConfig.allowParallelExecution === false", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
        allowParallelExecution: false,
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
      expect((screen.getByLabelText("Allow Parallel Execution") as HTMLInputElement).checked).toBe(false);
    });
  });

  it("defaults allow-parallel-execution toggle to checked when runtimeConfig.allowParallelExecution === true", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
        allowParallelExecution: true,
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
      expect((screen.getByLabelText("Allow Parallel Execution") as HTMLInputElement).checked).toBe(true);
    });
  });

  it("persists allow-parallel-execution toggle changes on save", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        enabled: true,
        allowParallelExecution: true,
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

    const toggle = await screen.findByLabelText("Allow Parallel Execution");
    await user.click(toggle);
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({ allowParallelExecution: false }),
        }),
        undefined,
      );
    });
  });

  it("defaults skip-heartbeat-when-idle toggle to unchecked when runtimeConfig.skipHeartbeatWhenIdle is undefined", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
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
      expect((screen.getByLabelText(/skip heartbeat when idle/i) as HTMLInputElement).checked).toBe(false);
    });
  });

  it("defaults skip-heartbeat-when-idle toggle to unchecked when runtimeConfig.skipHeartbeatWhenIdle === false", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
        skipHeartbeatWhenIdle: false,
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
      expect((screen.getByLabelText(/skip heartbeat when idle/i) as HTMLInputElement).checked).toBe(false);
    });
  });

  it("defaults skip-heartbeat-when-idle toggle to checked when runtimeConfig.skipHeartbeatWhenIdle === true", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        heartbeatIntervalMs: 30000,
        skipHeartbeatWhenIdle: true,
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
      expect((screen.getByLabelText(/skip heartbeat when idle/i) as HTMLInputElement).checked).toBe(true);
    });
  });

  it("persists skip-heartbeat-when-idle toggle changes on save", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      runtimeConfig: {
        enabled: true,
        skipHeartbeatWhenIdle: false,
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

    const toggle = await screen.findByLabelText(/skip heartbeat when idle/i);
    await user.click(toggle);
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          runtimeConfig: expect.objectContaining({ skipHeartbeatWhenIdle: true }),
        }),
        undefined,
      );
    });
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

    const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (s)");

    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "20");

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
    const initialFetchCount = mockFetchAgent.mock.calls.length;

    const retriesInput = await screen.findByLabelText("Max Retries");
    await user.clear(retriesInput);
    await user.type(retriesInput, "7");

    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockFetchAgent.mock.calls.length).toBeGreaterThan(initialFetchCount);
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
    const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (s)");

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

    const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (s)");
    expect((heartbeatInput as HTMLInputElement).value).toBe("30");

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
      runtimeConfig: { enabled: true, heartbeatIntervalMs: 30000, otherConfig: "also-preserved" },
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

    const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (s)");

    await user.clear(heartbeatInput);
    await user.type(heartbeatInput, "45");

    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      const call = mockUpdateAgent.mock.calls[0];
      const payload = (call as any)[1];
      expect(payload.metadata.customKey).toBe("preserved");
      expect(payload.runtimeConfig.enabled).toBe(true);
      expect(payload.runtimeConfig.heartbeatIntervalMs).toBe(45000);
      expect(payload.runtimeConfig.otherConfig).toBe("also-preserved");
    });
  });
});

// ── Budget Settings ──────────────────────────────────────────────────────


});
