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

describe("AgentDetailView — core", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
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

it("renders pending approval badge when agent has pending approvals", async () => {
  mockFetchAgent.mockResolvedValueOnce(createMockAgent({ pendingApprovalCount: 3 }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await waitFor(() => {
    expect(screen.getByText("3 pending approvals")).toBeInTheDocument();
  });
});

it("renders inline mode as a region without overlay or close button", async () => {
  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
      inline
    />,
  );

  await waitFor(() => {
    expect(screen.getByRole("region", { name: "Agent detail" })).toBeInTheDocument();
  });

  expect(document.querySelector(".agent-detail-overlay")).toBeNull();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Back to agents" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Test Agent" })).toBeInTheDocument();
});

it("renders inline mobile back affordance inside detail header when enabled", async () => {
  const onClose = vi.fn();
  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={onClose}
      addToast={vi.fn()}
      inline
      showInlineBackButton
    />,
  );

  await waitFor(() => {
    expect(screen.getByLabelText("Back to agents")).toBeInTheDocument();
  });

  await userEvent.click(screen.getByLabelText("Back to agents"));
  expect(onClose).toHaveBeenCalledTimes(1);

  const header = document.querySelector(".agent-detail-header");
  const identityContainer = header?.querySelector(".agent-detail-identity");
  const actionsContainer = header?.querySelector(".agent-detail-header-actions");
  expect(identityContainer?.querySelector(".agent-detail-inline-back")).toBeTruthy();
  expect(actionsContainer?.querySelector('[aria-label="Refresh"]')).toBeTruthy();
  expect(actionsContainer?.querySelector(".agent-detail-mobile-icon-control")).toBeTruthy();
});

it("keeps modal mode as dialog with close button", async () => {
  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  expect(document.querySelector(".agent-detail-overlay")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
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
  const stylesContent = loadAllAppCss();
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
  const stylesContent = loadAllAppCss();
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
  const stylesContent = loadAllAppCss();
  // The component classes now use --surface, --todo, --text, --card-hover directly
  expect(stylesContent).toMatch(/--surface:/);
  expect(stylesContent).toMatch(/--todo:/);
  expect(stylesContent).toMatch(/--text:/);
  expect(stylesContent).toMatch(/--card-hover:/);
});

it("displays linked task column context in header and current work", async () => {
  mockFetchAgent.mockResolvedValueOnce(createMockAgent({ taskId: "FN-TRIAGE", taskColumn: "triage" }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await waitFor(() => {
    expect(screen.getAllByText((_, el) => el?.textContent === "FN-TRIAGE · Planning").length).toBeGreaterThanOrEqual(2);
  });
});

it("displays in-progress linked task column context", async () => {
  mockFetchAgent.mockResolvedValueOnce(createMockAgent({ taskId: "FN-PROGRESS", taskColumn: "in-progress" }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await waitFor(() => {
    expect(screen.getAllByText((_, el) => el?.textContent === "FN-PROGRESS · In Progress").length).toBeGreaterThanOrEqual(2);
  });
});

it("displays unresolved linked task context when column enrichment is missing", async () => {
  mockFetchAgent.mockResolvedValueOnce(createMockAgent({ taskId: "FN-BARE", taskColumn: undefined }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await waitFor(() => {
    expect(screen.getAllByText((_, el) => el?.textContent === "FN-BARE · Unresolved task").length).toBeGreaterThanOrEqual(2);
  });
});

it("does not render task badge shells without a linked task", async () => {
  mockFetchAgent.mockResolvedValueOnce(createMockAgent({ taskId: undefined, taskColumn: undefined }));

  const { container } = render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await waitFor(() => {
    expect(screen.getByText("No active assignment")).toBeInTheDocument();
  });
  expect(container.querySelector(".task-badge")).toBeNull();
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
    expect(screen.getByText("Role: executor")).toBeInTheDocument();
  });
});

it("renders assigned skills as readable badges with full id tooltip", async () => {
  mockFetchAgent.mockResolvedValue(createMockAgent({
    metadata: {
      skills: [
        "/Users/test/.agents/skills/fusion/SKILL.md",
        "simple-skill",
      ],
    },
  }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("fusion")).toBeInTheDocument();
    expect(screen.getByText("simple-skill")).toBeInTheDocument();
  });

  const fusionBadge = screen.getByText("fusion").closest(".dashboard-summary-skill-badge");
  expect(fusionBadge).toHaveAttribute("title", "/Users/test/.agents/skills/fusion/SKILL.md");
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
    expect(screen.getByText("Mail")).toBeInTheDocument();
    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Employees")).toBeInTheDocument();
    expect(screen.getByText("Soul")).toBeInTheDocument();
    expect(screen.getByText("Instructions")).toBeInTheDocument();
    expect(screen.getByText("Agent Memory")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });
});

it("loads mailbox only when Mail tab is opened", async () => {
  const user = userEvent.setup();
  mockFetchAgentMailbox.mockResolvedValue({
    ownerId: "agent-001",
    ownerType: "agent",
    unreadCount: 1,
    messages: [],
    inbox: [
      {
        id: "msg-1",
        fromId: "dashboard",
        fromType: "user",
        toId: "agent-001",
        toType: "agent",
        content: "Inbox message",
        type: "user-to-agent",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        read: false,
      },
    ],
    outbox: [],
  } as any);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  expect(mockFetchAgentMailbox).not.toHaveBeenCalled();

  await user.click(screen.getByText("Mail"));

  await waitFor(() => {
    expect(mockFetchAgentMailbox).toHaveBeenCalledWith("agent-001", undefined);
    expect(screen.getByText("Inbox message")).toBeInTheDocument();
  });
});

it("switches Mail tab between inbox and outbox", async () => {
  const user = userEvent.setup();
  mockFetchAgentMailbox.mockResolvedValue({
    ownerId: "agent-001",
    ownerType: "agent",
    unreadCount: 0,
    messages: [],
    inbox: [],
    outbox: [
      {
        id: "msg-2",
        fromId: "agent-001",
        fromType: "agent",
        toId: "dashboard",
        toType: "user",
        content: "Sent message",
        type: "agent-to-user",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        read: true,
      },
    ],
  } as any);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await user.click(await screen.findByText("Mail"));

  await waitFor(() => {
    expect(screen.getByTestId("agent-detail-mail-empty")).toBeInTheDocument();
  });

  await user.click(screen.getByRole("button", { name: "Outbox" }));

  await waitFor(() => {
    expect(screen.getByText("Sent message")).toBeInTheDocument();
  });
});

it("opens message detail and supports going back to list", async () => {
  const user = userEvent.setup();
  mockFetchAgentMailbox.mockResolvedValue({
    ownerId: "agent-001",
    ownerType: "agent",
    unreadCount: 1,
    messages: [],
    inbox: [
      {
        id: "msg-1",
        fromId: "dashboard",
        fromType: "user",
        toId: "agent-001",
        toType: "agent",
        content: "First line\nSecond line with full body",
        type: "user-to-agent",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        metadata: { replyTo: { messageId: "msg-0" } },
        read: true,
      },
    ],
    outbox: [],
  } as any);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await user.click(await screen.findByText("Mail"));
  await user.click(await screen.findByRole("button", { name: /You/i }));

  expect(await screen.findByTestId("agent-detail-mail-message")).toBeInTheDocument();
  expect(screen.getByText(/First line\s*Second line with full body/)).toBeInTheDocument();
  expect(screen.getByText(/Replying to message msg-0/)).toBeInTheDocument();

  await user.click(screen.getByTestId("agent-detail-mail-back"));
  expect(await screen.findByTestId("agent-detail-mail-list")).toBeInTheDocument();
});

it("renders agent mailbox participant labels with known agent names", async () => {
  const user = userEvent.setup();
  mockFetchAgentMailbox.mockResolvedValue({
    ownerId: "agent-001",
    ownerType: "agent",
    unreadCount: 1,
    messages: [],
    inbox: [
      {
        id: "msg-1",
        fromId: "agent-001",
        fromType: "agent",
        toId: "dashboard",
        toType: "user",
        content: "Self message",
        type: "agent-to-user",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        read: true,
      },
    ],
    outbox: [
      {
        id: "msg-2",
        fromId: "agent-001",
        fromType: "agent",
        toId: "agent-002",
        toType: "agent",
        content: "Known recipient",
        type: "agent-to-agent",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        read: true,
      },
    ],
  } as any);

  render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

  await user.click(await screen.findByText("Mail"));
  expect(await screen.findByText("Agent: Test Agent")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Outbox" }));
  expect(await screen.findByText("To: Agent: Manager Agent")).toBeInTheDocument();
});

it("marks unread inbox messages as read and refreshes mailbox", async () => {
  const user = userEvent.setup();
  mockFetchAgentMailbox.mockResolvedValue({
    ownerId: "agent-001",
    ownerType: "agent",
    unreadCount: 1,
    messages: [],
    inbox: [
      {
        id: "msg-1",
        fromId: "dashboard",
        fromType: "user",
        toId: "agent-001",
        toType: "agent",
        content: "Unread message",
        type: "user-to-agent",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        read: false,
      },
    ],
    outbox: [],
  } as any);

  render(
    <AgentDetailView
      agentId="agent-001"
      projectId="proj-1"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await user.click(await screen.findByText("Mail"));
  await user.click(await screen.findByRole("button", { name: /You/i }));

  await waitFor(() => {
    expect(mockMarkMessageRead).toHaveBeenCalledWith("msg-1", "proj-1");
    expect(mockFetchAgentMailbox).toHaveBeenCalledTimes(2);
  });
});

it("does not mark already read inbox messages", async () => {
  const user = userEvent.setup();
  mockFetchAgentMailbox.mockResolvedValue({
    ownerId: "agent-001",
    ownerType: "agent",
    unreadCount: 0,
    messages: [],
    inbox: [
      {
        id: "msg-1",
        fromId: "dashboard",
        fromType: "user",
        toId: "agent-001",
        toType: "agent",
        content: "Read message",
        type: "user-to-agent",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        read: true,
      },
    ],
    outbox: [],
  } as any);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await user.click(await screen.findByText("Mail"));
  await user.click(await screen.findByRole("button", { name: /You/i }));

  expect(mockMarkMessageRead).not.toHaveBeenCalled();
});

it("renders redesigned dashboard summary sections", async () => {
  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Heartbeat & Health")).toBeInTheDocument();
    expect(screen.getByText("Current Work")).toBeInTheDocument();
    expect(screen.getByText("Recent Runs")).toBeInTheDocument();
    expect(screen.getByText("Throughput")).toBeInTheDocument();
    expect(screen.getByText("Chain of Command")).toBeInTheDocument();
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

it("optimistically updates the detail header state before API resolves", async () => {
  let resolveTransition!: () => void;
  const transitionPromise = new Promise<AgentDetail>((resolve) => {
    resolveTransition = () => resolve(createMockAgent({ state: "paused" }));
  });
  mockUpdateAgentState.mockImplementationOnce(() => transitionPromise);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  const pauseButton = await screen.findByText("Pause");
  await userEvent.click(pauseButton);

  await waitFor(() => {
    expect(screen.getAllByText("paused").length).toBeGreaterThan(0);
    expect(screen.getByText("Resume")).toBeInTheDocument();
  });

  resolveTransition?.();
  await waitFor(() => {
    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "paused", undefined);
  });
});

it("rolls back optimistic detail state when API call fails", async () => {
  let rejectTransition!: (error: Error) => void;
  const transitionPromise = new Promise<AgentDetail>((_, reject) => {
    rejectTransition = reject;
  });
  mockUpdateAgentState.mockImplementationOnce(() => transitionPromise);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await userEvent.click(await screen.findByText("Pause"));

  await waitFor(() => {
    expect(screen.getByText("Resume")).toBeInTheDocument();
  });

  rejectTransition?.(new Error("State change failed"));

  await waitFor(() => {
    expect(screen.getByText("Pause")).toBeInTheDocument();
    expect(screen.getAllByText("active").length).toBeGreaterThan(0);
  });
});

it("disables lifecycle transition buttons while state transition is in-flight", async () => {
  let resolveTransition!: () => void;
  const transitionPromise = new Promise<AgentDetail>((resolve) => {
    resolveTransition = () => resolve(createMockAgent({ state: "paused" }));
  });
  mockUpdateAgentState.mockImplementationOnce(() => transitionPromise);

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await userEvent.click(await screen.findByText("Pause"));

  await waitFor(() => {
    const resumeButton = screen.getByText("Resume").closest("button") as HTMLButtonElement | null;
    expect(resumeButton).toBeTruthy();
    expect(resumeButton?.disabled).toBe(true);
  });

  resolveTransition?.();
  await waitFor(() => {
    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "paused", undefined);
  });
});

it("notifies parent mutation callback after successful state change", async () => {
  const onMutationSuccess = vi.fn();

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
      onMutationSuccess={onMutationSuccess}
    />
  );

  await userEvent.click(await screen.findByText("Pause"));

  await waitFor(() => {
    expect(onMutationSuccess).toHaveBeenCalledWith({ agentId: "agent-001", deleted: false });
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

it("shows Delete button for paused agent", async () => {
  mockFetchAgent.mockResolvedValue(createMockAgent({ state: "paused" }));

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

it("keeps active header Stop and Run Now buttons accessible by name while using mobile icon-control class", async () => {
  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />,
  );

  const stopButton = await screen.findByRole("button", { name: "Stop" });
  const runNowButton = await screen.findByRole("button", { name: "Run now for Test Agent" });

  expect(stopButton.className).toContain("agent-detail-mobile-icon-control");
  expect(runNowButton.className).toContain("agent-detail-mobile-icon-control");
});

it("transitions running agent to paused when Stop is clicked", async () => {
  mockFetchAgent.mockResolvedValue(createMockAgent({ state: "running" }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await userEvent.click(await screen.findByText("Stop"));

  await waitFor(() => {
    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "paused", undefined);
  });
});

it("shows Retry, Stop, and Delete buttons for error agent", async () => {
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
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  const deleteButton = screen.getByRole("button", { name: "Delete" });
  expect(deleteButton.className).toContain("agent-detail-mobile-icon-control");
});

it("transitions error agent to paused when Stop is clicked", async () => {
  mockFetchAgent.mockResolvedValue(createMockAgent({ state: "error" }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await userEvent.click(await screen.findByText("Stop"));

  await waitFor(() => {
    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "paused", undefined);
  });
});

it("deletes error agent when Delete is clicked", async () => {
  mockFetchAgent.mockResolvedValue(createMockAgent({ state: "error" }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await userEvent.click(await screen.findByText("Delete"));

  await waitFor(() => {
    expect(mockDeleteAgent).toHaveBeenCalledWith("agent-001", undefined);
  });
});

it("groups lifecycle and utility controls under a shared header action cluster", async () => {
  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await waitFor(() => {
    const headerActions = document.querySelector(".agent-detail-header-actions");
    expect(headerActions).toBeTruthy();

    const controlsContainer = headerActions?.querySelector(".agent-detail-controls");
    expect(controlsContainer).toBeTruthy();
    expect(controlsContainer?.querySelector(".btn--compact")).toBeTruthy();

    const utilityContainer = headerActions?.querySelector(".agent-detail-utility-actions");
    expect(utilityContainer).toBeTruthy();
    expect(utilityContainer?.querySelector('[title="Bulk agent actions"]')).toBeTruthy();
    expect(utilityContainer?.querySelector('[title="Refresh"]')).toBeTruthy();
    expect(utilityContainer?.querySelector('[title="Close"]')).toBeTruthy();
  });
});

it("renders bulk lifecycle menu with state-aware eligibility hints", async () => {
  const user = userEvent.setup();
  mockFetchAgents.mockResolvedValueOnce([
    { id: "agent-001", name: "Alpha", state: "active", role: "executor", metadata: {} },
    { id: "agent-002", name: "Bravo", state: "running", role: "executor", metadata: {} },
    { id: "agent-003", name: "Charlie", state: "paused", role: "executor", metadata: {} },
  ] as any);

  render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

  await user.click(await screen.findByRole("button", { name: "Bulk agent actions" }));

  await waitFor(() => {
    expect(screen.getByText("Pause All Agents")).toBeInTheDocument();
    expect(screen.getByText("Resume All Agents")).toBeInTheDocument();
    expect(screen.getByText("Pause 2 active/running agents")).toBeInTheDocument();
    expect(screen.getByText("Resume 1 paused agent")).toBeInTheDocument();
  });
});

it("bulk pause confirms, skips ineligible/system agents, and refreshes detail", async () => {
  const user = userEvent.setup();
  const addToast = vi.fn();
  mockFetchAgents.mockResolvedValue([
    { id: "agent-001", name: "Alpha", state: "active", role: "executor", metadata: {} },
    { id: "agent-002", name: "Bravo", state: "running", role: "executor", metadata: {} },
    { id: "agent-003", name: "Charlie", state: "paused", role: "executor", metadata: {} },
    { id: "agent-004", name: "System", state: "active", role: "executor", metadata: { type: "spawned" } },
  ] as any);

  render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={addToast} />);

  await user.click(await screen.findByRole("button", { name: "Bulk agent actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /Pause All Agents/i }));

  await waitFor(() => {
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "paused", undefined);
    expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-002", "paused", undefined);
    expect(mockUpdateAgentState).not.toHaveBeenCalledWith("agent-003", "paused", undefined);
    expect(mockUpdateAgentState).not.toHaveBeenCalledWith("agent-004", "paused", undefined);
    expect(addToast).toHaveBeenCalledWith("Paused 2 agents; skipped 1", "success");
  });

  await waitFor(() => {
    expect(mockFetchAgent).toHaveBeenCalledTimes(2);
  });
});

it("reports partial failures during bulk resume", async () => {
  const user = userEvent.setup();
  const addToast = vi.fn();
  mockFetchAgents.mockResolvedValue([
    { id: "agent-001", name: "Alpha", state: "paused", role: "executor", metadata: {} },
    { id: "agent-002", name: "Bravo", state: "paused", role: "executor", metadata: {} },
    { id: "agent-003", name: "Charlie", state: "idle", role: "executor", metadata: {} },
  ] as any);
  mockUpdateAgentState
    .mockResolvedValueOnce(createMockAgent({ state: "active" }))
    .mockRejectedValueOnce(new Error("network"));

  render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={addToast} />);

  await user.click(await screen.findByRole("button", { name: "Bulk agent actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /Resume All Agents/i }));

  await waitFor(() => {
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Resumed 1 agent; skipped 1; failed 1"), "error");
  });
});

it("keeps mobile inline header controls on the same row as identity", () => {
  const stylesContent = loadAllAppCss();

  expect(stylesContent).toContain(".agent-detail-header-actions {");
  expect(stylesContent).toContain("justify-content: flex-end;");
  expect(stylesContent).toContain(".agent-detail-inline-back {");

  expect(stylesContent).toContain("@media (max-width: 768px)");
  expect(stylesContent).toContain(".agent-detail-header {");
  expect(stylesContent).toContain("grid-template-columns: minmax(0, 1fr) auto;");
  expect(stylesContent).toContain("column-gap: var(--space-sm);");
  expect(stylesContent).toContain("row-gap: var(--space-sm);");
  expect(stylesContent).toContain("padding: var(--space-md);");
  expect(stylesContent).toContain(".agent-detail-identity {");
  expect(stylesContent).toContain("grid-column: 1;");
  expect(stylesContent).toContain("gap: var(--space-md);");
  expect(stylesContent).toContain(".agent-detail-header-actions {");
  expect(stylesContent).toContain("grid-column: 2;");
  expect(stylesContent).toContain(".agent-detail-controls .agent-detail-mobile-icon-control {");
  expect(stylesContent).toContain(".agent-detail-mobile-icon-control .agent-detail-control-label {");
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

it("shows model override in Agent Information when runtimeConfig modelProvider/modelId is set", async () => {
  mockFetchAgent.mockResolvedValue(createMockAgent({
    runtimeConfig: {
      modelProvider: "openai",
      modelId: "gpt-4o",
    },
  }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await waitFor(() => {
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
  });
});

it("shows legacy model override using model id when runtimeConfig.model is set", async () => {
  mockFetchAgent.mockResolvedValue(createMockAgent({
    runtimeConfig: {
      model: "anthropic/claude-3-7-sonnet",
    },
  }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await waitFor(() => {
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("claude-3-7-sonnet")).toBeInTheDocument();
  });
});

it("shows runtime name in Agent Information when runtimeHint is set", async () => {
  mockFetchAgent.mockResolvedValue(createMockAgent({
    runtimeConfig: {
      runtimeHint: "openclaw",
    },
  }));

  render(
    <AgentDetailView
      agentId="agent-001"
      onClose={vi.fn()}
      addToast={vi.fn()}
    />
  );

  await waitFor(() => {
    expect(screen.getByText("Runtime")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw")).toBeInTheDocument();
  });
});


});
