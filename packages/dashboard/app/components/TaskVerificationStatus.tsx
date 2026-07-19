import type { TaskVerificationRequest } from "@fusion/core";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
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
  if (!request) return compact ? null : <p className="task-verification-status task-verification-status--empty">No chat verification requested.</p>;

  const running = request.status === "requested" || request.status === "running";
  const failed = request.status === "failed" || request.status === "rejected";
  const Icon = running ? Loader2 : failed ? AlertCircle : CheckCircle2;
  const summary = request.status === "rejected"
    ? request.rejectionReason ?? "Request rejected"
    : request.result
      ? `${request.result.success ? "Passed" : "Failed"}${formatDuration(request.result.durationMs) ? ` · ${formatDuration(request.result.durationMs)}` : ""}`
      : request.status === "requested" ? "Queued for the task executor" : "Running in the task worktree";

  return (
    <section className={`task-verification-status task-verification-status--${request.status}${compact ? " task-verification-status--compact" : ""}`} aria-live="polite" data-testid="task-verification-status">
      <div className="task-verification-status__heading">
        <Icon aria-hidden="true" className={running ? "task-verification-status__spinner" : undefined} />
        <strong>Verification · {request.profile}</strong>
        <span className="task-verification-status__state">{request.status}</span>
      </div>
      <p>{summary}</p>
      {!compact && request.result?.stderrTail ? <pre className="task-verification-status__output">{request.result.stderrTail}</pre> : null}
    </section>
  );
}
