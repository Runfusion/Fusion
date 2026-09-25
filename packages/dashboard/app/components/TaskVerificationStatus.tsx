import type { TaskVerificationRequest } from "@fusion/core";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./TaskVerificationStatus.css";

function formatDuration(durationMs: number | undefined): string | null {
  if (typeof durationMs !== "number") return null;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * FNXC:TaskVerificationStatus 2026-07-30-00:00:
 * FN-8296 exposes executor-owned verification as persisted state in every human
 * surface. This component deliberately renders a record only; it never offers a
 * command control or reimplements the chat/executor permission boundary.
 */
export function TaskVerificationStatus({ request, compact = false }: { request: TaskVerificationRequest | null; compact?: boolean }) {
  const { t } = useTranslation("app");
  if (!request) return null;

  const running = request.status === "requested" || request.status === "running";
  const failed = request.status === "failed" || request.status === "rejected";
  const Icon = running ? Loader2 : failed ? AlertCircle : CheckCircle2;
  /*
  FNXC:VerificationWriteAhead 2026-08-31-00:00 (EXAM-010):
  A stale-reclaimed `failed` record carries rejectionReason with NO result summary
  (the executor died before writing one). Previously that row fell through to the
  "Running in the task worktree" text — a terminal record rendering as live. Surface
  the reclaim reason instead.
  */
  const summary = request.status === "rejected"
    ? request.rejectionReason ?? t("taskVerification.requestRejected", "Request rejected")
    : request.result
      ? `${request.result.success ? t("taskVerification.passed", "Passed") : t("taskVerification.failed", "Failed")}${formatDuration(request.result.durationMs) ? ` · ${formatDuration(request.result.durationMs)}` : ""}`
      : request.status === "failed"
        ? request.rejectionReason ?? t("taskVerification.failed", "Failed")
        : request.status === "requested" ? t("taskVerification.queued", "Queued for the task executor") : t("taskVerification.running", "Running in the task worktree");

  return (
    <section className={`task-verification-status task-verification-status--${request.status}${compact ? " task-verification-status--compact" : ""}`} aria-live="polite" data-testid="task-verification-status">
      <div className="task-verification-status__heading">
        <Icon aria-hidden="true" className={running ? "task-verification-status__spinner" : undefined} />
        <strong>{t("taskVerification.heading", "Verification · {{profile}}", { profile: request.profile })}</strong>
        <span className="task-verification-status__state">{request.status}</span>
      </div>
      <p>{summary}</p>
      {!compact && request.result?.stderrTail ? <pre className="task-verification-status__output">{request.result.stderrTail}</pre> : null}
    </section>
  );
}
