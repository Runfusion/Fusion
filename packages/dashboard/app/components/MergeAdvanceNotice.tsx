import { X } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Banner } from "./Banner";
import StashConflictModal from "./StashConflictModal";
import { useMergeAdvanceNotice } from "../hooks/useMergeAdvanceNotice";
import "./MergeAdvanceNotice.css";

interface MergeAdvanceNoticeProps {
  projectId?: string;
  apiBase?: string;
}

function shortSha(sha: string | null): string {
  if (!sha) return "";
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}


export default function MergeAdvanceNotice({ projectId, apiBase = "/api" }: MergeAdvanceNoticeProps) {
  const { t } = useTranslation("app");
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const {
    notice,
    dismiss,
    pull,
    pullState,
    conflictState,
    setConflictState,
    pushStatus,
    pushState,
    push,
    clearPushError,
    forceWithLease,
    setForceWithLease,
  } = useMergeAdvanceNotice({ projectId, apiBase });

  if (!notice || !notice.userCheckout) {
    return null;
  }

  const checkout = notice.userCheckout;
  const localChangesPreserved = checkout.dirty || checkout.untrackedCount > 0;
  const pulling = pullState === "pending" || pullState === "stashing";
  const pullError = typeof pullState === "object" ? pullState.error : null;

  const dismissWithFocusGuard = () => {
    const activeElement = document.activeElement;
    const focusedInsideBanner = activeElement instanceof HTMLElement && bannerRef.current?.contains(activeElement);
    dismiss();
    if (focusedInsideBanner) document.body.focus();
  };

  const renderPushSection = () => {
    if (!pushStatus || pushStatus.aheadCount <= 0) {
      return null;
    }

    const disablePush = pushState === "pending" || pushStatus.canPush === false || pulling;
    const pushLabel = forceWithLease ? t("merge.pushForceWithLease", "Push (force-with-lease)") : t("merge.pushToOrigin", "Push to origin");

    return (
      <section className="merge-advance-notice__push">
        <p className="merge-advance-notice__push-heading">
          {t("merge.pushHeading", "Push {{branch}} to origin — ahead by {{count}} commit{{plural}}.", { branch: pushStatus.integrationBranch, count: pushStatus.aheadCount, plural: pushStatus.aheadCount === 1 ? "" : "s" })}
        </p>
        <div className="merge-advance-notice__push-actions">
          {pushState === "ok" ? (
            <span>{t("merge.pushSuccess", "Pushed to origin/{{branch}} @ {{sha}}.", { branch: pushStatus.integrationBranch, sha: shortSha(pushStatus.remoteSha) })}</span>
          ) : (
            <button
              type="button"
              className={`btn btn-sm ${forceWithLease ? "btn-warning" : ""}`.trim()}
              disabled={disablePush}
              onClick={() => { void push(); }}
            >
              {pushState === "pending" ? t("merge.pushing", "Pushing…") : pushLabel}
            </button>
          )}
          {!pushStatus.canPush && pushStatus.disabledReason ? (
            <span className="merge-advance-notice__push-error">
              {pushStatus.disabledReason === "no-remote"
                ? t("merge.disabledNoRemote", "No `origin` remote configured.")
                : pushStatus.disabledReason === "no-upstream"
                  ? t("merge.disabledNoUpstream", "Branch has no upstream on origin.")
                  : pushStatus.disabledReason === "merge-locked"
                    ? t("merge.disabledMergeLocked", "Push paused — a Fusion merge is in progress.")
                    : null}
            </span>
          ) : null}
        </div>
        {typeof pushState === "object" && (pushState.outcome === "rejected-non-ff" || pushState.outcome === "sha-mismatch") ? (
          <div className="merge-advance-notice__push-error" role="alert">
            <span>{pushState.error}</span>{" "}
            <button type="button" className="btn btn-sm" onClick={() => { void pull(); }}>{t("merge.smartPull", "Smart Pull")}</button>
          </div>
        ) : null}
        {typeof pushState === "object" && (pushState.outcome === "rejected-other" || pushState.outcome === "failed") ? (
          <div className="merge-advance-notice__push-error" role="alert">
            <span>{pushState.error}</span>
            {pushState.stderr ? <pre>{pushState.stderr}</pre> : null}
            <button type="button" className="btn btn-sm" onClick={clearPushError}>{t("actions.dismiss", "Dismiss")}</button>
          </div>
        ) : null}
        <details className="merge-advance-notice__push-advanced">
          <summary>{t("merge.advanced", "Advanced")}</summary>
          <label>
            <input
              type="checkbox"
              checked={forceWithLease}
              onChange={(event) => setForceWithLease(event.target.checked)}
            />
            {" "}{t("merge.forceWithLeaseLabel", "Allow force-with-lease (use only when you know origin diverged intentionally)")}
          </label>
        </details>
      </section>
    );
  };

  return (
    <>
      <Banner
        ref={bannerRef}
        className="merge-advance-notice"
        tone="warning"
        role="status"
        aria-live="polite"
        actions={<div className="merge-advance-notice__actions">
          {conflictState ? null : (
            <button type="button" className="btn btn-sm" disabled={pulling} onClick={() => { void pull(); }}>
              {t("actions.pull", "Pull")}
            </button>
          )}
          <button type="button" className="merge-advance-notice__dismiss touch-target" aria-label={t("merge.dismissNotice", "Dismiss merge advance notice")} onClick={dismissWithFocusGuard}>
            <X aria-hidden="true" />
          </button>
        </div>}
      >
        <div className="merge-advance-notice__content">
          <strong>{t("merge.advancedTo", "{{branch}} advanced to {{sha}}.", { branch: notice.integrationBranch, sha: shortSha(notice.toSha) })}</strong>{" "}
          {t("merge.checkedOutBehind", "Your checked-out copy at {{path}} is behind.", { path: checkout.worktreePath })}
          {localChangesPreserved ? t("merge.changesWillAutoStash", " (local changes will be auto-stashed and restored)") : ""}
          {pullError ? <span className="merge-advance-notice__error" role="alert"> {pullError}</span> : null}
          {pulling ? <span className="merge-advance-notice__hint"> {t("merge.pulling", "Pulling…")}</span> : null}
          {renderPushSection()}
        </div>
      </Banner>
      <StashConflictModal
        open={conflictState !== null}
        onClose={(stashDropped) => {
          setConflictState(null);
          if (stashDropped) {
            dismissWithFocusGuard();
          }
        }}
        worktreePath={checkout.worktreePath}
        integrationBranch={notice.integrationBranch}
        stashSha={conflictState?.stashSha ?? ""}
        stashLabel={conflictState?.stashLabel ?? ""}
        conflictedFiles={conflictState?.conflictedFiles ?? []}
        autostashOutcome={conflictState?.autostashOutcome ?? "conflict-needs-manual"}
        taskId={notice.taskId}
      />
    </>
  );
}
