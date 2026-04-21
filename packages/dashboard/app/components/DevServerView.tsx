import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, Eye, Loader2, Monitor, Play, RefreshCw, RotateCw, Square } from "lucide-react";
import type { DevServerCandidate } from "../api";
import { useDevServer } from "../hooks/useDevServer";
import { useDevServerConfig } from "../hooks/useDevServerConfig";
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

const STATUS_BADGE_CONFIG: Record<"stopped" | "starting" | "running" | "failed", StatusBadgeConfig> = {
  stopped: { className: "dev-server-status-badge--stopped", label: "Stopped" },
  starting: { className: "dev-server-status-badge--starting", label: "Starting..." },
  running: { className: "dev-server-status-badge--running", label: "Running" },
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

function candidateMatchesSelection(candidate: DevServerCandidate, selectedScript: string | null, selectedSource: string | null): boolean {
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

function formatCandidateSource(candidate: DevServerCandidate): string {
  if (candidate.source === "root") {
    return "root";
  }

  if (candidate.workspaceName) {
    return `${candidate.workspaceName} · ${candidate.source}`;
  }

  return candidate.source;
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
    candidates,
    serverState,
    start,
    stop,
    restart,
    setPreviewUrl,
    loading,
    error,
    detect,
  } = useDevServer(projectId);

  const {
    config,
    loading: configLoading,
    error: configError,
    selectScript,
    clearSelection,
    setPreviewUrlOverride,
    refresh: refreshConfig,
  } = useDevServerConfig(projectId);

  const status = serverState?.status ?? "stopped";
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

  const effectivePreviewUrl = config?.previewUrlOverride ?? serverState?.manualPreviewUrl ?? serverState?.previewUrl ?? null;
  const detectedPreviewUrl = config?.detectedPreviewUrl ?? serverState?.previewUrl ?? null;
  const selectedSource = config?.selectedSource ?? null;
  const isManualPreviewOverride = Boolean(config?.previewUrlOverride ?? serverState?.manualPreviewUrl);

  const [showCandidates, setShowCandidates] = useState(true);
  const [commandInput, setCommandInput] = useState("");
  const [previewInput, setPreviewInput] = useState("");
  const [actionInFlight, setActionInFlight] = useState<"start" | "stop" | "restart" | "preview" | null>(null);

  const [previewMode, setPreviewMode] = useState<PreviewMode>("embedded");

  const previewEmbedUrl = previewMode === "embedded" ? effectivePreviewUrl : null;
  const {
    embedStatus,
    iframeRef,
    handleIframeLoad,
    handleIframeError,
    resetEmbed,
    isEmbedded,
    isBlocked,
  } = usePreviewEmbed(previewEmbedUrl);
  const isEmbedLoading = embedStatus === "loading";

  const selectedCandidate = useMemo(() => {
    if (!config?.selectedScript) {
      return null;
    }

    const selectedCwd = normalizeSourceToCwd(config.selectedSource);

    return candidates.find((candidate) => {
      if (candidate.scriptName !== config.selectedScript) {
        return false;
      }

      if (selectedCwd && candidate.cwd !== selectedCwd) {
        return false;
      }

      if (config.selectedCommand && candidate.command !== config.selectedCommand) {
        return false;
      }

      return true;
    })
      ?? candidates.find((candidate) => candidateMatchesSelection(candidate, config.selectedScript, config.selectedSource))
      ?? null;
  }, [candidates, config?.selectedCommand, config?.selectedScript, config?.selectedSource]);

  useEffect(() => {
    if (typeof detect !== "function") {
      return;
    }

    void detect().catch((detectError) => {
      addToast(normalizeError(detectError), "error");
    });
  }, [addToast, detect]);

  useEffect(() => {
    if (config?.selectedScript) {
      setShowCandidates(false);
      return;
    }

    setShowCandidates(true);
  }, [config?.selectedScript]);

  useEffect(() => {
    if (serverState?.status === "running" || serverState?.status === "starting") {
      if (serverState.command.trim().length > 0) {
        setCommandInput(serverState.command);
      }
      return;
    }

    if (selectedCandidate) {
      setCommandInput(selectedCandidate.command);
      return;
    }

    if (config?.selectedCommand) {
      setCommandInput(config.selectedCommand);
      return;
    }

    if (candidates.length > 0) {
      setCommandInput((current) => (current.trim().length > 0 ? current : candidates[0]?.command ?? ""));
    }
  }, [candidates, config?.selectedCommand, selectedCandidate, serverState?.command, serverState?.status]);

  useEffect(() => {
    setPreviewInput(config?.previewUrlOverride ?? serverState?.manualPreviewUrl ?? "");
  }, [config?.previewUrlOverride, serverState?.manualPreviewUrl]);

  const handleOpenInNewTab = useCallback(() => {
    if (!effectivePreviewUrl) {
      return;
    }

    window.open(effectivePreviewUrl, "_blank", "noopener,noreferrer");
  }, [effectivePreviewUrl]);

  const handleRefreshPreview = useCallback(() => {
    try {
      const iframeElement = iframeRef.current;
      if (iframeElement?.contentWindow) {
        iframeElement.contentWindow.location.reload();
        resetEmbed();
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
      resetEmbed();
    } catch {
      iframeRef.current.src = effectivePreviewUrl;
      resetEmbed();
    }
  }, [effectivePreviewUrl, iframeRef, resetEmbed]);

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

  const handleSelectCandidate = useCallback((candidate: DevServerCandidate) => {
    void selectScript({
      name: candidate.scriptName,
      command: candidate.command,
      source: normalizeCwdToSource(candidate.cwd),
    }).then(() => {
      setShowCandidates(false);
      setCommandInput(candidate.command);
      addToast(`Selected ${candidate.scriptName} script.`, "success");
    }).catch((selectionError) => {
      addToast(normalizeError(selectionError), "error");
    });
  }, [addToast, selectScript]);

  const handleClearSelection = useCallback(() => {
    void clearSelection().then(() => {
      setShowCandidates(true);
      addToast("Cleared selected dev server script.", "success");
    }).catch((clearError) => {
      addToast(normalizeError(clearError), "error");
    });
  }, [addToast, clearSelection]);

  const handleStart = () => {
    const trimmedCommand = commandInput.trim();
    if (trimmedCommand.length === 0) {
      addToast("Enter a command before starting the dev server.", "warning");
      return;
    }

    const fallbackCwd = normalizeSourceToCwd(config?.selectedSource) ?? ".";
    const scriptName = selectedCandidate?.scriptName ?? config?.selectedScript ?? "custom";
    const cwd = selectedCandidate?.cwd ?? fallbackCwd;

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
    const nextUrl = trimmed.length > 0 ? trimmed : null;

    void runAction(
      "preview",
      async () => {
        await setPreviewUrlOverride(nextUrl);
        await setPreviewUrl(nextUrl);
      },
      nextUrl ? "Preview URL updated." : "Preview URL override cleared.",
    );
  };

  const handleRetry = useCallback(() => {
    if (!configError && error) {
      window.location.reload();
      return;
    }

    void refreshConfig();
  }, [configError, error, refreshConfig]);

  const isLoading = loading || configLoading;
  const combinedError = configError ?? error;

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

        {isLoading && !config && candidates.length === 0 && (
          <div className="dev-server-loading-state" data-testid="dev-server-loading-state">
            <Loader2 size={16} className="dev-server-spin" />
            <span>Loading dev server configuration...</span>
          </div>
        )}

        {combinedError && (
          <div className="dev-server-error-box" role="alert" data-testid="dev-server-error-box">
            <p>{combinedError}</p>
            <button type="button" className="btn btn-sm" onClick={handleRetry}>Retry</button>
          </div>
        )}

        <div className="dev-server-section">
          <h3>Script Selection</h3>

          {config?.selectedScript && (
            <div className="dev-server-selected" data-testid="dev-server-selected-summary">
              <span className="dev-server-candidate-name">{config.selectedScript}</span>
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

          {showCandidates && candidates.length === 0 && (
            <p className="dev-server-empty-state" data-testid="dev-server-empty-candidates">
              No dev server scripts detected. Check that your project has a <code>package.json</code> with a <code>dev</code>, <code>start</code>, or similar script.
            </p>
          )}

          {showCandidates && candidates.length > 0 && (
            <div className="dev-server-candidates" data-testid="dev-server-candidates">
              {candidates.map((candidate) => {
                const isSelected = candidateMatchesSelection(candidate, config?.selectedScript ?? null, selectedSource);
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

        {(status === "running" || status === "starting") && serverState && (
          <div className="dev-server-current-command" data-testid="dev-server-current-command">
            <span className="dev-server-label">Running command</span>
            <code>{serverState.command}</code>
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

        {detectedPreviewUrl && (
          <p className="dev-server-preview-hint">Auto-detected: {detectedPreviewUrl}</p>
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

            {effectivePreviewUrl && previewMode === "embedded" && isBlocked && (
              <div className="devserver-preview-fallback" data-testid="devserver-preview-fallback" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <p>Preview cannot be embedded here. The server may be blocking iframe embedding.</p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm touch-target"
                  onClick={handleOpenInNewTab}
                  data-testid="devserver-preview-fallback-open-tab"
                >
                  Open in new tab
                </button>
                <span className="devserver-preview-fallback-hint">Click to view your app in a separate browser tab.</span>
              </div>
            )}

            {effectivePreviewUrl && previewMode === "embedded" && !isBlocked && (
              <>
                <PreviewIframe
                  url={effectivePreviewUrl}
                  iframeRef={iframeRef}
                  onLoad={handleIframeLoad}
                  onError={handleIframeError}
                />
                {isEmbedLoading && (
                  <div className="devserver-preview-overlay" data-testid="devserver-preview-loading">
                    <Loader2 size={16} className="dev-server-spin" />
                    <span>Loading preview…</span>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
