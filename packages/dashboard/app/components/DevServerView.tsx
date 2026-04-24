import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Eye, Loader2, Monitor, Play, RefreshCw, RotateCw, ShieldAlert, Square } from "lucide-react";
import type { DetectedDevServerCommand } from "../api";
import { useDevServer } from "../hooks/useDevServer";
import { useDevServerLogs } from "../hooks/useDevServerLogs";
import { usePreviewEmbed } from "../hooks/usePreviewEmbed";
import type { ToastType } from "../hooks/useToast";
import { DevServerLogViewer } from "./DevServerLogViewer";
import { PreviewIframe } from "./PreviewIframe";

interface DevServerViewProps {
  addToast: (msg: string, type?: ToastType) => void;
  projectId?: string;
}

type PreviewMode = "embedded" | "external";

interface StatusBadgeConfig {
  className: string;
  label: string;
}

const STATUS_BADGE_CONFIG: Record<"stopped" | "starting" | "running" | "failed" | "stopping", StatusBadgeConfig> = {
  stopped: { className: "dev-server-status-badge--stopped", label: "Stopped" },
  starting: { className: "dev-server-status-badge--starting", label: "Starting..." },
  running: { className: "dev-server-status-badge--running", label: "Running" },
  stopping: { className: "dev-server-status-badge--starting", label: "Stopping..." },
  failed: { className: "dev-server-status-badge--failed", label: "Failed" },
};

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCwdToSource(cwd: string): string {
  return cwd === "." ? "root" : cwd;
}

function normalizeSourceToCwd(source: string | null | undefined): string | null {
  if (!source) {
    return null;
  }
  return source === "root" ? "." : source;
}

function candidateMatchesSelection(candidate: DetectedDevServerCommand, selectedScript: string | null, selectedSource: string | null): boolean {
  if (!selectedScript) {
    return false;
  }

  if (candidate.scriptName !== selectedScript) {
    return false;
  }

  if (!selectedSource) {
    return true;
  }

  return normalizeCwdToSource(candidate.cwd) === selectedSource;
}

function formatCandidateSource(candidate: DetectedDevServerCommand): string {
  // DetectedDevServerCommand doesn't have source/workspaceName, so use cwd-based approach
  if (candidate.cwd === ".") {
    return "root";
  }

  return candidate.cwd;
}

function truncateCommand(command: string): string {
  const maxLength = 60;
  if (command.length <= maxLength) {
    return command;
  }

  return `${command.slice(0, maxLength)}…`;
}

export function DevServerView({ addToast, projectId }: DevServerViewProps) {
  const {
    session,
    detectedCommands,
    previewUrl,
    isLoading,
    error,
    startServer,
    stopServer,
    restartServer,
    setPreviewUrl,
    detectCommands,
    refresh,
  } = useDevServer(projectId);

  const status = session?.status ?? "stopped";
  const isRunning = status === "running" || status === "starting";
  const statusBadge = STATUS_BADGE_CONFIG[status] ?? STATUS_BADGE_CONFIG.stopped;

  const {
    entries: logEntries,
    loading: logsLoading,
    loadingMore: logsLoadingMore,
    hasMore: logsHasMore,
    total: logsTotal,
    loadMore: loadMoreLogs,
  } = useDevServerLogs(projectId, Boolean(projectId));

  const effectivePreviewUrl = previewUrl;
  const selectedSource = session?.config?.cwd ?? null;

  const [showCandidates, setShowCandidates] = useState(true);
  const [commandInput, setCommandInput] = useState("");
  const [previewInput, setPreviewInput] = useState("");
  const [selectedScript, setSelectedScript] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<"start" | "stop" | "restart" | "preview" | null>(null);

  const [previewMode, setPreviewMode] = useState<PreviewMode>("embedded");

  const previewEmbedUrl = previewMode === "embedded" ? effectivePreviewUrl : null;
  const {
    embedStatus,
    setEmbedStatus,
    resetEmbedStatus,
    iframeRef,
    isEmbedded,
    isBlocked,
    blockReason,
    retry,
  } = usePreviewEmbed(previewEmbedUrl);

  const [showFallback, setShowFallback] = useState(false);
  const prevStatusRef = useRef(embedStatus);

  useEffect(() => {
    const hasTransitioned = prevStatusRef.current !== embedStatus;

    if (isBlocked && hasTransitioned) {
      setShowFallback(true);
    }

    if (embedStatus === "embedded") {
      setShowFallback(false);
    }

    prevStatusRef.current = embedStatus;
  }, [embedStatus, isBlocked]);

  useEffect(() => {
    setShowFallback(false);
  }, [effectivePreviewUrl]);

  const selectedCandidate = useMemo(() => {
    if (!selectedScript) {
      return null;
    }

    const selectedCwd = normalizeSourceToCwd(selectedSource);

    return detectedCommands.find((candidate) => {
      if (candidate.scriptName !== selectedScript) {
        return false;
      }

      if (selectedCwd && candidate.cwd !== selectedCwd) {
        return false;
      }

      if (session?.config?.command && candidate.command !== session.config.command) {
        return false;
      }

      return true;
    })
      ?? detectedCommands.find((candidate) => candidateMatchesSelection(candidate, selectedScript, selectedSource))
      ?? null;
  }, [detectedCommands, session?.config?.command, selectedScript, selectedSource]);

  useEffect(() => {
    if (typeof detectCommands !== "function") {
      return;
    }

    void detectCommands().catch((detectError: unknown) => {
      addToast(normalizeError(detectError), "error");
    });
  }, [addToast, detectCommands]);

  useEffect(() => {
    if (selectedScript) {
      setShowCandidates(false);
      return;
    }

    setShowCandidates(true);
  }, [selectedScript]);

  useEffect(() => {
    if (session?.status === "running" || session?.status === "starting") {
      if (session.config?.command?.trim().length > 0) {
        setCommandInput(session.config.command);
      }
      return;
    }

    if (selectedCandidate) {
      setCommandInput(selectedCandidate.command);
      return;
    }

    if (detectedCommands.length > 0) {
      setCommandInput((current) => (current.trim().length > 0 ? current : detectedCommands[0]?.command ?? ""));
    }
  }, [detectedCommands, selectedCandidate, session?.config?.command, session?.status]);

  useEffect(() => {
    setPreviewInput(effectivePreviewUrl ?? "");
  }, [effectivePreviewUrl]);

  const handleOpenInNewTab = useCallback(() => {
    if (!effectivePreviewUrl) {
      return;
    }

    window.open(effectivePreviewUrl, "_blank", "noopener,noreferrer");
  }, [effectivePreviewUrl]);

  const handleRetryEmbeddedPreview = useCallback(() => {
    setShowFallback(false);
    retry();
  }, [retry]);

  const handleRefreshPreview = useCallback(() => {
    try {
      const iframeElement = iframeRef.current;
      if (iframeElement?.contentWindow) {
        iframeElement.contentWindow.location.reload();
        setShowFallback(false);
        resetEmbedStatus();
        return;
      }
    } catch {
      // Cross-origin reload access can throw. Fall through to cache-buster reload.
    }

    if (!effectivePreviewUrl || !iframeRef.current) {
      return;
    }

    try {
      const refreshedUrl = new URL(effectivePreviewUrl);
      refreshedUrl.searchParams.set("_t", Date.now().toString());
      iframeRef.current.src = refreshedUrl.toString();
      setShowFallback(false);
      resetEmbedStatus();
    } catch {
      iframeRef.current.src = effectivePreviewUrl;
      setShowFallback(false);
      resetEmbedStatus();
    }
  }, [effectivePreviewUrl, iframeRef, resetEmbedStatus]);

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

  const handleSelectCandidate = useCallback((candidate: DetectedDevServerCommand) => {
    setSelectedScript(candidate.scriptName);
    setShowCandidates(false);
    setCommandInput(candidate.command);
    addToast(`Selected ${candidate.scriptName} script.`, "success");
  }, [addToast]);

  const handleClearSelection = useCallback(() => {
    setSelectedScript(null);
    setShowCandidates(true);
    addToast("Cleared selected dev server script.", "success");
  }, [addToast]);

  const handleStart = () => {
    const trimmedCommand = commandInput.trim();
    if (trimmedCommand.length === 0) {
      addToast("Enter a command before starting the dev server.", "warning");
      return;
    }

    const fallbackCwd = normalizeSourceToCwd(selectedSource) ?? ".";
    const cwd = selectedCandidate?.cwd ?? fallbackCwd;

    void runAction(
      "start",
      () => startServer(trimmedCommand, cwd),
      "Dev server started.",
    );
  };

  const handleStop = () => {
    void runAction("stop", stopServer, "Dev server stopped.");
  };

  const handleRestart = () => {
    void runAction("restart", restartServer, "Dev server restarted.");
  };

  const handleSetPreview = () => {
    const trimmed = previewInput.trim();
    const nextUrl = trimmed.length > 0 ? trimmed : null;

    void runAction(
      "preview",
      () => setPreviewUrl(nextUrl),
      nextUrl ? "Preview URL updated." : "Preview URL override cleared.",
    );
  };

  const handleRetry = useCallback(() => {
    if (error) {
      void refresh();
    }
  }, [error, refresh]);

  const isManualPreviewOverride = false; // With session model, previewUrl is always auto-detected

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
          {isLoading && <span className="dev-server-muted">Loading...</span>}
        </div>

        {isLoading && !session && detectedCommands.length === 0 && (
          <div className="dev-server-loading-state" data-testid="dev-server-loading-state">
            <Loader2 size={16} className="dev-server-spin" />
            <span>Loading dev server configuration...</span>
          </div>
        )}

        {error && (
          <div className="dev-server-error-box" role="alert" data-testid="dev-server-error-box">
            <p>{error}</p>
            <button type="button" className="btn btn-sm" onClick={handleRetry}>Retry</button>
          </div>
        )}

        <div className="dev-server-section">
          <h3>Script Selection</h3>

          {selectedScript && (
            <div className="dev-server-selected" data-testid="dev-server-selected-summary">
              <span className="dev-server-candidate-name">{selectedScript}</span>
              <span className="dev-server-candidate-source">{selectedSource ?? "root"}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowCandidates(true)}
                data-testid="dev-server-change-selection"
              >
                Change
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleClearSelection}
                data-testid="dev-server-clear-selection"
              >
                Clear
              </button>
            </div>
          )}

          {showCandidates && detectedCommands.length === 0 && (
            <p className="dev-server-empty-state" data-testid="dev-server-empty-candidates">
              No dev server scripts detected. Check that your project has a <code>package.json</code> with a <code>dev</code>, <code>start</code>, or similar script.
            </p>
          )}

          {showCandidates && detectedCommands.length > 0 && (
            <div className="dev-server-candidates" data-testid="dev-server-candidates">
              {detectedCommands.map((candidate) => {
                const isSelected = candidateMatchesSelection(candidate, selectedScript, selectedSource);
                return (
                  <button
                    type="button"
                    key={`${candidate.cwd}::${candidate.scriptName}::${candidate.command}`}
                    className={`dev-server-candidate ${isSelected ? "dev-server-candidate--selected" : ""}`}
                    onClick={() => handleSelectCandidate(candidate)}
                    data-testid={`dev-server-candidate-${candidate.scriptName}-${normalizeCwdToSource(candidate.cwd)}`}
                  >
                    <span className="dev-server-candidate-name">{candidate.scriptName}</span>
                    <span className="dev-server-candidate-command">{truncateCommand(candidate.command)}</span>
                    <span className="dev-server-candidate-source">{formatCandidateSource(candidate)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

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

        {(status === "running" || status === "starting") && session && (
          <div className="dev-server-current-command" data-testid="dev-server-current-command">
            <span className="dev-server-label">Running command</span>
            <code>{session.config?.command ?? commandInput}</code>
          </div>
        )}

        <div className="dev-server-preview-override">
          <label htmlFor="dev-server-preview-input" className="dev-server-label">Preview URL Override</label>
          <input
            id="dev-server-preview-input"
            className="input"
            type="url"
            value={previewInput}
            onChange={(event) => setPreviewInput(event.target.value)}
            placeholder="http://localhost:3000"
            data-testid="dev-server-preview-input"
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSetPreview}
            disabled={actionInFlight === "preview"}
            data-testid="dev-server-set-preview"
          >
            Save
          </button>
        </div>

        {effectivePreviewUrl && (
          <p className="dev-server-preview-hint">Auto-detected: {effectivePreviewUrl}</p>
        )}
      </section>

      <div className="dev-server-content">
        <section className="dev-server-panel dev-server-logs-panel" data-testid="dev-server-logs-panel" aria-label="Dev server logs">
          <div className="dev-server-section-header">
            <h3>Logs</h3>
            <span className="dev-server-muted">{logsTotal ?? logEntries.length} lines</span>
          </div>
          <div className="dev-server-logs-viewer" data-testid="dev-server-log-viewer">
            <DevServerLogViewer
              entries={logEntries}
              loading={logsLoading}
              loadingMore={logsLoadingMore}
              hasMore={logsHasMore}
              total={logsTotal}
              onLoadMore={loadMoreLogs}
              isRunning={isRunning}
            />
          </div>
        </section>

        <section className="dev-server-panel devserver-preview-panel" data-testid="devserver-preview-panel" aria-label="Dev server preview">
          <div className="devserver-preview-header">
            <div className="devserver-preview-title">
              <Eye size={14} />
              <span>Preview</span>
            </div>
            <span
              className={`devserver-preview-url-badge ${isManualPreviewOverride ? "devserver-preview-url-badge--manual" : "devserver-preview-url-badge--auto"}`}
              title={effectivePreviewUrl ?? "No preview URL"}
              data-testid="devserver-preview-url-badge"
            >
              {isManualPreviewOverride ? "Manual" : "Auto"}
              {effectivePreviewUrl ? ` · ${effectivePreviewUrl}` : " · Not available"}
            </span>
            <div className="devserver-preview-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPreviewMode((current) => (current === "embedded" ? "external" : "embedded"))}
                data-testid="devserver-preview-mode-toggle"
              >
                {previewMode === "embedded" ? "External only" : "Embedded"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title="Open in new tab"
                onClick={handleOpenInNewTab}
                disabled={!effectivePreviewUrl}
                data-testid="devserver-preview-open-tab"
              >
                <ExternalLink size={14} />
              </button>
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title="Refresh preview"
                onClick={handleRefreshPreview}
                disabled={!effectivePreviewUrl}
                data-testid="devserver-preview-refresh"
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          <div className="devserver-preview-container" data-embed-status={embedStatus} data-embedded={isEmbedded ? "true" : "false"}>
            {!effectivePreviewUrl && !isRunning && (
              <p className="devserver-preview-empty">Start a dev server to see a live preview here.</p>
            )}

            {!effectivePreviewUrl && isRunning && (
              <p className="devserver-preview-empty">No preview URL detected. Start the dev server or set a manual URL to preview your app.</p>
            )}

            {effectivePreviewUrl && previewMode === "external" && (
              <div className="devserver-preview-external-only" data-testid="devserver-preview-external-only">
                <p>Embedded preview is disabled. Open your app in a separate browser tab.</p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm touch-target"
                  onClick={handleOpenInNewTab}
                  data-testid="devserver-preview-external-open-tab"
                >
                  Open in new tab
                </button>
              </div>
            )}

            {effectivePreviewUrl && previewMode === "embedded" && showFallback && isBlocked && (
              <div
                className={embedStatus === "error" ? "devserver-preview-error-panel" : "devserver-preview-blocked-panel"}
                data-testid="devserver-preview-fallback"
                role="alert"
              >
                {embedStatus === "error"
                  ? <AlertTriangle className="devserver-preview-blocked-icon" aria-hidden="true" />
                  : <ShieldAlert className="devserver-preview-blocked-icon" aria-hidden="true" />}
                <div>
                  <p className="devserver-preview-blocked-title">
                    {embedStatus === "error" ? "Preview failed" : "Preview blocked"}
                  </p>
                  {blockReason && <p className="devserver-preview-blocked-context">{blockReason}</p>}
                </div>
                <p className="devserver-preview-blocked-description">
                  Open the preview in a new tab, or retry embedded mode after checking your server settings.
                </p>
                <div className="devserver-preview-blocked-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleOpenInNewTab}
                    data-testid="devserver-preview-fallback-open-tab"
                  >
                    Open preview in new tab
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={handleRetryEmbeddedPreview}
                    data-testid="devserver-preview-fallback-retry"
                  >
                    Retry embedded preview
                  </button>
                </div>
              </div>
            )}

            {effectivePreviewUrl && previewMode === "embedded" && !showFallback && (
              <PreviewIframe
                url={effectivePreviewUrl}
                embedStatus={embedStatus}
                onEmbedStatusChange={setEmbedStatus}
                iframeRef={iframeRef}
                blockReason={blockReason}
                onRetry={handleRetryEmbeddedPreview}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
