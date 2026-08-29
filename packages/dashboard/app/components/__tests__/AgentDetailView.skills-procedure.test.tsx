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

describe("AgentDetailView — skills and procedure", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
  });

describe("Skills", () => {
  it("renders skill badges in Dashboard tab when agent has skills", async () => {
    const agentWithSkills = createMockAgent({
      metadata: { skills: ["skill-1", "skill-2"] },
    });
    mockFetchAgent.mockResolvedValue(agentWithSkills);

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("skill-1")).toBeInTheDocument();
      expect(screen.getByText("skill-2")).toBeInTheDocument();
    });

    const skillBadges = document.querySelectorAll(".dashboard-summary-skill-badge");
    expect(skillBadges).toHaveLength(2);
  });

  it("loads and displays skill details when a dashboard skill badge is clicked", async () => {
    const user = userEvent.setup();
    const agentWithSkills = createMockAgent({
      metadata: { skills: ["skill-1"] },
    });
    mockFetchAgent.mockResolvedValue(agentWithSkills);
    mockFetchSkillContent.mockResolvedValue({
      name: "Fusion Skill",
      skillMd: "# Fusion Skill",
      files: [],
    });

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    const badge = await screen.findByRole("button", { name: "View details for skill-1" });
    await user.click(badge);

    await waitFor(() => {
      expect(mockFetchSkillContent).toHaveBeenCalledWith("skill-1", undefined);
      expect(screen.getByText("# Fusion Skill")).toBeInTheDocument();
    });
  });

  it("marks forced skills pending after a discovery failure rather than undiscovered", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({ metadata: { skills: ["skill-1"] } }));
    mockFetchDiscoveredSkills.mockRejectedValueOnce(new Error("offline"));

    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    const badge = await screen.findByRole("button", { name: "View details for skill-1" });
    await waitFor(() => expect(badge).toHaveAttribute("data-skill-state", "pending"));
    expect(badge).toHaveTextContent("Forced");
    expect(badge).not.toHaveTextContent("Not discovered");
  });

  it("labels an unavailable forced skill and short-circuits its content request", async () => {
    const user = userEvent.setup();
    mockFetchAgent.mockResolvedValue(createMockAgent({ metadata: { skills: ["missing-skill"] } }));

    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    const badge = await screen.findByRole("button", { name: "View details for missing-skill" });
    await waitFor(() => expect(badge).toHaveAttribute("data-skill-state", "unknown"));
    await user.click(badge);

    expect(await screen.findByTestId("agent-skill-detail")).toHaveTextContent("This stored skill is no longer discovered by the project.");
    expect(screen.getByTestId("agent-skill-detail")).toHaveTextContent("Forced");
    expect(mockFetchSkillContent).not.toHaveBeenCalled();
  });

  it("shows error state and supports retry when skill content loading fails", async () => {
    const user = userEvent.setup();
    const agentWithSkills = createMockAgent({
      metadata: { skills: ["skill-1"] },
    });
    mockFetchAgent.mockResolvedValue(agentWithSkills);
    mockFetchSkillContent
      .mockRejectedValueOnce(new Error("Failed to load skill content"))
      .mockResolvedValueOnce({ name: "Recovered", skillMd: "# Recovered", files: [] });

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "View details for skill-1" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to load skill content")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("# Recovered")).toBeInTheDocument();
    });
  });

  it("shows fallback when skill content has no SKILL.md body", async () => {
    const user = userEvent.setup();
    const agentWithSkills = createMockAgent({ metadata: { skills: ["skill-1"] } });
    mockFetchAgent.mockResolvedValue(agentWithSkills);
    mockFetchSkillContent.mockResolvedValue({ name: "Test Skill", skillMd: "", files: [] });

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "View details for skill-1" }));

    await waitFor(() => {
      expect(screen.getByText("(No SKILL.md found)")).toBeInTheDocument();
    });
  });

  it.each([{}, { skills: undefined }, { skills: "not-an-array" }])(
    "shows explicit None rather than an ambiguous dash for empty skills",
    async (metadata) => {
      mockFetchAgent.mockResolvedValue(createMockAgent({ metadata }));

      render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

      const region = await screen.findByTestId("agent-skills-empty");
      expect(region).toHaveTextContent("SkillsNone");
      expect(region).not.toHaveTextContent("—");
    },
  );

  it("shows SkillMultiselect in Config tab", async () => {
    const user = userEvent.setup();
    const agentWithSkills = createMockAgent({
      metadata: { skills: ["skill-1"] },
    });
    mockFetchAgent.mockResolvedValue(agentWithSkills);

    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    // Navigate to Settings tab
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Settings"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-multiselect")).toBeInTheDocument();
    });

    // Should show pre-selected skill
    expect(screen.getByTestId("skill-multiselect-value").textContent).toContain("skill-1");
  });

  it("pre-fills skills from agent metadata in Config tab", async () => {
    const agentWithSkills = createMockAgent({
      metadata: { skills: ["skill-1", "skill-2"] },
    });
    mockFetchAgent.mockResolvedValue(agentWithSkills);

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Settings"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-multiselect")).toBeInTheDocument();
    });

    // Should have both skills pre-selected
    expect(screen.getByTestId("skill-multiselect-value").textContent).toContain("skill-1");
    expect(screen.getByTestId("skill-multiselect-value").textContent).toContain("skill-2");
  });

  it("includes skills in metadata when saving Config tab", async () => {
    const agentWithSkills = createMockAgent({
      metadata: { skills: ["skill-1"] },
    });
    mockFetchAgent.mockResolvedValue(agentWithSkills);
    mockUpdateAgent.mockResolvedValue(createMockAgent({ metadata: { skills: ["skill-1", "new-skill"] } }) as any);

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Settings"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-multiselect")).toBeInTheDocument();
    });

    // Add a skill
    await user.click(screen.getByTestId("add-skill-test"));

    // Save settings
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          metadata: expect.objectContaining({
            skills: ["skill-1", "test-skill"],
          }),
        }),
        undefined,
      );
    });
  });

  it("enables Save Settings when skills change", async () => {
    const agentWithSkills = createMockAgent({
      metadata: { skills: [] },
    });
    mockFetchAgent.mockResolvedValue(agentWithSkills);

    const user = userEvent.setup();
    render(
      <AgentDetailView
        agentId="agent-001"
        onClose={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Settings"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-multiselect")).toBeInTheDocument();
    });

    // Initially no changes
    expect(screen.getByText("Save Settings")).toBeDisabled();

    // Add a skill
    await user.click(screen.getByTestId("add-skill-test"));

    // Save button should now be enabled
    await waitFor(() => {
      expect(screen.getByText("Save Settings")).not.toBeDisabled();
    });
  });
});

describe("Heartbeat procedure file viewer", () => {
  const openSettings = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Settings"));
  };

  it("renders heartbeat markdown view action when heartbeatProcedurePath is set", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      heartbeatProcedurePath: ".fusion/agents/agent-001/HEARTBEAT.md",
    }));

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);

    expect(screen.getByRole("button", { name: "View Heartbeat Markdown" })).toBeInTheDocument();
  });

  it("fetches and displays heartbeat file content from project workspace", async () => {
    mockFetchAgent.mockResolvedValue(createMockAgent({
      heartbeatProcedurePath: ".fusion/agents/agent-001/HEARTBEAT.md",
    }));
    mockFetchWorkspaceFileContent.mockResolvedValue({ content: "# Heartbeat\n\nDo checks", mtime: "2024-01-01T00:00:00.000Z", size: 20 });

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" projectId="proj-1" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "View Heartbeat Markdown" }));

    await waitFor(() => {
      expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("project", ".fusion/agents/agent-001/HEARTBEAT.md", "proj-1");
    });
    expect(screen.getByLabelText("Heartbeat Procedure File")).toHaveValue("# Heartbeat\n\nDo checks");
  });

  it("shows load error feedback when heartbeat file fetch fails", async () => {
    const addToast = vi.fn();
    mockFetchAgent.mockResolvedValue(createMockAgent({
      heartbeatProcedurePath: ".fusion/agents/agent-001/HEARTBEAT.md",
    }));
    mockFetchWorkspaceFileContent.mockRejectedValue(new Error("permission denied"));

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={addToast} />);
    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "View Heartbeat Markdown" }));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Failed to load heartbeat procedure file: permission denied", "error");
    });
    expect(screen.getByText("Failed to load file: permission denied")).toBeInTheDocument();
  });

  it("refreshes to upgraded heartbeat path and supports immediate viewing", async () => {
    mockFetchAgent
      .mockResolvedValueOnce(createMockAgent({ heartbeatProcedurePath: undefined }))
      .mockResolvedValueOnce(createMockAgent({ heartbeatProcedurePath: ".fusion/agents/agent-001/HEARTBEAT.md" }));
    mockFetchWorkspaceFileContent.mockResolvedValue({ content: "# Seeded", mtime: "2024-01-01T00:00:00.000Z", size: 8 });

    const user = userEvent.setup();
    render(<AgentDetailView agentId="agent-001" projectId="proj-2" onClose={vi.fn()} addToast={vi.fn()} />);
    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "Upgrade agent to default heartbeat procedure file" }));

    await waitFor(() => {
      expect(mockUpgradeAgentHeartbeatProcedure).toHaveBeenCalledWith("agent-001", "proj-2");
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "View Heartbeat Markdown" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "View Heartbeat Markdown" }));
    await waitFor(() => {
      expect(mockFetchWorkspaceFileContent).toHaveBeenCalledWith("project", ".fusion/agents/agent-001/HEARTBEAT.md", "proj-2");
    });
  });
});


});
