import { X } from "lucide-react";
import { useRef } from "react";
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

const disabledReasonCopy: Record<string, string> = {
  "no-remote": "No `origin` remote configured.",
  "no-upstream": "Branch has no upstream on origin.",
  "merge-locked": "Push paused — a Fusion merge is in progress.",
};

export default function MergeAdvanceNotice({ projectId, apiBase = "/api" }: MergeAdvanceNoticeProps) {
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
    const pushLabel = forceWithLease ? "Push (force-with-lease)" : "Push to origin";

    return (
      <section className="merge-advance-notice__push">
        <p className="merge-advance-notice__push-heading">
          Push {pushStatus.integrationBranch} to origin — ahead by {pushStatus.aheadCount} commit{pushStatus.aheadCount === 1 ? "" : "s"}.
        </p>
        <div className="merge-advance-notice__push-actions">
          {pushState === "ok" ? (
            <span>Pushed to origin/{pushStatus.integrationBranch} @ {shortSha(pushStatus.remoteSha)}.</span>
          ) : (
            <button
              type="button"
              className={`btn btn-sm ${forceWithLease ? "btn-warning" : ""}`.trim()}
              disabled={disablePush}
              onClick={() => { void push(); }}
            >
              {pushState === "pending" ? "Pushing…" : pushLabel}
            </button>
          )}
          {!pushStatus.canPush && pushStatus.disabledReason && pushStatus.disabledReason in disabledReasonCopy ? (
            <span className="merge-advance-notice__push-error">{disabledReasonCopy[pushStatus.disabledReason]}</span>
          ) : null}
        </div>
        {typeof pushState === "object" && (pushState.outcome === "rejected-non-ff" || pushState.outcome === "sha-mismatch") ? (
          <div className="merge-advance-notice__push-error" role="alert">
            <span>{pushState.error}</span>{" "}
            <button type="button" className="btn btn-sm" onClick={() => { void pull(); }}>Smart Pull</button>
          </div>
        ) : null}
        {typeof pushState === "object" && (pushState.outcome === "rejected-other" || pushState.outcome === "failed") ? (
          <div className="merge-advance-notice__push-error" role="alert">
            <span>{pushState.error}</span>
            {pushState.stderr ? <pre>{pushState.stderr}</pre> : null}
            <button type="button" className="btn btn-sm" onClick={clearPushError}>Dismiss</button>
          </div>
        ) : null}
        <details className="merge-advance-notice__push-advanced">
          <summary>Advanced</summary>
          <label>
            <input
              type="checkbox"
              checked={forceWithLease}
              onChange={(event) => setForceWithLease(event.target.checked)}
            />
            {" "}Allow force-with-lease (use only when you know origin diverged intentionally)
          </label>
        </details>
      </section>
    );
  };

  return (
    <>
      <div ref={bannerRef} className="merge-advance-notice" role="status" aria-live="polite">
        <div className="merge-advance-notice__content">
          <strong>{notice.integrationBranch} advanced to {shortSha(notice.toSha)}.</strong>{" "}
          Your checked-out copy at {checkout.worktreePath} is behind.
          {localChangesPreserved ? " (local changes will be auto-stashed and restored)" : ""}
          {pullError ? <span className="merge-advance-notice__error" role="alert"> {pullError}</span> : null}
          {pulling ? <span className="merge-advance-notice__hint"> Pulling…</span> : null}
          {renderPushSection()}
        </div>
        <div className="merge-advance-notice__actions">
          {conflictState ? null : (
            <button type="button" className="btn btn-sm" disabled={pulling} onClick={() => { void pull(); }}>
              Pull
            </button>
          )}
          <button
            type="button"
            className="merge-advance-notice__dismiss touch-target"
            aria-label="Dismiss merge advance notice"
            onClick={dismissWithFocusGuard}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </div>
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
