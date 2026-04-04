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
}));

import { fetchAgent, updateAgent, updateAgentState } from "../../api";

const mockFetchAgent = vi.mocked(fetchAgent);
const mockUpdateAgent = vi.mocked(updateAgent);
const mockUpdateAgentState = vi.mocked(updateAgentState);

describe("AgentDetailView", () => {
  const createMockAgent = (overrides: Partial<{
    id: string;
    name: string;
    role: AgentCapability;
    state: "idle" | "active" | "paused" | "terminated";
    taskId?: string;
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
    mockFetchAgent.mockResolvedValue(createMockAgent());
    mockUpdateAgentState.mockResolvedValue(createMockAgent({ state: "paused" }));
    mockUpdateAgent.mockResolvedValue(createMockAgent() as any);
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
      expect(screen.getByText("Settings")).toBeInTheDocument();
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
      expect(screen.getByText("Delete")).toBeInTheDocument();
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
        expect(screen.getByLabelText("Heartbeat Interval (ms)")).toBeInTheDocument();
        expect(screen.getByLabelText("Max Retries")).toBeInTheDocument();
        expect(screen.getByLabelText("Task Timeout (ms)")).toBeInTheDocument();
        expect(screen.getByLabelText("Log Level")).toBeInTheDocument();
      });
    });

    it("shows empty fields when metadata has no advanced settings", async () => {
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

    it("pre-fills fields from agent metadata", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        metadata: {
          heartbeatIntervalMs: 15000,
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

      const heartbeatInput = await screen.findByLabelText("Heartbeat Interval (ms)");

      await user.clear(heartbeatInput);
      await user.type(heartbeatInput, "500");

      await user.click(screen.getByText("Save Settings"));

      await waitFor(() => {
        expect(screen.getByText(/must be at least 1,000/)).toBeInTheDocument();
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

    it("calls updateAgent with correct metadata on save", async () => {
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
          { metadata: expect.objectContaining({ heartbeatIntervalMs: 15000 }) },
          undefined,
        );
      });

      expect(addToast).toHaveBeenCalledWith("Advanced settings saved", "success");
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

    it("clears metadata key when field is cleared to empty", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        metadata: { heartbeatIntervalMs: 30000 },
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
            metadata: expect.not.objectContaining({ heartbeatIntervalMs: expect.anything() }),
          }),
          undefined,
        );
      });
    });

    it("persists existing non-advanced metadata keys during save", async () => {
      mockFetchAgent.mockResolvedValue(createMockAgent({
        metadata: { customKey: "preserved", heartbeatIntervalMs: 30000 },
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
        const metadata = (call as any)[1].metadata;
        expect(metadata.customKey).toBe("preserved");
        expect(metadata.heartbeatIntervalMs).toBe(45000);
      });
    });
  });
});
