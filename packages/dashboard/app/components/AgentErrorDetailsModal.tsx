import "./AgentErrorDetailsModal.css";
import { useMemo, useState } from "react";
import { AlertCircle, Check, Copy, ExternalLink } from "lucide-react";

const DEFAULT_ISSUE_URL = "https://github.com/Runfusion/Fusion/issues/new";

export interface AgentErrorIssueContext {
  surface: string;
  agentId?: string;
  agentName?: string;
  agentState?: string;
  runId?: string;
  taskId?: string;
  timestamp?: string;
}

interface AgentErrorDetailsModalProps {
  open: boolean;
  onClose: () => void;
  errorText: string;
  issueContext: AgentErrorIssueContext;
}

export function buildAgentErrorIssueUrl(errorText: string, context: AgentErrorIssueContext): string {
  const title = `[Agent Error] ${context.surface}${context.agentName ? ` - ${context.agentName}` : ""}`;
  const bodyLines = [
    "## Agent Error Report",
    "",
    `- Surface: ${context.surface}`,
    `- Agent ID: ${context.agentId ?? "unknown"}`,
    `- Agent Name: ${context.agentName ?? "unknown"}`,
    `- Agent State: ${context.agentState ?? "unknown"}`,
    `- Run ID: ${context.runId ?? "n/a"}`,
    `- Task ID: ${context.taskId ?? "n/a"}`,
    `- Timestamp: ${context.timestamp ?? new Date().toISOString()}`,
    "",
    "## Error",
    "```text",
    errorText,
    "```",
  ];

  const params = new URLSearchParams({
    title,
    body: bodyLines.join("\n"),
  });

  return `${DEFAULT_ISSUE_URL}?${params.toString()}`;
}

export function AgentErrorDetailsModal({ open, onClose, errorText, issueContext }: AgentErrorDetailsModalProps) {
  const [copied, setCopied] = useState(false);
  const issueUrl = useMemo(() => buildAgentErrorIssueUrl(errorText, issueContext), [errorText, issueContext]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay open" onClick={(event) => event.target === event.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Agent error details">
      <div className="modal agent-error-modal">
        <div className="modal-header">
          <h2 className="modal-title">
            <AlertCircle size={16} />
            Agent Error Details
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="agent-error-modal__content">
          <pre className="agent-error-modal__error">{errorText}</pre>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void navigator.clipboard.writeText(errorText).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            aria-label={copied ? "Copied error to clipboard" : "Copy error to clipboard"}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <a
            className="btn btn-sm btn-warning"
            href={issueUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault();
              window.open(issueUrl, "_blank", "noopener,noreferrer");
            }}
          >
            <ExternalLink size={14} />
            Report on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}

interface AgentErrorIndicatorProps {
  errorText: string;
  issueContext: AgentErrorIssueContext;
  summaryPrefix?: string;
}

export function AgentErrorIndicator({ errorText, issueContext, summaryPrefix = "Error" }: AgentErrorIndicatorProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="agent-error-indicator" onClick={() => setOpen(true)} aria-label="Open error details">
        <AlertCircle size={14} />
        <span className="agent-error-indicator__label">{summaryPrefix}</span>
      </button>
      <AgentErrorDetailsModal open={open} onClose={() => setOpen(false)} errorText={errorText} issueContext={issueContext} />
    </>
  );
}
