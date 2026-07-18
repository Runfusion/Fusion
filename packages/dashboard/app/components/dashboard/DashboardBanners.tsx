/*
FNXC:DashboardBanners 2026-06-24-00:00:
DashboardBanners is the conditional banner cluster rendered above the dashboard-project-shell, extracted verbatim from AppInner's main return JSX. It is a pure render of the same gated banners (every condition, prop, FNXC comment, and the TaskIdIntegrityBanner setDashboardHealth updater preserved byte-for-byte); the banner components are imported directly from their siblings.
*/
import type { DashboardBannersProps } from "./types";
import type { SectionId } from "../SettingsModal";
import { TestModeBanner } from "../TestModeBanner";
import { SqliteMigrationBanner } from "../SqliteMigrationBanner";
import { EngineUnavailableBanner } from "../EngineUnavailableBanner";
import { EngineStatusBanner } from "../EngineStatusBanner";
import { OAuthReloginBanner } from "../OAuthReloginBanner";
import { SessionNotificationBanner } from "../SessionNotificationBanner";
import { CliBinaryInstallBanner } from "../CliBinaryInstallBanner";
import { OnboardingResumeCard } from "../OnboardingResumeCard";
import { PostOnboardingRecommendations } from "../PostOnboardingRecommendations";
import { UpdateAvailableBanner } from "../UpdateAvailableBanner";
import MergeAdvanceNotice from "../MergeAdvanceNotice";
import { TaskIdIntegrityBanner } from "../TaskIdIntegrityBanner";
import { DbCorruptionBanner } from "../DbCorruptionBanner";
import { SetupWarningBanner } from "../SetupWarningBanner";
import { ApprovalNotificationBanner } from "../ApprovalNotificationBanner";
import { GitHubStarPrompt } from "../GitHubStarPrompt";

function isMailboxApprovalCandidate(candidate: DashboardBannersProps["approvalBannerCandidate"]): boolean {
  return candidate?.dedupeKey.startsWith("approval:") === true;
}

export function DashboardBanners({
  viewMode,
  currentProject,
  authTokenRecoveryOpen,
  isTestMode,
  dashboardHealth,
  setDashboardHealth,
  taskView,
  modalManager,
  sessionBannersHidden,
  sessionsNeedingInput,
  handleOpenBackgroundSession,
  handleDismissNeedingInputSession,
  handleDismissAllNeedingInputSessions,
  handleCliAction,
  getCliActionDisabledReasonForBanner,
  openSettingsWithNav,
  showOnboardingResumeCard,
  showPostOnboardingRecommendations,
  updateAvailable,
  latestVersion,
  currentVersion,
  updateBannerDismissed,
  dismissUpdateBanner,
  refreshDbCorruptionHealth,
  dbCorruptionRefreshing,
  dbCorruptionRefreshError,
  setupReadinessLoading,
  hasWarnings,
  setupWarningDismissed,
  handleDismissSetupWarning,
  hasAiProvider,
  hasGithub,
  showGithubSetupWarning,
  approvalBannerCandidate,
  dismissApproval,
  mailboxPendingApprovalCount,
  handleTaskViewChange,
  showGitHubStarPrompt,
  gitHubStarPromptShown,
  markGitHubStarPromptShown,
  setShowGitHubStarPrompt,
}: DashboardBannersProps) {
  /* FNXC:DashboardBanners 2026-06-26-00:00: The Open Mailbox approval banner is gated by an approval:<id> candidate from a real ApprovalRequest. The count floor remains only for the approval-SSE/count-refresh race and must not fabricate a mailbox request for task awaiting-approval states. */
  const showMailboxApprovalBanner = isMailboxApprovalCandidate(approvalBannerCandidate);
  /* FNXC:AuthRecovery 2026-06-29-00:00: Daemon-auth token recovery owns unauthorized remediation while its blocking dialog is open. Suppress engine remediation banners in parallel so operators fix the token once without seeing stale engine restart/start controls or live-region shells. */
  const showEngineRemediationBanners = !authTokenRecoveryOpen;


  return (
    <>
      {viewMode === "project" && currentProject && (
        <>
          <TestModeBanner isActive={isTestMode} />
          {/* FNXC:PostgresMigrationBanner 2026-07-12: one-time post-auto-migration
              notice ("data migrated, backup exists") with a Discord Need-help link;
              self-fetches settings, keyed to re-check on project switch. */}
          <SqliteMigrationBanner key={`sqlite-migration-${currentProject.id}`} projectId={currentProject.id} />
          {showEngineRemediationBanners && (
            <EngineUnavailableBanner isVisible={dashboardHealth?.engine?.available === false} />
          )}
          {showEngineRemediationBanners && (
            /* FNXC:EngineStatusBanner 2026-06-22-00:00: Project-scoped engine remediation belongs in the same project-only banner guard family as the existing operational notices, and the key resets polling immediately when the user switches projects. */
            <EngineStatusBanner key={currentProject.id} projectId={currentProject.id} />
          )}
          <OAuthReloginBanner
            onReLogin={(_providerId) => openSettingsWithNav("authentication" as SectionId)}
          />
        </>
      )}
      {/*
       * FNXC:SessionBanner 2026-07-16-21:10:
       * FN-8229 removed the always-visible footer AI pill, so active non-planning
       * sessions must override the appearance preference that hides idle banners.
       * Per-session dismissal still lets operators suppress an individual entry.
       */}
      {viewMode === "project" && currentProject && taskView !== "missions" && !modalManager.isPlanningOpen && (!sessionBannersHidden || sessionsNeedingInput.length > 0) && (
        <SessionNotificationBanner
          sessions={sessionsNeedingInput}
          onResumeSession={handleOpenBackgroundSession}
          onDismissSession={handleDismissNeedingInputSession}
          onDismissAll={handleDismissAllNeedingInputSessions}
          onCliAction={handleCliAction}
          getCliActionDisabledReason={getCliActionDisabledReasonForBanner}
        />
      )}
      {viewMode === "project" && currentProject && (
        <>
          {/* FNXC:PostgresMigrationNotice 2026-07-14-18:36: The PostgreSQL cutover is complete, so the dashboard must not advertise it as a future release. Active migration failures remain visible through SqliteMigrationBanner above. */}
          <CliBinaryInstallBanner
            onOpenSettings={() => openSettingsWithNav("general" as SectionId)}
          />
        </>
      )}
      {viewMode === "project" && currentProject && showOnboardingResumeCard && (
        <OnboardingResumeCard onResume={modalManager.openModelOnboarding} />
      )}
      {viewMode === "project" && currentProject && showPostOnboardingRecommendations && (
        <PostOnboardingRecommendations
          onOpenModelOnboarding={modalManager.openModelOnboarding}
          onOpenSettings={(section) => openSettingsWithNav(section as SectionId)}
        />
      )}
      {viewMode === "project" && currentProject && updateAvailable && latestVersion && currentVersion && !updateBannerDismissed && (
        <UpdateAvailableBanner
          latestVersion={latestVersion}
          currentVersion={currentVersion}
          onDismiss={dismissUpdateBanner}
        />
      )}
      {viewMode === "project" && currentProject && (
        <MergeAdvanceNotice projectId={currentProject.id} />
      )}
      {viewMode === "project" && currentProject && dashboardHealth?.taskIdIntegrity?.status === "anomaly" && dashboardHealth.taskIdIntegrity.recommendedAction && (
        <TaskIdIntegrityBanner
          report={dashboardHealth.taskIdIntegrity}
          recommendedAction={dashboardHealth.taskIdIntegrity.recommendedAction}
          onRefresh={(report, recommendedAction) => {
            setDashboardHealth((current) => {
              if (!current) {
                return null;
              }
              return {
                ...current,
                status:
                  report.status !== "ok"
                  || !current.database.healthy
                  || current.database.corruptionDetected
                    ? "degraded"
                    : "ok",
                taskIdIntegrity: {
                  ...report,
                  recommendedAction,
                },
              };
            });
          }}
        />
      )}
      {viewMode === "project" && currentProject && dashboardHealth?.database?.corruptionDetected === true && (
        <DbCorruptionBanner
          errors={dashboardHealth.database.corruptionErrors}
          lastCheckedAt={dashboardHealth.database.lastCheckedAt}
          onRefresh={refreshDbCorruptionHealth}
          refreshing={dbCorruptionRefreshing}
          refreshError={dbCorruptionRefreshError}
        />
      )}
      {viewMode === "project" && currentProject && !setupReadinessLoading && hasWarnings && !setupWarningDismissed && (
        <SetupWarningBanner
          hasAiProvider={hasAiProvider}
          hasGithub={hasGithub}
          showGithubWarning={showGithubSetupWarning}
          onConnectGithub={() => openSettingsWithNav("authentication" as SectionId)}
          onDismiss={handleDismissSetupWarning}
        />
      )}
      {viewMode === "project" && currentProject && approvalBannerCandidate && showMailboxApprovalBanner && (
        <ApprovalNotificationBanner
          pendingCount={Math.max(mailboxPendingApprovalCount, 1)}
          onOpenMailbox={() => handleTaskViewChange("mailbox")}
          onDismiss={() => dismissApproval(approvalBannerCandidate)}
        />
      )}
      {/* FNXC:Onboarding 2026-06-22-03:11: The one-time GitHub star prompt stays tied to first completed task, but first-run setup must finish the optional persistent-agent create/skip step before any star ask can surface. Do not add a second setup-specific star prompt. */}
      {viewMode === "project" && currentProject && showGitHubStarPrompt && !gitHubStarPromptShown && !modalManager.setupWizardOpen && (
        <GitHubStarPrompt
          onDismiss={() => {
            markGitHubStarPromptShown();
            setShowGitHubStarPrompt(false);
          }}
        />
      )}
    </>
  );
}
