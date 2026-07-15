/**
 * RuntimeFallbackBadge (FUX-022)
 *
 * Renders a visible badge on an agent/task card when the most recent
 * `session:runtime-resolved` audit event for that task shows
 * `wasConfigured: false` alongside a non-empty configured `runtimeHint` —
 * i.e. the configured runtime (e.g. "hermes") could not be resolved and the
 * session silently fell back to the default `pi` runtime. Also fires a toast
 * via the shared ToastProvider the first time this fallback state is newly
 * observed for a session (not re-fired on every poll/re-render).
 *
 * Renders null (no leftover placeholder) for every other state: no event
 * yet, wasConfigured true, or wasConfigured false with a blank hint.
 */
import { memo, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { useRuntimeFallbackStatus } from "../hooks/useRuntimeFallbackStatus";
import { useOptionalToast } from "../hooks/useToast";

interface RuntimeFallbackBadgeProps {
  taskId?: string;
  /** Gate polling to visible cards only (e.g. pass the card's own isInViewport state). */
  isInViewport: boolean;
  projectId?: string;
}

function RuntimeFallbackBadgeComponent({ taskId, isInViewport, projectId }: RuntimeFallbackBadgeProps) {
  /*
  FNXC:ToastProvider 2026-07-14-19:25:
  Prefer optional toast so board card unit/harness mounts without ToastProvider still render the badge (and do not throw through ErrorBoundary blanking the board).
  */
  const toast = useOptionalToast();
  const status = useRuntimeFallbackStatus(taskId, isInViewport, projectId);

  useEffect(() => {
    if (status.shouldToastNow && status.message) {
      toast?.addToast(status.message, "warning");
    }
    // FNXC:RuntimeFallbackUI 2026-07-08-00:00:
    // Intentionally omit addToast from deps — its identity is stable per ToastProvider instance, so re-toasting is keyed only on status changes.
    // Note: repo eslint config omits react-hooks/exhaustive-deps, so a disable directive for it is itself a lint error (rule-not-found). Do not re-add one.
  }, [status.shouldToastNow, status.message, toast]);

  if (!status.showBadge || !status.message) {
    return null;
  }

  return (
    <span
      className="card-status-badge card-runtime-fallback-badge"
      title={status.message}
      data-testid="runtime-fallback-badge"
      data-runtime-hint={status.runtimeHint ?? undefined}
      data-runtime-fallback-reason={status.reason ?? undefined}
    >
      <AlertTriangle size={10} aria-hidden="true" />
      <span>{status.message}</span>
    </span>
  );
}

export const RuntimeFallbackBadge = memo(RuntimeFallbackBadgeComponent);
RuntimeFallbackBadge.displayName = "RuntimeFallbackBadge";
