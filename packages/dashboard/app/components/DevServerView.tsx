import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Monitor, Play, RotateCw, Square } from "lucide-react";
import { useDevServer } from "../hooks/useDevServer";
import type { DevServerCandidate } from "../api";
import type { ToastType } from "../hooks/useToast";

interface DevServerViewProps {
  addToast: (msg: string, type?: ToastType) => void;
  projectId?: string;
}

type PreviewMode = "embedded" | "external";

interface StatusBadgeConfig {
  className: string;
  label: string;
}

const STATUS_BADGE_CONFIG: Record<"stopped" | "starting" | "running" | "failed", StatusBadgeConfig> = {
  stopped: { className: "dev-server-status-badge--stopped", label: "Stopped" },
  starting: { className: "dev-server-status-badge--starting", label: "Starting..." },
  running: { className: "dev-server-status-badge--running", label: "Running" },
  failed: { className: "dev-server-status-badge--failed", label: "Failed" },
};

// eslint-disable-next-line no-control-regex -- ANSI escape stripping is required for readable terminal logs.
const ANSI_ESCAPE_PATTERN = new RegExp("\\u001B\\[[0-9;]*m", "g");

function sanitizeLogLine(line: string): string {
  return line.replace(ANSI_ESCAPE_PATTERN, "");
}

function candidateKey(candidate: DevServerCandidate): string {
  return `${candidate.cwd}::${candidate.scriptName}::${candidate.command}`;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DevServerView({ addToast, projectId }: DevServerViewProps) {
  const {
    candidates,
    serverState,
    logs,
    start,
    stop,
    restart,
    setPreviewUrl,
    loading,
    error,
  } = useDevServer(projectId);

  const status = serverState?.status ?? "stopped";
  const statusBadge = STATUS_BADGE_CONFIG[status] ?? STATUS_BADGE_CONFIG.stopped;
  const previewUrl = serverState?.manualPreviewUrl ?? serverState?.previewUrl ?? null;

  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [previewInput, setPreviewInput] = useState("");
  const [actionInFlight, setActionInFlight] = useState<"start" | "stop" | "restart" | "preview" | null>(null);

  const [previewMode, setPreviewMode] = useState<PreviewMode>("embedded");
  const [iframeLoading, setIframeLoading] = useState(false);
  const [iframeError, setIframeError] = useState(false);

  const iframeTimeoutRef = useRef<number | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidateKey(candidate) === selectedCandidateId) ?? null,
    [candidates, selectedCandidateId],
  );

  const renderedLogs = useMemo(() => logs.map(sanitizeLogLine), [logs]);

  const clearIframeTimeout = useCallback(() => {
    if (iframeTimeoutRef.current !== null) {
      window.clearTimeout(iframeTimeoutRef.current);
      iframeTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (candidates.length === 0) {
      setSelectedCandidateId("");
      return;
    }

    const hasSelectedCandidate = candidates.some((candidate) => candidateKey(candidate) === selectedCandidateId);
    if (hasSelectedCandidate) {
      return;
    }

    const first = candidates[0];
    setSelectedCandidateId(candidateKey(first));
    setCommandInput(first.command);
  }, [candidates, selectedCandidateId]);

  useEffect(() => {
    if (selectedCandidate) {
      setCommandInput(selectedCandidate.command);
    }
  }, [selectedCandidate]);

  useEffect(() => {
    if (serverState?.status === "running" || serverState?.status === "starting") {
      if (serverState.command.trim().length > 0) {
        setCommandInput(serverState.command);
      }
    }
  }, [serverState?.command, serverState?.status]);

  useEffect(() => {
    setPreviewInput(serverState?.manualPreviewUrl ?? "");
  }, [serverState?.manualPreviewUrl]);

  useEffect(() => {
    clearIframeTimeout();

    if (previewMode !== "embedded" || !previewUrl) {
      setIframeError(false);
      setIframeLoading(false);
      return;
    }

    setIframeError(false);
    setIframeLoading(true);

    iframeTimeoutRef.current = window.setTimeout(() => {
      setIframeLoading(false);
      setIframeError(true);
    }, 5000);

    return () => {
      clearIframeTimeout();
    };
  }, [clearIframeTimeout, previewMode, previewUrl]);

  useEffect(() => {
    const container = logContainerRef.current;
    if (!container || !stickToBottomRef.current) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [renderedLogs]);

  useEffect(() => {
    return () => {
      clearIframeTimeout();
    };
  }, [clearIframeTimeout]);

  const handleLogScroll = useCallback(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    const threshold = 24;
    const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - threshold;
    stickToBottomRef.current = nearBottom;
  }, []);

  const handleSelectCandidate = (value: string) => {
    setSelectedCandidateId(value);
    const nextCandidate = candidates.find((candidate) => candidateKey(candidate) === value);
    if (nextCandidate) {
      setCommandInput(nextCandidate.command);
    }
  };

  const openPreview = useCallback(() => {
    if (!previewUrl) {
      return;
    }
    window.open(previewUrl, "_blank", "noopener,noreferrer");
  }, [previewUrl]);

  const runAction = useCallback(async (kind: "start" | "stop" | "restart" | "preview", action: () => Promise<void>, successMessage: string) => {
    setActionInFlight(kind);
    try {
      await action();
      addToast(successMessage, "success");
    } catch (actionError) {
      addToast(normalizeError(actionError), "error");
    } finally {
      setActionInFlight(null);
    }
  }, [addToast]);

  const handleStart = () => {
    const trimmedCommand = commandInput.trim();
    if (trimmedCommand.length === 0) {
      addToast("Enter a command before starting the dev server.", "warning");
      return;
    }

    const scriptName = selectedCandidate?.scriptName ?? "custom";
    const cwd = selectedCandidate?.cwd ?? ".";

    void runAction(
      "start",
      () => {
        if (selectedCandidate && trimmedCommand === selectedCandidate.command) {
          return start(selectedCandidate);
        }
        return start({ command: trimmedCommand, scriptName, cwd });
      },
      "Dev server started.",
    );
  };

  const handleStop = () => {
    void runAction("stop", stop, "Dev server stopped.");
  };

  const handleRestart = () => {
    void runAction("restart", restart, "Dev server restarted.");
  };

  const handleSetPreview = () => {
    const trimmed = previewInput.trim();
    void runAction(
      "preview",
      () => setPreviewUrl(trimmed.length > 0 ? trimmed : null),
      trimmed.length > 0 ? "Preview URL updated." : "Preview URL override cleared.",
    );
  };

  const startDisabled = status === "starting" || status === "running" || actionInFlight !== null;
  const stopDisabled = status === "stopped" || actionInFlight !== null;
  const restartDisabled = status === "stopped" || status === "starting" || actionInFlight !== null;

  return (
    <div className="dev-server-view" data-testid="dev-server-view">
      <section className="dev-server-header" aria-label="Dev server controls header">
        <div className="dev-server-header-title">
          <Monitor size={16} />
          <h2>Dev Server</h2>
          <span
            className={`dev-server-status-badge ${statusBadge.className}`}
            data-testid="dev-server-status-badge"
          >
            {statusBadge.label}
          </span>
        </div>
        <div className="dev-server-header-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleStart}
            disabled={startDisabled}
            data-testid="dev-server-start-button"
          >
            <Play size={14} />
            <span>{actionInFlight === "start" ? "Starting..." : "Start"}</span>
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={handleStop}
            disabled={stopDisabled}
            data-testid="dev-server-stop-button"
          >
            <Square size={14} />
            <span>{actionInFlight === "stop" ? "Stopping..." : "Stop"}</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleRestart}
            disabled={restartDisabled}
            data-testid="dev-server-restart-button"
          >
            <RotateCw size={14} />
            <span>{actionInFlight === "restart" ? "Restarting..." : "Restart"}</span>
          </button>
        </div>
      </section>

      <section className="dev-server-panel dev-server-config" aria-label="Dev server configuration">
        <div className="dev-server-section-header">
          <h3>Configuration</h3>
          {loading && <span className="dev-server-muted">Loading...</span>}
        </div>

        {status === "stopped" && candidates.length > 0 && (
          <div className="dev-server-field-group">
            <label htmlFor="dev-server-candidate" className="dev-server-label">Detected scripts</label>
            <select
              id="dev-server-candidate"
              className="select"
              value={selectedCandidateId}
              onChange={(event) => handleSelectCandidate(event.target.value)}
              data-testid="dev-server-candidate-select"
            >
              {candidates.map((candidate) => (
                <option key={candidateKey(candidate)} value={candidateKey(candidate)}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {status === "stopped" && candidates.length === 0 && (
          <p className="dev-server-empty-state" data-testid="dev-server-empty-candidates">
            No dev server scripts detected. Add a <code>dev</code>, <code>start</code>, or <code>serve</code> script to your package.json.
          </p>
        )}

        <div className="dev-server-field-group">
          <label htmlFor="dev-server-command" className="dev-server-label">Command</label>
          <input
            id="dev-server-command"
            className="input"
            value={commandInput}
            onChange={(event) => setCommandInput(event.target.value)}
            placeholder="pnpm dev"
            data-testid="dev-server-command-input"
            readOnly={status === "running" || status === "starting"}
          />
        </div>

        {(status === "running" || status === "starting") && serverState && (
          <div className="dev-server-current-command" data-testid="dev-server-current-command">
            <span className="dev-server-label">Running command</span>
            <code>{serverState.command}</code>
          </div>
        )}

        {error && <p className="dev-server-error" role="alert">{error}</p>}
      </section>

      <div className="dev-server-content">
        <section className="dev-server-panel dev-server-logs-panel" data-testid="dev-server-logs-panel" aria-label="Dev server logs">
          <div className="dev-server-section-header">
            <h3>Logs</h3>
            <span className="dev-server-muted">{renderedLogs.length} lines</span>
          </div>
          <div
            className="dev-server-logs"
            ref={logContainerRef}
            onScroll={handleLogScroll}
            data-testid="dev-server-log-viewer"
          >
            {renderedLogs.length === 0 ? (
              <p className="dev-server-empty-state">No logs yet.</p>
            ) : (
              renderedLogs.map((line, index) => (
                <pre className="dev-server-log-line" key={`${index}-${line.slice(0, 24)}`}>
                  {line}
                </pre>
              ))
            )}
          </div>
        </section>

        <section className="dev-server-panel dev-server-preview" data-testid="dev-server-preview-panel" aria-label="Dev server preview">
          <div className="dev-server-section-header">
            <h3>Preview</h3>
            <div className="dev-server-preview-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPreviewMode((current) => (current === "embedded" ? "external" : "embedded"))}
                data-testid="dev-server-preview-mode-toggle"
              >
                {previewMode === "embedded" ? "External only" : "Embedded"}
              </button>
              {previewUrl && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={openPreview}
                  data-testid="dev-server-open-preview"
                >
                  <ExternalLink size={14} />
                  <span>Open in new tab</span>
                </button>
              )}
            </div>
          </div>

          <div className="dev-server-preview-url-row">
            <input
              className="input"
              value={previewInput}
              onChange={(event) => setPreviewInput(event.target.value)}
              placeholder="https://localhost:5173"
              data-testid="dev-server-preview-input"
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleSetPreview}
              disabled={actionInFlight === "preview"}
              data-testid="dev-server-set-preview"
            >
              Set
            </button>
          </div>

          {!previewUrl && (
            <p className="dev-server-empty-state">Preview URL will appear once the dev server starts.</p>
          )}

          {previewUrl && previewMode === "external" && (
            <div className="dev-server-preview-external-only" data-testid="dev-server-preview-external-only">
              <p>Embedded preview is disabled. Open the preview in a new tab.</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={openPreview}>
                Open Preview
              </button>
            </div>
          )}

          {previewUrl && previewMode === "embedded" && (
            <div className="dev-server-preview-frame-wrap">
              {!iframeError && (
                <iframe
                  title="Dev server preview"
                  src={previewUrl}
                  className="dev-server-preview-iframe"
                  data-testid="dev-server-preview-iframe"
                  onLoad={() => {
                    clearIframeTimeout();
                    setIframeLoading(false);
                    setIframeError(false);
                  }}
                  onError={() => {
                    clearIframeTimeout();
                    setIframeLoading(false);
                    setIframeError(true);
                  }}
                />
              )}

              {iframeLoading && !iframeError && (
                <div className="dev-server-preview-loading" data-testid="dev-server-preview-loading">
                  <Loader2 size={16} className="dev-server-spin" />
                  <span>Loading preview...</span>
                </div>
              )}

              {iframeError && (
                <div className="dev-server-preview-fallback" data-testid="dev-server-preview-fallback">
                  <p>
                    Preview cannot be embedded (blocked by the app's security policy). Open in a new tab instead.
                  </p>
                  <button type="button" className="btn btn-primary btn-sm" onClick={openPreview}>
                    Open Preview
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
