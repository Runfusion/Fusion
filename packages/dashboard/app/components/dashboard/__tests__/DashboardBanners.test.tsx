import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AiSessionSummary } from "../../../api";
import type { ModalManager } from "../../../hooks/useModalManager";
import type { DashboardBannersProps } from "../types";

vi.mock("../../TestModeBanner", () => ({ TestModeBanner: () => null }));
vi.mock("../../EngineUnavailableBanner", () => ({ EngineUnavailableBanner: () => null }));
vi.mock("../../EngineStatusBanner", () => ({ EngineStatusBanner: () => null }));
vi.mock("../../OAuthReloginBanner", () => ({ OAuthReloginBanner: () => null }));
vi.mock("../../CliBinaryInstallBanner", () => ({ CliBinaryInstallBanner: () => null }));
vi.mock("../../OnboardingResumeCard", () => ({ OnboardingResumeCard: () => null }));
vi.mock("../../PostOnboardingRecommendations", () => ({ PostOnboardingRecommendations: () => null }));
vi.mock("../../UpdateAvailableBanner", () => ({ UpdateAvailableBanner: () => null }));
vi.mock("../../MergeAdvanceNotice", () => ({ default: () => null }));
vi.mock("../../TaskIdIntegrityBanner", () => ({ TaskIdIntegrityBanner: () => null }));
vi.mock("../../DbCorruptionBanner", () => ({ DbCorruptionBanner: () => null }));
vi.mock("../../SetupWarningBanner", () => ({ SetupWarningBanner: () => null }));
vi.mock("../../ApprovalNotificationBanner", () => ({
  ApprovalNotificationBanner: ({ pendingCount, onOpenMailbox }: { pendingCount: number; onOpenMailbox: () => void }) => (
    <section role="region" aria-label="Approval requests">
      <span>{pendingCount} approval {pendingCount === 1 ? "request" : "requests"} need your attention</span>
      <button type="button" onClick={onOpenMailbox}>Open Mailbox</button>
    </section>
  ),
}));
vi.mock("../../GitHubStarPrompt", () => ({ GitHubStarPrompt: () => null }));

import { DashboardBanners } from "../DashboardBanners";

function buildSession(overrides: Partial<AiSessionSummary> = {}): AiSessionSummary {
  return {
    id: overrides.id ?? "session-1",
    type: overrides.type ?? "planning",
    status: overrides.status ?? "awaiting_input",
    title: overrides.title ?? "Draft implementation plan",
    projectId: overrides.projectId ?? "proj-1",
    lockedByTab: overrides.lockedByTab ?? null,
    updatedAt: overrides.updatedAt ?? "2026-06-25T00:00:00.000Z",
    ...overrides,
  };
}

function buildModalManager(overrides: Partial<ModalManager> = {}): ModalManager {
  const noop = vi.fn();
  return {
    newTaskModalOpen: false,
    newTaskInitialDescription: null,
    isPlanningOpen: false,
    planningInitialPlan: null,
    planningResumeSessionId: undefined,
    planningWorkflowId: undefined,
    isSubtaskOpen: false,
    subtaskInitialDescription: null,
    subtaskResumeSessionId: undefined,
    subtaskWorkflowId: undefined,
    detailTask: null,
    detailTaskInitialTab: "chat",
    detailTaskOrigin: null,
    groupModalGroupId: null,
    settingsOpen: false,
    settingsInitialSection: undefined,
    schedulesOpen: false,
    githubImportOpen: false,
    usageOpen: false,
    usageAnchorRect: null,
    terminalOpen: false,
    terminalInitialCommand: undefined,
    terminalInitialCommandGeneration: 0,
    filesOpen: false,
    fileBrowserWorkspace: "project",
    fileBrowserInitialFile: null,
    activityLogOpen: false,
    gitManagerOpen: false,
    workflowEditorOpen: false,
    workflowEditorInitialPanel: undefined,
    workflowEditorInitialAction: undefined,
    workflowEditorInitialWorkflowId: undefined,
    agentsOpen: false,
    scriptsOpen: false,
    setupWizardOpen: false,
    modelOnboardingOpen: false,
    anyModalOpen: false,
    openNewTask: noop,
    openNewTaskWithDescription: noop,
    closeNewTask: noop,
    openPlanning: noop,
    openPlanningWithInitialPlan: noop,
    resumePlanning: noop,
    openPlanningWithSession: noop,
    closePlanning: noop,
    openSubtaskBreakdown: noop,
    openSubtaskWithSession: noop,
    closeSubtask: noop,
    openDetailTask: noop,
    openDetailWithChangesTab: noop,
    updateDetailTask: noop,
    closeDetailTask: noop,
    openGroupModal: noop,
    closeGroupModal: noop,
    openSettings: noop,
    setSettingsSection: noop,
    closeSettings: noop,
    openSchedules: noop,
    closeSchedules: noop,
    openGitHubImport: noop,
    closeGitHubImport: noop,
    openUsage: noop,
    closeUsage: noop,
    toggleTerminal: noop,
    closeTerminal: noop,
    openFiles: noop,
    closeFiles: noop,
    setFileWorkspace: noop,
    openActivityLog: noop,
    closeActivityLog: noop,
    openGitManager: noop,
    closeGitManager: noop,
    openWorkflowEditor: noop,
    closeWorkflowEditor: noop,
    openAgents: noop,
    closeAgents: noop,
    openScripts: noop,
    closeScripts: noop,
    runScript: vi.fn().mockResolvedValue(undefined),
    openSetupWizard: noop,
    closeSetupWizard: noop,
    openModelOnboarding: noop,
    closeModelOnboarding: noop,
    onPlanningTaskCreated: noop,
    onPlanningTasksCreated: noop,
    onSubtaskTasksCreated: noop,
    ...overrides,
  };
}

function buildProps(overrides: Partial<DashboardBannersProps> = {}): DashboardBannersProps {
  return {
    viewMode: "project",
    currentProject: { id: "proj-1", name: "Project", path: "/tmp/project" } as DashboardBannersProps["currentProject"],
    isTestMode: false,
    dashboardHealth: null,
    setDashboardHealth: vi.fn(),
    taskView: "board",
    modalManager: buildModalManager(),
    sessionBannersHidden: false,
    sessionsNeedingInput: [buildSession()],
    handleOpenBackgroundSession: vi.fn(),
    handleDismissNeedingInputSession: vi.fn(),
    handleDismissAllNeedingInputSessions: vi.fn(),
    handleCliAction: vi.fn().mockResolvedValue(undefined),
    getCliActionDisabledReasonForBanner: vi.fn(() => null),
    openSettingsWithNav: vi.fn(),
    showOnboardingResumeCard: false,
    showPostOnboardingRecommendations: false,
    updateAvailable: false,
    latestVersion: null,
    currentVersion: null,
    updateBannerDismissed: false,
    dismissUpdateBanner: vi.fn(),
    refreshDbCorruptionHealth: vi.fn().mockResolvedValue(undefined),
    dbCorruptionRefreshing: false,
    dbCorruptionRefreshError: null,
    setupReadinessLoading: false,
    hasWarnings: false,
    setupWarningDismissed: false,
    handleDismissSetupWarning: vi.fn(),
    hasAiProvider: true,
    hasGithub: true,
    approvalBannerCandidate: null,
    dismissApproval: vi.fn(),
    mailboxPendingApprovalCount: 0,
    handleTaskViewChange: vi.fn(),
    showGitHubStarPrompt: false,
    gitHubStarPromptShown: false,
    markGitHubStarPromptShown: vi.fn(),
    setShowGitHubStarPrompt: vi.fn(),
    ...overrides,
  };
}

function querySessionBanner(): HTMLElement | null {
  return screen.queryByRole("region", { name: /AI sessions needing input or failed/i });
}

describe("DashboardBanners session notification visibility", () => {
  /*
  FNXC:SessionBanner 2026-06-25-00:00:
  FN-7020 visibility surface enumeration: DashboardBanners.tsx is the only app-shell mount point for SessionNotificationBanner (grep-confirmed; other references are tests). The guard must remain viewMode === "project", currentProject present, taskView !== "missions", !modalManager.isPlanningOpen, and !sessionBannersHidden so Missions interviews and the Planning modal own their active AI-session UX while board/list surfaces still show needs-input sessions.
  */
  it("does not render the session notification banner on the missions view", () => {
    render(<DashboardBanners {...buildProps({ taskView: "missions" })} />);

    expect(querySessionBanner()).not.toBeInTheDocument();
    expect(screen.queryByText("Draft implementation plan")).not.toBeInTheDocument();
  });

  it("does not render the session notification banner while planning is open", () => {
    render(<DashboardBanners {...buildProps({ modalManager: buildModalManager({ isPlanningOpen: true }) })} />);

    expect(querySessionBanner()).not.toBeInTheDocument();
    expect(screen.queryByText("Draft implementation plan")).not.toBeInTheDocument();
  });

  it("renders the session notification banner on board views when sessions need input", () => {
    render(
      <DashboardBanners
        {...buildProps({
          taskView: "board",
          sessionsNeedingInput: [
            buildSession({ id: "awaiting", title: "Awaiting input", status: "awaiting_input" }),
            buildSession({ id: "error", title: "Needs attention", status: "needs_attention", type: "cli-agent", cliVariant: "userExited" }),
          ],
        })}
      />,
    );

    expect(querySessionBanner()).toBeInTheDocument();
    expect(screen.getByText("Awaiting input")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("does not render when the appearance setting hides session banners", () => {
    render(<DashboardBanners {...buildProps({ sessionBannersHidden: true })} />);

    expect(querySessionBanner()).not.toBeInTheDocument();
  });

  it("does not render when there are zero sessions needing input", () => {
    render(<DashboardBanners {...buildProps({ sessionsNeedingInput: [] })} />);

    expect(querySessionBanner()).not.toBeInTheDocument();
  });
});

describe("DashboardBanners approval notification visibility", () => {
  it("does not render the mailbox approval banner without a real approval candidate", () => {
    render(<DashboardBanners {...buildProps({ mailboxPendingApprovalCount: 0, approvalBannerCandidate: null })} />);

    expect(screen.queryByRole("region", { name: /approval requests/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/approval request.*need your attention/i)).not.toBeInTheDocument();
  });

  it("does not render the mailbox approval banner for a task plan-approval candidate", () => {
    render(
      <DashboardBanners
        {...buildProps({
          mailboxPendingApprovalCount: 0,
          approvalBannerCandidate: { dedupeKey: "task:t1", updatedAtMs: Date.parse("2026-01-01T00:00:00Z") },
        })}
      />,
    );

    expect(screen.queryByRole("region", { name: /approval requests/i })).not.toBeInTheDocument();
  });

  it("renders a real approval candidate with the mailbox count and CTA", () => {
    const handleTaskViewChange = vi.fn();
    render(
      <DashboardBanners
        {...buildProps({
          mailboxPendingApprovalCount: 2,
          approvalBannerCandidate: { dedupeKey: "approval:a1", updatedAtMs: Date.parse("2026-01-01T00:00:00Z") },
          handleTaskViewChange,
        })}
      />,
    );

    expect(screen.getByRole("region", { name: /approval requests/i })).toBeInTheDocument();
    expect(screen.getByText("2 approval requests need your attention")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open mailbox/i }));
    expect(handleTaskViewChange).toHaveBeenCalledWith("mailbox");
  });

  it("keeps the one-request floor only for a real approval SSE/count race", () => {
    render(
      <DashboardBanners
        {...buildProps({
          mailboxPendingApprovalCount: 0,
          approvalBannerCandidate: { dedupeKey: "approval:a1", updatedAtMs: Date.parse("2026-01-01T00:00:00Z") },
        })}
      />,
    );

    expect(screen.getByText("1 approval request need your attention")).toBeInTheDocument();
  });
});
