import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AiSessionSummary } from "../../../api";
import type { ModalManager } from "../../../hooks/useModalManager";
import { AuthTokenRecoveryDialog } from "../../AuthTokenRecoveryDialog";
import type { DashboardBannersProps } from "../types";

vi.mock("../../TestModeBanner", () => ({ TestModeBanner: () => null }));
vi.mock("../../EngineUnavailableBanner", () => ({
  EngineUnavailableBanner: ({ isVisible }: { isVisible: boolean }) => (
    isVisible ? (
      <section role="status" aria-live="polite" data-testid="engine-unavailable-banner">
        <button type="button">Start engine</button>
      </section>
    ) : null
  ),
}));
vi.mock("../../EngineStatusBanner", () => ({
  EngineStatusBanner: ({ projectId }: { projectId: string }) => (
    <section role="status" aria-live="polite" data-testid="engine-status-banner">
      <span>Engine status for {projectId}</span>
      <button type="button">Start engine</button>
    </section>
  ),
}));
vi.mock("../../OAuthReloginBanner", () => ({ OAuthReloginBanner: () => null }));
vi.mock("../../CliBinaryInstallBanner", () => ({ CliBinaryInstallBanner: () => null }));
vi.mock("../../OnboardingResumeCard", () => ({ OnboardingResumeCard: () => null }));
vi.mock("../../PostOnboardingRecommendations", () => ({ PostOnboardingRecommendations: () => null }));
vi.mock("../../UpdateAvailableBanner", () => ({ UpdateAvailableBanner: () => null }));
vi.mock("../../MergeAdvanceNotice", () => ({ default: () => null }));
vi.mock("../../TaskIdIntegrityBanner", () => ({ TaskIdIntegrityBanner: () => null }));
vi.mock("../../DbCorruptionBanner", () => ({ DbCorruptionBanner: () => null }));
vi.mock("../../SetupWarningBanner", () => ({
  SetupWarningBanner: ({
    hasAiProvider,
    hasGithub,
    showGithubWarning,
    onDismiss,
    onConnectGithub,
  }: {
    hasAiProvider: boolean;
    hasGithub: boolean;
    showGithubWarning?: boolean;
    onDismiss?: () => void;
    onConnectGithub?: () => void;
  }) => (
    <section data-testid="setup-warning-banner">
      <span data-testid="setup-warning-ai">{String(hasAiProvider)}</span>
      <span data-testid="setup-warning-github">{String(hasGithub)}</span>
      <span data-testid="setup-warning-show-github">{String(showGithubWarning)}</span>
      {onConnectGithub ? <button type="button" onClick={onConnectGithub}>Connect GitHub</button> : null}
      {onDismiss ? <button type="button" onClick={onDismiss}>Dismiss setup warning</button> : null}
    </section>
  ),
}));
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
    authTokenRecoveryOpen: false,
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
    showGithubSetupWarning: false,
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
  return screen.queryByRole("region", { name: /AI sessions (in progress, )?needing input,? or failed/i });
}

function unavailableEngineHealth(): DashboardBannersProps["dashboardHealth"] {
  return {
    status: "degraded",
    engine: { available: false, status: "unavailable" },
    database: { healthy: true, corruptionDetected: false, corruptionErrors: [], lastCheckedAt: null },
    taskIdIntegrity: { status: "ok" },
  } as DashboardBannersProps["dashboardHealth"];
}

function AuthRecoveryBannerShell({
  open,
  currentProject = buildProps().currentProject,
  dashboardHealth = unavailableEngineHealth(),
}: {
  open: boolean;
  currentProject?: DashboardBannersProps["currentProject"];
  dashboardHealth?: DashboardBannersProps["dashboardHealth"] | undefined;
}) {
  return (
    <>
      <DashboardBanners
        {...buildProps({
          authTokenRecoveryOpen: open,
          currentProject,
          dashboardHealth: dashboardHealth as DashboardBannersProps["dashboardHealth"],
          sessionsNeedingInput: [],
        })}
      />
      <AuthTokenRecoveryDialog open={open} />
    </>
  );
}

function expectNoEngineRemediationShell(): void {
  expect(screen.queryByTestId("engine-status-banner")).not.toBeInTheDocument();
  expect(screen.queryByTestId("engine-unavailable-banner")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /start engine/i })).not.toBeInTheDocument();
  expect(
    document.querySelector(
      '[data-testid="engine-status-banner"][aria-live="polite"], [data-testid="engine-unavailable-banner"][aria-live="polite"]',
    ),
  ).not.toBeInTheDocument();
}

describe("DashboardBanners engine remediation visibility", () => {
  /*
  FNXC:AuthRecovery 2026-06-29-00:00:
  FN-7243 surface enumeration: DashboardBanners is the app-shell project banner stack that mounts EngineStatusBanner and EngineUnavailableBanner. Auth token recovery must suppress both engine-remediation components while preserving the existing project/currentProject guard, so unauthorized daemon-token recovery does not leave empty aria-live regions, start buttons, or banner shells behind.
  */
  it("shows only the auth-token recovery dialog when unauthorized recovery opens over visible engine remediation", () => {
    const { rerender } = render(<AuthRecoveryBannerShell open={false} />);

    expect(screen.getByTestId("engine-status-banner")).toBeInTheDocument();
    expect(screen.getByTestId("engine-unavailable-banner")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /start engine/i })).toHaveLength(2);

    rerender(<AuthRecoveryBannerShell open={true} />);

    const dialog = screen.getByRole("dialog", { name: "Authentication token required" });
    const tokenInput = screen.getByLabelText("Replacement token");
    expect(dialog).toBeInTheDocument();
    expect(tokenInput).toBeInTheDocument();
    expect(document.activeElement).toBe(tokenInput);
    expectNoEngineRemediationShell();
  });

  it("does not create stale engine output when auth recovery is open without a current project or health", () => {
    render(
      <AuthRecoveryBannerShell
        open={true}
        currentProject={null}
        dashboardHealth={undefined}
      />,
    );

    expect(screen.getAllByRole("dialog", { name: "Authentication token required" })).toHaveLength(1);
    expect(screen.getByLabelText("Replacement token")).toBe(document.activeElement);
    expectNoEngineRemediationShell();
  });

  it("suppresses engine remediation banners and shells while auth token recovery is open", () => {
    render(
      <DashboardBanners
        {...buildProps({
          authTokenRecoveryOpen: true,
          dashboardHealth: unavailableEngineHealth(),
        })}
      />,
    );

    expectNoEngineRemediationShell();
  });

  it("mounts engine remediation banners when auth token recovery is closed and engine requires attention", () => {
    render(
      <DashboardBanners
        {...buildProps({
          authTokenRecoveryOpen: false,
          dashboardHealth: unavailableEngineHealth(),
        })}
      />,
    );

    expect(screen.getByTestId("engine-status-banner")).toBeInTheDocument();
    expect(screen.getByTestId("engine-unavailable-banner")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /start engine/i })).toHaveLength(2);
  });

  it("does not mount the dashboard-only unavailable banner when desktop health reports a startable manager", () => {
    render(
      <DashboardBanners
        {...buildProps({
          authTokenRecoveryOpen: false,
          dashboardHealth: {
            ...unavailableEngineHealth(),
            engine: { available: true },
          } as DashboardBannersProps["dashboardHealth"],
        })}
      />,
    );

    expect(screen.queryByTestId("engine-unavailable-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("engine-status-banner")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /start engine/i })).toHaveLength(1);
  });

  it("preserves the current project guard while auth recovery is closed", () => {
    render(<DashboardBanners {...buildProps({ authTokenRecoveryOpen: false, currentProject: null })} />);

    expect(screen.queryByTestId("engine-status-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-unavailable-banner")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start engine/i })).not.toBeInTheDocument();
  });
});

describe("DashboardBanners session notification visibility", () => {
  /*
  FNXC:SessionBanner 2026-07-16-21:10:
  FN-8229 makes DashboardBanners the only app-shell entry point after removing
  the footer AI pill. Missions and the Planning modal retain their dedicated
  surfaces, while active non-planning sessions override the hidden-banner
  preference so background work always remains reachable on board/list views.
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

  it("keeps active sessions reachable when the appearance setting hides idle banners", () => {
    const handleOpenBackgroundSession = vi.fn();
    render(
      <DashboardBanners
        {...buildProps({
          sessionBannersHidden: true,
          sessionsNeedingInput: [buildSession({ id: "background-subtask", type: "subtask", status: "generating", title: "Background subtask" })],
          handleOpenBackgroundSession,
        })}
      />,
    );

    expect(querySessionBanner()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(handleOpenBackgroundSession).toHaveBeenCalledWith(expect.objectContaining({ id: "background-subtask" }));
  });

  it("does not render when banners are hidden and there are no active sessions", () => {
    render(<DashboardBanners {...buildProps({ sessionBannersHidden: true, sessionsNeedingInput: [] })} />);

    expect(querySessionBanner()).not.toBeInTheDocument();
  });

  it("does not render when there are zero sessions needing input", () => {
    render(<DashboardBanners {...buildProps({ sessionsNeedingInput: [] })} />);

    expect(querySessionBanner()).not.toBeInTheDocument();
  });
});

describe("DashboardBanners setup warning visibility", () => {
  it("does not mount an empty setup warning shell while GitHub is inside the grace period", () => {
    render(
      <DashboardBanners
        {...buildProps({
          hasAiProvider: true,
          hasGithub: false,
          showGithubSetupWarning: false,
          hasWarnings: false,
        })}
      />,
    );

    expect(screen.queryByTestId("setup-warning-banner")).not.toBeInTheDocument();
  });

  it("preserves immediate AI warnings while GitHub is inside the grace period", () => {
    render(
      <DashboardBanners
        {...buildProps({
          hasAiProvider: false,
          hasGithub: false,
          showGithubSetupWarning: false,
          hasWarnings: true,
        })}
      />,
    );

    expect(screen.getByTestId("setup-warning-banner")).toBeInTheDocument();
    expect(screen.getByTestId("setup-warning-show-github")).toHaveTextContent("false");
  });

  it("passes the expired GitHub warning state into the shared setup banner", () => {
    render(
      <DashboardBanners
        {...buildProps({
          hasAiProvider: true,
          hasGithub: false,
          showGithubSetupWarning: true,
          hasWarnings: true,
        })}
      />,
    );

    expect(screen.getByTestId("setup-warning-banner")).toBeInTheDocument();
    expect(screen.getByTestId("setup-warning-show-github")).toHaveTextContent("true");
  });

  it("opens Settings authentication from the GitHub setup CTA", () => {
    const openSettingsWithNav = vi.fn();
    render(
      <DashboardBanners
        {...buildProps({
          hasAiProvider: true,
          hasGithub: false,
          showGithubSetupWarning: true,
          hasWarnings: true,
          openSettingsWithNav,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

    expect(openSettingsWithNav).toHaveBeenCalledWith("authentication");
  });

  it("keeps dismissed setup warnings hidden for the current project", () => {
    render(
      <DashboardBanners
        {...buildProps({
          hasAiProvider: false,
          hasGithub: false,
          showGithubSetupWarning: true,
          hasWarnings: true,
          setupWarningDismissed: true,
        })}
      />,
    );

    expect(screen.queryByTestId("setup-warning-banner")).not.toBeInTheDocument();
  });

  it("does not render setup warning shells while readiness is loading", () => {
    render(
      <DashboardBanners
        {...buildProps({
          hasAiProvider: false,
          hasGithub: false,
          showGithubSetupWarning: true,
          hasWarnings: true,
          setupReadinessLoading: true,
        })}
      />,
    );

    expect(screen.queryByTestId("setup-warning-banner")).not.toBeInTheDocument();
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
