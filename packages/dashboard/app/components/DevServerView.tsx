import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ExternalLink, Eye, Loader2, Monitor, Play, RefreshCw, RotateCw, ShieldAlert, Square, X } from "lucide-react";
import type { Task, TaskDetail } from "@fusion/core";
import "./DevServerView.css";
import type { DetectedDevServerCommand } from "../api";
import { useDevServer } from "../hooks/useDevServer";
import { useDevServerLogs } from "../hooks/useDevServerLogs";
import { usePreviewEmbed } from "../hooks/usePreviewEmbed";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import type { ToastType } from "../hooks/useToast";
import { DevServerLogViewer } from "./DevServerLogViewer";
import { PreviewIframe } from "./PreviewIframe";
import { recordResumeEvent } from "../utils/resumeInstrumentation";
import { ViewHeader } from "./ViewHeader";

interface DevServerViewProps {
  addToast: (msg: string, type?: ToastType) => void;
  projectId?: string;
  tasks?: Array<Task | TaskDetail>;
}

type PreviewMode = "embedded" | "external";

interface StatusBadgeConfig {
  className: string;
  label: string;
}

function getStatusBadgeConfig(t: TFunction<"app">): Record<"stopped" | "starting" | "running" | "failed" | "stopping", StatusBadgeConfig> {
  return {
    stopped: { className: "dev-server-status-badge--stopped", label: t("devserver.status.stopped", "Stopped") },
    starting: { className: "dev-server-status-badge--starting", label: t("devserver.status.starting", "Starting...") },
    running: { className: "dev-server-status-badge--running", label: t("devserver.status.running", "Running") },
    stopping: { className: "dev-server-status-badge--starting", label: t("devserver.status.stopping", "Stopping...") },
    failed: { className: "dev-server-status-badge--failed", label: t("devserver.status.failed", "Failed") },
  };
}


const NARROW_RIGHT_DOCK_PREVIEW_THRESHOLD = 480;

function isTrueMobileViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(max-width: 768px)").matches;
}

function getDirectRightDockBodyHost(element: HTMLElement): HTMLElement | null {
  if (element.closest(".right-dock-expand-modal__body")) {
    return null;
  }

  const parent = element.parentElement;
  if (!parent?.classList.contains("right-dock__body")) {
    return null;
  }

  return parent;
}

function readHostInlineSize(host: HTMLElement): number {
  if (host.clientWidth > 0) {
    return host.clientWidth;
  }

  const rect = host.getBoundingClientRect();
  return rect.width;
}

function shouldUseNarrowRightDockPreviewMode(root: HTMLElement | null): boolean {
  if (!root || isTrueMobileViewport()) {
    return false;
  }

  const host = getDirectRightDockBodyHost(root);
  if (!host) {
    return false;
  }

  return readHostInlineSize(host) <= NARROW_RIGHT_DOCK_PREVIEW_THRESHOLD;
}

function useNarrowRightDockPreviewMode(rootRef: RefObject<HTMLDivElement | null>): boolean {
  const [isNarrowRightDockPreviewMode, setIsNarrowRightDockPreviewMode] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      setIsNarrowRightDockPreviewMode(false);
      return;
    }

    const host = getDirectRightDockBodyHost(root);
    const updateMode = () => setIsNarrowRightDockPreviewMode(shouldUseNarrowRightDockPreviewMode(root));

    updateMode();

    if (!host || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateMode);
      return () => window.removeEventListener("resize", updateMode);
    }

    const observer = new ResizeObserver(updateMode);
    observer.observe(host);
    window.addEventListener("resize", updateMode);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateMode);
    };
  }, [rootRef]);

  return isNarrowRightDockPreviewMode;
}

let devServerViewWasPreviouslyInactive = false;

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

export function DevServerView({ addToast, projectId, tasks }: DevServerViewProps) {
  const { t } = useTranslation("app");

  useEffect(() => {
    recordResumeEvent({
      view: "DevServerView",
      trigger: devServerViewWasPreviouslyInactive ? "route-active" : "remount",
      projectId,
      replayAttempted: false,
    });
    devServerViewWasPreviouslyInactive = false;

    return () => {
      devServerViewWasPreviouslyInactive = true;
      recordResumeEvent({
        view: "DevServerView",
        trigger: "route-inactive",
        projectId,
        replayAttempted: false,
      });
    };
  }, [projectId]);

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
  const statusBadgeConfig = getStatusBadgeConfig(t);
  const statusBadge = statusBadgeConfig[status] ?? statusBadgeConfig.stopped;

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

  const rootRef = useRef<HTMLDivElement>(null);
  const isNarrowRightDockPreviewMode = useNarrowRightDockPreviewMode(rootRef);

  /*
  FNXC:DevServer 2026-06-23-00:00:
  The Dev Server preview must escape into a modal when the direct right-dock host is very narrow so preview chrome does not crowd logs and configuration in the same dock column.
  The 480px threshold catches the dock's compact range before preview chrome becomes unusable while preserving full-page, true mobile viewport, and expanded pop-out inline previews.
  */
  const [showCandidates, setShowCandidates] = useState(true);
  const [commandInput, setCommandInput] = useState("");
  const [previewInput, setPreviewInput] = useState("");
  const [selectedScript, setSelectedScript] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<"start" | "stop" | "restart" | "preview" | null>(null);

  /*
  FNXC:DevServer 2026-06-23-00:00:
  The board and right dock pass live task data into DevServerView so the dev server can target the checked-out worktree of an executing task instead of only the integration worktree.
  Only in-progress tasks with concrete worktree paths are targetable because a missing cwd cannot be safely passed to the start endpoint.
  */
  const executingTasks = useMemo(
    () => (tasks ?? []).filter((task) => task.column === "in-progress" && typeof task.worktree === "string" && task.worktree.length > 0),
    [tasks],
  );
  const selectedTask = useMemo(
    () => executingTasks.find((task) => task.id === selectedTaskId) ?? null,
    [executingTasks, selectedTaskId],
  );

  useEffect(() => {
    if (selectedTaskId && !executingTasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }, [executingTasks, selectedTaskId]);

  const [previewMode, setPreviewMode] = useState<PreviewMode>("embedded");
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const previewModalLauncherRef = useRef<HTMLButtonElement>(null);
  const previewModalRef = useRef<HTMLDivElement>(null);

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

  const closePreviewModal = useCallback(() => {
    setIsPreviewModalOpen(false);
    window.requestAnimationFrame(() => previewModalLauncherRef.current?.focus());
  }, []);
  const previewModalOverlayDismissProps = useOverlayDismiss(closePreviewModal);

  useEffect(() => {
    if (!isPreviewModalOpen) {
      return;
    }

    previewModalRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePreviewModal();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = Array.from(
        previewModalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");

      const firstElement = focusableElements[0];
      const lastElement = focusableElements.at(-1);
      if (!firstElement || !lastElement) {
        return;
      }

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePreviewModal, isPreviewModalOpen]);

  useEffect(() => {
    if (!isNarrowRightDockPreviewMode && isPreviewModalOpen) {
      setIsPreviewModalOpen(false);
    }
  }, [isNarrowRightDockPreviewMode, isPreviewModalOpen]);

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
    addToast(t("devserver.toast.selectedScript", "Selected {{name}} script.", { name: candidate.scriptName }), "success");
  }, [addToast]);

  const handleClearSelection = useCallback(() => {
    setSelectedScript(null);
    setShowCandidates(true);
    addToast(t("devserver.toast.clearedScript", "Cleared selected dev server script."), "success");
  }, [addToast]);

  const handleTaskSelectionChange = useCallback((nextTaskId: string | null) => {
    if (isRunning && nextTaskId && nextTaskId !== selectedTaskId) {
      addToast(t("devserver.restartToApplyTask", "Restart the dev server to apply the selected task's worktree."), "info");
    }
    setSelectedTaskId(nextTaskId);
  }, [addToast, isRunning, selectedTaskId, t]);

  const handleStart = () => {
    const trimmedCommand = commandInput.trim();
    if (trimmedCommand.length === 0) {
      addToast(t("devserver.toast.enterCommand", "Enter a command before starting the dev server."), "warning");
      return;
    }

    const fallbackCwd = normalizeSourceToCwd(selectedSource) ?? ".";
    /*
    FNXC:DevServer 2026-06-23-00:00:
    A selected executing task's worktree takes precedence over the detected script cwd so the preview process reflects in-progress task work instead of the integration branch.
    */
    const targetedCwd = selectedTask?.worktree ?? null;
    const cwd = targetedCwd ?? selectedCandidate?.cwd ?? fallbackCwd;

    void runAction(
      "start",
      () => startServer(trimmedCommand, cwd),
      t("devserver.toast.started", "Dev server started."),
    );
  };

  const handleStop = () => {
    void runAction("stop", stopServer, t("devserver.toast.stopped", "Dev server stopped."));
  };

  const handleRestart = () => {
    void runAction("restart", restartServer, t("devserver.toast.restarted", "Dev server restarted."));
  };

  const handleSetPreview = () => {
    const trimmed = previewInput.trim();
    const nextUrl = trimmed.length > 0 ? trimmed : null;

    void runAction(
      "preview",
      () => setPreviewUrl(nextUrl),
      nextUrl ? t("devserver.toast.previewUpdated", "Preview URL updated.") : t("devserver.toast.previewCleared", "Preview URL override cleared."),
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

  const renderPreviewContent = () => (
    <>
      <div className="devserver-preview-header">
        <div className="devserver-preview-title">
          <Eye size={14} />
          <span>{t("devserver.preview", "Preview")}</span>
        </div>
        <span
          className={`devserver-preview-url-badge ${isManualPreviewOverride ? "devserver-preview-url-badge--manual" : "devserver-preview-url-badge--auto"}`}
          title={effectivePreviewUrl ?? t("devserver.noPreviewUrl", "No preview URL")}
          data-testid="devserver-preview-url-badge"
        >
          {isManualPreviewOverride ? t("devserver.manual", "Manual") : t("devserver.auto", "Auto")}
          {effectivePreviewUrl ? ` · ${effectivePreviewUrl}` : t("devserver.notAvailable", " · Not available")}
        </span>
        <div className="devserver-preview-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setPreviewMode((current) => (current === "embedded" ? "external" : "embedded"))}
            data-testid="devserver-preview-mode-toggle"
          >
            {previewMode === "embedded" ? t("devserver.externalOnly", "External only") : t("devserver.embedded", "Embedded")}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            title={t("devserver.openInNewTab", "Open in new tab")}
            onClick={handleOpenInNewTab}
            disabled={!effectivePreviewUrl}
            data-testid="devserver-preview-open-tab"
          >
            <ExternalLink />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            title={t("devserver.refreshPreview", "Refresh preview")}
            onClick={handleRefreshPreview}
            disabled={!effectivePreviewUrl}
            data-testid="devserver-preview-refresh"
          >
            <RefreshCw />
          </button>
        </div>
      </div>

      <div className="devserver-preview-container" data-embed-status={embedStatus} data-embedded={isEmbedded ? "true" : "false"}>
        {!effectivePreviewUrl && !isRunning && (
          <p className="devserver-preview-empty">{t("devserver.startDevServer", "Start a dev server to see a live preview here.")}</p>
        )}

        {!effectivePreviewUrl && isRunning && (
          <p className="devserver-preview-empty">{t("devserver.noPreviewDetected", "No preview URL detected. Start the dev server or set a manual URL to preview your app.")}</p>
        )}

        {effectivePreviewUrl && previewMode === "external" && (
          <div className="devserver-preview-external-only" data-testid="devserver-preview-external-only">
            <p>{t("devserver.embeddedPreviewDisabled", "Embedded preview is disabled. Open your app in a separate browser tab.")}</p>
            <button
              type="button"
              className="btn btn-primary btn-sm touch-target"
              onClick={handleOpenInNewTab}
              data-testid="devserver-preview-external-open-tab"
            >
              {t("devserver.openInNewTab", "Open in new tab")}
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
                {embedStatus === "error" ? t("devserver.previewFailed", "Preview failed") : t("devserver.previewBlocked", "Preview blocked")}
              </p>
              {blockReason && <p className="devserver-preview-blocked-context">{blockReason}</p>}
            </div>
            <p className="devserver-preview-blocked-description">
              {t("devserver.openPreviewOrRetry", "Open the preview in a new tab, or retry embedded mode after checking your server settings.")}
            </p>
            <div className="devserver-preview-blocked-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleOpenInNewTab}
                data-testid="devserver-preview-fallback-open-tab"
              >
                {t("devserver.openPreviewInNewTab", "Open preview in new tab")}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleRetryEmbeddedPreview}
                data-testid="devserver-preview-fallback-retry"
              >
                {t("devserver.retryEmbeddedPreview", "Retry embedded preview")}
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
    </>
  );

  return (
    <div
      ref={rootRef}
      className="dev-server-view"
      data-testid="dev-server-view"
      data-narrow-right-dock-preview={isNarrowRightDockPreviewMode ? "true" : "false"}
    >
      {/*
      FNXC:DevServer 2026-06-22-01:00:
      Migrated to the shared ViewHeader for cross-view consistency. The status badge sits next to the title inside the actions slot (wrapped in .dev-server-header-title so the existing mobile flex-wrap rule still applies), and the Start/Stop/Restart controls follow in .dev-server-header-actions. ViewHeader supplies the standard view padding; the view body must not repeat the top padding.
      */}
      <ViewHeader
        icon={Monitor}
        title={t("devserver.title", "Dev Server")}
        actions={(
          <>
            <span className="dev-server-header-title">
              <span
                className={`dev-server-status-badge ${statusBadge.className}`}
                data-testid="dev-server-status-badge"
              >
                {statusBadge.label}
              </span>
            </span>
            <div className="dev-server-header-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleStart}
                disabled={startDisabled}
                data-testid="dev-server-start-button"
              >
                <Play size={14} />
                <span>{actionInFlight === "start" ? t("devserver.starting", "Starting...") : t("devserver.start", "Start")}</span>
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleStop}
                disabled={stopDisabled}
                data-testid="dev-server-stop-button"
              >
                <Square size={14} />
                <span>{actionInFlight === "stop" ? t("devserver.stopping", "Stopping...") : t("devserver.stop", "Stop")}</span>
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleRestart}
                disabled={restartDisabled}
                data-testid="dev-server-restart-button"
              >
                <RotateCw size={14} />
                <span>{actionInFlight === "restart" ? t("devserver.restarting", "Restarting...") : t("devserver.restart", "Restart")}</span>
              </button>
            </div>
          </>
        )}
      />

      <section className="dev-server-panel dev-server-config" aria-label={t("devserver.configurationLabel", "Dev server configuration")}>
        <div className="dev-server-section-header">
          <h3>{t("devserver.configuration", "Configuration")}</h3>
          {isLoading && <span className="dev-server-muted">{t("devserver.loading", "Loading...")}</span>}
        </div>

        {isLoading && !session && detectedCommands.length === 0 && (
          <div className="dev-server-loading-state" data-testid="dev-server-loading-state">
            <Loader2 size={16} className="dev-server-spin" />
            <span>{t("devserver.loadingConfig", "Loading dev server configuration...")}</span>
          </div>
        )}

        {error && (
          <div className="dev-server-error-box" role="alert" data-testid="dev-server-error-box">
            <p>{error}</p>
            <button type="button" className="btn btn-sm" onClick={handleRetry}>{t("devserver.retry", "Retry")}</button>
          </div>
        )}

        <div className="dev-server-section">
          <h3>{t("devserver.scriptSelection", "Script Selection")}</h3>

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
                {t("devserver.change", "Change")}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleClearSelection}
                data-testid="dev-server-clear-selection"
              >
                {t("devserver.clear", "Clear")}
              </button>
            </div>
          )}

          {showCandidates && detectedCommands.length === 0 && (
            <p className="dev-server-empty-state" data-testid="dev-server-empty-candidates">
              {t("devserver.noScriptsDetected", "No dev server scripts detected. Check that your project has a package.json with a dev, start, or similar script.")}
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

        <div className="dev-server-section dev-server-executing-task-section">
          <h3>{t("devserver.executingTask", "Executing Task")}</h3>
          <div className="dev-server-field-group">
            <label htmlFor="dev-server-task-picker" className="dev-server-label">{t("devserver.executingTask", "Executing Task")}</label>
            <select
              id="dev-server-task-picker"
              className="input dev-server-task-picker"
              value={selectedTaskId ?? ""}
              onChange={(event) => handleTaskSelectionChange(event.target.value.length > 0 ? event.target.value : null)}
              disabled={executingTasks.length === 0}
              aria-label={t("devserver.executingTask", "Executing Task")}
              data-testid="dev-server-task-picker"
            >
              <option value="">{t("devserver.projectRootNoTask", "Project root (no task)")}</option>
              {executingTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title ? `${task.id} — ${task.title}` : task.id}
                </option>
              ))}
            </select>
            {executingTasks.length === 0 && (
              <p className="dev-server-empty-state" data-testid="dev-server-no-executing-tasks">
                {t("devserver.noExecutingTasks", "No executing tasks with a worktree available. Start a task to target its worktree.")}
              </p>
            )}
            {selectedTask && (
              <div className="dev-server-task-descriptor" data-testid="dev-server-task-descriptor">
                {/*
                FNXC:DevServer 2026-06-23-00:00:
                The selected executing task descriptor is shown next to the worktree picker so users know which in-progress task the preview reflects before they start or restart the dev server.
                */}
                <div className="dev-server-task-descriptor-header">
                  <span className="dev-server-candidate-name">
                    {selectedTask.title ? `${selectedTask.id} — ${selectedTask.title}` : selectedTask.id}
                  </span>
                </div>
                <p className="dev-server-task-description">{selectedTask.description}</p>
                <div className="dev-server-task-worktree">
                  <span className="dev-server-label">{t("devserver.targetWorktree", "Target worktree")}</span>
                  <code>{selectedTask.worktree}</code>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="dev-server-field-group">
          <label htmlFor="dev-server-command" className="dev-server-label">{t("devserver.command", "Command")}</label>
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
            <span className="dev-server-label">{t("devserver.runningCommand", "Running command")}</span>
            <code>{session.config?.command ?? commandInput}</code>
          </div>
        )}

        <div className="dev-server-preview-override">
          <label htmlFor="dev-server-preview-input" className="dev-server-label">{t("devserver.previewUrlOverride", "Preview URL Override")}</label>
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
            {t("devserver.save", "Save")}
          </button>
        </div>

        {effectivePreviewUrl && (
          <p className="dev-server-preview-hint">{t("devserver.autoDetected", "Auto-detected: {{url}}", { url: effectivePreviewUrl })}</p>
        )}
      </section>

      <div className="dev-server-content">
        <section className="dev-server-panel dev-server-logs-panel" data-testid="dev-server-logs-panel" aria-label={t("devserver.logsLabel", "Dev server logs")}>
          <div className="dev-server-section-header">
            <h3>{t("devserver.logs", "Logs")}</h3>
            <span className="dev-server-muted">{t("devserver.lines", "{{count}} lines", { count: logsTotal ?? logEntries.length })}</span>
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
      </div>

      {isNarrowRightDockPreviewMode ? (
        <section
          className="dev-server-panel devserver-preview-modal-launcher"
          data-testid="devserver-preview-modal-launcher"
          aria-label={t("devserver.previewLabel", "Dev server preview")}
        >
          <div className="devserver-preview-modal-launcher__copy">
            <div className="devserver-preview-title">
              <Eye size={14} />
              <span>{t("devserver.preview", "Preview")}</span>
            </div>
            <span
              className={`devserver-preview-url-badge ${isManualPreviewOverride ? "devserver-preview-url-badge--manual" : "devserver-preview-url-badge--auto"}`}
              title={effectivePreviewUrl ?? t("devserver.noPreviewUrl", "No preview URL")}
              data-testid="devserver-preview-url-badge"
            >
              {effectivePreviewUrl ? effectivePreviewUrl : t("devserver.notAvailable", "Not available")}
            </span>
          </div>
          <p className="devserver-preview-modal-launcher__description">
            {effectivePreviewUrl
              ? t("devserver.previewModalLauncherDescription", "Open the live preview in a modal so logs and configuration stay usable in this narrow dock.")
              : t("devserver.previewModalLauncherUnavailable", "Start the dev server or set a preview URL to open the preview modal.")}
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            ref={previewModalLauncherRef}
            onClick={() => setIsPreviewModalOpen(true)}
            data-testid="devserver-preview-modal-open"
          >
            {t("devserver.openPreview", "Open preview")}
          </button>
        </section>
      ) : (
        <section className="dev-server-panel devserver-preview-panel" data-testid="devserver-preview-panel" aria-label={t("devserver.previewLabel", "Dev server preview")}>
          {renderPreviewContent()}
        </section>
      )}

      {isNarrowRightDockPreviewMode && isPreviewModalOpen && (
        <div className="modal-overlay open devserver-preview-modal-overlay" {...previewModalOverlayDismissProps}>
          <div
            className="modal devserver-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="devserver-preview-modal-title"
            tabIndex={-1}
            ref={previewModalRef}
            data-testid="devserver-preview-modal"
          >
            <div className="devserver-preview-modal__titlebar">
              <h2 id="devserver-preview-modal-title">{t("devserver.preview", "Preview")}</h2>
              <button
                type="button"
                className="btn btn-sm btn-icon"
                onClick={closePreviewModal}
                aria-label={t("devserver.closePreviewModal", "Close preview modal")}
                data-testid="devserver-preview-modal-close"
              >
                <X />
              </button>
            </div>
            <div className="devserver-preview-modal__body">
              {renderPreviewContent()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
