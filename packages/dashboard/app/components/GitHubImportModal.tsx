import "./GitHubImportModal.css";
import { useState, useEffect, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import {
  apiFetchGitHubIssues,
  apiImportGitHubIssue,
  apiFetchGitHubPulls,
  apiImportGitHubPull,
  fetchGitRemotes,
  type GitHubIssue,
  type GitHubPull,
  type GitRemote,
} from "../api";
import { Loader2, RefreshCw, ArrowLeft, GitPullRequest, CircleDot } from "lucide-react";
import { GithubIcon } from "./GithubIcon";
import { MailboxMessageContent } from "./MailboxMessageContent";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useEmbeddedPresentation, type ModalPresentation } from "../hooks/useEmbeddedPresentation";

interface GitHubImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (task: Task) => void;
  tasks: Task[];
  projectId?: string;
  /*
  FNXC:RightDockEmbedding 2026-06-22-00:00:
  Right-dock redesign renders the GitHub import surface inline inside the main content area instead of as a fixed popup overlay.
  "embedded" drops the modal overlay/close button and disables modal-only chrome (scroll lock, resize persistence, escape/overlay dismiss); "modal" (default) keeps the original byte-identical overlay behavior.
  */
  presentation?: ModalPresentation;
}

// Mobile and two-pane breakpoints in pixels
const MOBILE_BREAKPOINT = 640;
const TWO_PANE_BREAKPOINT = 860;
const GITHUB_IMPORT_LIST_PANE_MIN_WIDTH = 240;
const GITHUB_IMPORT_LIST_PANE_MAX_WIDTH = 640;
const GITHUB_IMPORT_LIST_PANE_DEFAULT_WIDTH = 360;
const GITHUB_IMPORT_LIST_PANE_STORAGE_KEY = "fusion:github-import-list-pane-width";

type TabType = "issues" | "pulls";

function clampListPaneWidth(width: number) {
  return Math.max(GITHUB_IMPORT_LIST_PANE_MIN_WIDTH, Math.min(GITHUB_IMPORT_LIST_PANE_MAX_WIDTH, width));
}

/*
FNXC:GitHubImport 2026-06-22-18:30:
The Import-from-GitHub preview pane must show the FULL selected issue/PR, not a truncated snapshot.
The list endpoint already returns the complete (untruncated) body, so no per-item detail fetch is needed — the prior 200-char desktop slice in formatPreviewBody was the only thing truncating the preview, and it has been removed.
The full body renders as GitHub-flavored markdown via the shared MailboxMessageContent component; the preview pane is already scrollable (prior fix), so the body takes full height with no line clamping.
*/

export function GitHubImportModal({ isOpen, onClose, onImport, tasks, projectId, presentation = "modal" }: GitHubImportModalProps) {
  const { isEmbedded, scrollLockEnabled, resizePersistEnabled, escapeEnabled } = useEmbeddedPresentation(presentation);
  useMobileScrollLock(isOpen && scrollLockEnabled);
  const { t } = useTranslation("app");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [labels, setLabels] = useState("");
  const [loading, setLoading] = useState(false);

  // Tab state
  const [activeTab, setActiveTab] = useState<TabType>("issues");

  // Issues state
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(null);

  // Pulls state
  const [pulls, setPulls] = useState<GitHubPull[]>([]);
  const [selectedPullNumber, setSelectedPullNumber] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [isIssuesEmptyState, setIsIssuesEmptyState] = useState(false);
  const [isPullsEmptyState, setIsPullsEmptyState] = useState(false);
  const [importing, setImporting] = useState(false);

  // Git remotes state
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [loadingRemotes, setLoadingRemotes] = useState(false);
  const [selectedRemoteName, setSelectedRemoteName] = useState<string>("");
  const mountedRef = useRef(false);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalResizePersist(modalRef, isOpen && resizePersistEnabled, "fusion:github-modal-size");
  const overlayDismissProps = useOverlayDismiss(onClose);

  // Responsive view state
  const [isMobile, setIsMobile] = useState(false);
  const [canResizePanes, setCanResizePanes] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "preview">("list");
  const [listPaneWidth, setListPaneWidth] = useState(() => {
    if (typeof window === "undefined") {
      return GITHUB_IMPORT_LIST_PANE_DEFAULT_WIDTH;
    }

    try {
      const stored = window.localStorage.getItem(GITHUB_IMPORT_LIST_PANE_STORAGE_KEY);
      if (!stored) {
        return GITHUB_IMPORT_LIST_PANE_DEFAULT_WIDTH;
      }
      const parsed = Number.parseInt(stored, 10);
      if (!Number.isFinite(parsed)) {
        return GITHUB_IMPORT_LIST_PANE_DEFAULT_WIDTH;
      }
      return clampListPaneWidth(parsed);
    } catch {
      return GITHUB_IMPORT_LIST_PANE_DEFAULT_WIDTH;
    }
  });

  // Track which owner/repo we've already auto-loaded to prevent duplicate loads
  const autoLoadedRef = useRef<{ owner: string; repo: string; labels: string; tab: TabType } | null>(null);

  // Build set of already imported URLs from existing tasks
  const importedUrls = new Set<string>();
  for (const task of tasks) {
    // Check for issue URLs
    const issueMatch = task.description.match(/Source: (https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+)/);
    if (issueMatch) {
      importedUrls.add(issueMatch[1]);
    }
    // Check for PR URLs
    const prMatch = task.description.match(/PR: (https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)/);
    if (prMatch) {
      importedUrls.add(prMatch[1]);
    }
  }

  // Reset state when modal opens and fetch remotes
  useEffect(() => {
    if (isOpen) {
      setOwner("");
      setRepo("");
      setLabels("");
      setIssues([]);
      setSelectedIssueNumber(null);
      setPulls([]);
      setSelectedPullNumber(null);
      setActiveTab("issues");
      setError(null);
      setIsIssuesEmptyState(false);
      setIsPullsEmptyState(false);
      setImporting(false);
      setRemotes([]);
      setLoadingRemotes(true);
      setSelectedRemoteName("");
      autoLoadedRef.current = null;

      mountedRef.current = true;

      // Fetch git remotes
      fetchGitRemotes()
        .then((fetchedRemotes) => {
          if (!mountedRef.current) return;

          setRemotes(fetchedRemotes);
          setLoadingRemotes(false);

          const defaultRemote = fetchedRemotes.length === 1
            ? fetchedRemotes[0]
            : fetchedRemotes.find((remote) => remote.name === "origin");

          if (defaultRemote) {
            setOwner(defaultRemote.owner);
            setRepo(defaultRemote.repo);
            setSelectedRemoteName(defaultRemote.name);
          } else if (fetchedRemotes.length > 1) {
            // Multiple remotes without origin: don't auto-select, user must choose.
            setOwner("");
            setRepo("");
            setSelectedRemoteName("");
          }
          // If no remotes, owner/repo remain empty
        })
        .catch(() => {
          if (mountedRef.current) {
            setLoadingRemotes(false);
          }
        });

      return () => {
        mountedRef.current = false;
      };
    }
  }, [isOpen]);

  // Handle remote selection change
  const handleRemoteChange = useCallback((remoteName: string) => {
    setSelectedRemoteName(remoteName);
    if (remoteName === "") {
      setOwner("");
      setRepo("");
    } else {
      const remote = remotes.find((r) => r.name === remoteName);
      if (remote) {
        setOwner(remote.owner);
        setRepo(remote.repo);
      }
    }
  }, [remotes]);

  // Handle load issues - defined BEFORE the auto-load useEffect
  const handleLoad = useCallback(async () => {
    if (!owner.trim() || !repo.trim()) {
      setError(t("git.repoMustBeSelected", "Repository must be selected"));
      return;
    }

    setLoading(true);
    setError(null);
    setIsIssuesEmptyState(false);
    setIssues([]);
    setSelectedIssueNumber(null);

    try {
      const labelArray = labels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);
      const fetchedIssues = await apiFetchGitHubIssues(owner.trim(), repo.trim(), 30, labelArray.length > 0 ? labelArray : undefined);
      setIssues(fetchedIssues);
      if (fetchedIssues.length === 0) {
        setIsIssuesEmptyState(true);
      }
    } catch (err) {
      setError(getErrorMessage(err) || t("git.failedToFetchIssues", "Failed to fetch issues"));
    } finally {
      setLoading(false);
    }
  }, [owner, repo, labels]);

  // Handle load pull requests
  const handleLoadPulls = useCallback(async () => {
    if (!owner.trim() || !repo.trim()) {
      setError(t("git.repoMustBeSelected", "Repository must be selected"));
      return;
    }

    setLoading(true);
    setError(null);
    setIsPullsEmptyState(false);
    setPulls([]);
    setSelectedPullNumber(null);

    try {
      const fetchedPulls = await apiFetchGitHubPulls(owner.trim(), repo.trim(), 30);
      setPulls(fetchedPulls);
      if (fetchedPulls.length === 0) {
        setIsPullsEmptyState(true);
      }
    } catch (err) {
      setError(getErrorMessage(err) || t("git.failedToFetchPulls", "Failed to fetch pull requests"));
    } finally {
      setLoading(false);
    }
  }, [owner, repo]);

  // Auto-load data when owner and repo are set and valid
  useEffect(() => {
    if (!isOpen) return;
    if (!owner.trim() || !repo.trim()) return;
    if (loading || importing) return;

    // Check if we've already auto-loaded for this exact combination
    const currentKey = { owner: owner.trim(), repo: repo.trim(), labels: labels.trim(), tab: activeTab };
    if (
      autoLoadedRef.current?.owner === currentKey.owner &&
      autoLoadedRef.current?.repo === currentKey.repo &&
      autoLoadedRef.current?.labels === currentKey.labels &&
      autoLoadedRef.current?.tab === currentKey.tab
    ) {
      return;
    }

    // Mark as auto-loaded and trigger the load
    autoLoadedRef.current = currentKey;
    if (activeTab === "issues") {
      handleLoad();
    } else {
      handleLoadPulls();
    }
  }, [owner, repo, labels, activeTab, isOpen, loading, importing, handleLoad, handleLoadPulls]);

  // Handle escape key
  // FNXC:RightDockEmbedding 2026-06-22-00:00: Escape-to-close is a modal-only affordance; embedded mode has no dismiss.
  useEffect(() => {
    if (!isOpen || !escapeEnabled) return;
    const handleKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, escapeEnabled, onClose]);

  // Detect responsive viewport bands
  useEffect(() => {
    if (!isOpen) return;

    const checkViewportBands = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
      setCanResizePanes(window.innerWidth > TWO_PANE_BREAKPOINT);
    };

    // Check initially
    checkViewportBands();

    // Listen for resize
    window.addEventListener("resize", checkViewportBands);
    return () => window.removeEventListener("resize", checkViewportBands);
  }, [isOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(GITHUB_IMPORT_LIST_PANE_STORAGE_KEY, String(listPaneWidth));
    } catch {
      // Ignore storage write failures.
    }
  }, [listPaneWidth]);

  const handleListPaneResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canResizePanes) {
      return;
    }

    const startX = event.clientX;
    const startWidth = listPaneWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      setListPaneWidth(clampListPaneWidth(startWidth + deltaX));
    };

    const handlePointerUp = () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
  }, [canResizePanes, listPaneWidth]);

  const handleListPaneResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!canResizePanes) {
      return;
    }

    const step = event.shiftKey ? 50 : 10;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setListPaneWidth((current) => clampListPaneWidth(current - step));
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setListPaneWidth((current) => clampListPaneWidth(current + step));
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setListPaneWidth(GITHUB_IMPORT_LIST_PANE_MIN_WIDTH);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      setListPaneWidth(GITHUB_IMPORT_LIST_PANE_MAX_WIDTH);
    }
  }, [canResizePanes]);

  // Handle issue selection - switch to preview view on mobile
  const handleIssueSelect = useCallback((issueNumber: number) => {
    setSelectedIssueNumber(issueNumber);
    if (isMobile) {
      setMobileView('preview');
    }
  }, [isMobile]);

  // Handle pull request selection - switch to preview view on mobile
  const handlePullSelect = useCallback((pullNumber: number) => {
    setSelectedPullNumber(pullNumber);
    if (isMobile) {
      setMobileView('preview');
    }
  }, [isMobile]);

  // Handle back button - return to list view on mobile
  const handleBackToList = useCallback(() => {
    setMobileView('list');
  }, []);

  const handleImport = useCallback(async () => {
    if (activeTab === "issues") {
      if (selectedIssueNumber === null) return;

      setImporting(true);
      setError(null);

      try {
        const task = await apiImportGitHubIssue(owner.trim(), repo.trim(), selectedIssueNumber, projectId);
        onImport(task);
        setSelectedIssueNumber(null);
        if (isMobile && mobileView === "preview") {
          setMobileView("list");
        }
      } catch (err) {
        const msg = getErrorMessage(err);
        if (msg?.includes("already imported")) {
          setError(msg);
        } else {
          setError(msg || t("git.failedToImportIssue", "Failed to import issue"));
        }
      } finally {
        setImporting(false);
      }
    } else {
      if (selectedPullNumber === null) return;

      setImporting(true);
      setError(null);

      try {
        const task = await apiImportGitHubPull(owner.trim(), repo.trim(), selectedPullNumber, projectId);
        onImport(task);
        setSelectedPullNumber(null);
        if (isMobile && mobileView === "preview") {
          setMobileView("list");
        }
      } catch (err) {
        const msg = getErrorMessage(err);
        if (msg?.includes("already imported")) {
          setError(msg);
        } else {
          setError(msg || t("git.failedToImportPull", "Failed to import pull request"));
        }
      } finally {
        setImporting(false);
      }
    }
  }, [activeTab, selectedIssueNumber, selectedPullNumber, owner, repo, onImport, isMobile, mobileView]);

  const selectedIssue = issues.find((i) => i.number === selectedIssueNumber);
  const selectedPull = pulls.find((p) => p.number === selectedPullNumber);

  if (!isOpen) return null;

  // Determine state flags
  const hasRemotes = remotes.length > 0;
  const singleRemote = remotes.length === 1;

  // Tab-specific counts
  const importedIssueCount = issues.filter((issue) => importedUrls.has(issue.html_url)).length;
  const importedPullCount = pulls.filter((pull) => importedUrls.has(pull.html_url)).length;

  // Empty states
  const isIssuesEmpty = isIssuesEmptyState;
  const isPullsEmpty = isPullsEmptyState;
  const isEmptyState = activeTab === "issues" ? isIssuesEmpty : isPullsEmpty;

  // Results error state
  const isIssuesError = Boolean(error) && !isIssuesEmpty && issues.length === 0 && !loading;
  const isPullsError = Boolean(error) && !isPullsEmpty && pulls.length === 0 && !loading;
  const isResultsError = activeTab === "issues" ? isIssuesError : isPullsError;

  // Results content
  const hasIssuesContent = loading || issues.length > 0 || isIssuesEmpty || isIssuesError;
  const hasPullsContent = loading || pulls.length > 0 || isPullsEmpty || isPullsError;
  const hasResultsContent = activeTab === "issues" ? hasIssuesContent : hasPullsContent;

  // Inline error
  const showIssuesError = Boolean(error) && issues.length > 0 && !isIssuesEmpty;
  const showPullsError = Boolean(error) && pulls.length > 0 && !isPullsEmpty;
  const showInlineErrorBanner = activeTab === "issues" ? showIssuesError : showPullsError;

  /*
  FNXC:RightDockEmbedding 2026-06-22-00:00:
  Embedded mode renders the import surface as a main-content-area view (no fixed .modal-overlay, no close button, no overlay-dismiss).
  Modal mode is kept byte-identical: same overlay wrapper, header with subtitle + close button, and overlay-dismiss props.
  */
  const inner = (
    <div className={`modal modal-lg github-import-modal${isEmbedded ? " github-import-modal--embedded" : ""}`} ref={modalRef}>
      {isEmbedded ? (
        /*
        FNXC:RightDockEmbedding 2026-06-22-00:40:
        Import Tasks is a main-content destination, so its header reads like Command Center (cc-header/cc-title): a plain title row with the GitHub logo and the shared 1.125rem embedded-title font, no modal-header bar or close button. Padding matches the embedded view container.
        */
        <header className="github-import-modal__embedded-header">
          <h2 className="github-import-modal__embedded-title">
            <GithubIcon size={20} />
            {t("git.importTasksHeading", "Import Tasks")}
          </h2>
        </header>
      ) : (
        <div className="modal-header github-import-modal__header">
          <div>
            <h3>{t("git.importFromGitHub", "Import from GitHub")}</h3>
            <p className="github-import-modal__subtitle">
              {t("git.importSubtitle", "Choose a detected remote, load open issues or pull requests, and import one into the board.")}
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label={t("git.closeModalAriaLabel", "Close import modal")}>
            &times;
          </button>
        </div>
      )}

        <div className="modal-body github-import-modal__body">
          {/* Tab Navigation */}
          <div className="github-import-tabs" role="tablist" aria-label={t("git.importTypeAriaLabel", "Import type")}>
            <button
              role="tab"
              aria-selected={activeTab === "issues"}
              aria-controls="github-import-list-pane"
              className={`github-import-tab ${activeTab === "issues" ? "active" : ""}`}
              onClick={() => {
                setActiveTab("issues");
                setSelectedPullNumber(null);
              }}
              disabled={loading || importing}
            >
              <CircleDot size={16} />
              <span>{t("git.tabIssues", "Issues")}</span>
            </button>
            <button
              role="tab"
              aria-selected={activeTab === "pulls"}
              aria-controls="github-import-list-pane"
              className={`github-import-tab ${activeTab === "pulls" ? "active" : ""}`}
              onClick={() => {
                setActiveTab("pulls");
                setSelectedIssueNumber(null);
              }}
              disabled={loading || importing}
            >
              <GitPullRequest size={16} />
              <span>{t("git.tabPullRequests", "Pull Requests")}</span>
            </button>
          </div>

          {/* Compact Toolbar */}
          <div className="github-import-toolbar" data-testid="github-import-toolbar" role="toolbar" aria-label={t("git.toolbarAriaLabel", "GitHub import controls")}>
            {/* Left: Remote selector */}
            <div className="github-import-toolbar__zone github-import-toolbar__zone--remote">
              {loadingRemotes ? (
                <div className="github-import-toolbar__loading" role="status" aria-live="polite">
                  <Loader2 size={16} className="spin" />
                  <span>{t("git.detectingRemotes", "Detecting…")}</span>
                </div>
              ) : !hasRemotes ? (
                <span className="github-import-toolbar__no-remote">{t("git.noRemotes", "No remotes")}</span>
              ) : singleRemote ? (
                <div className="github-import-remote-pill" data-testid="github-import-single-remote">
                  <span className="github-import-remote-pill__name">{remotes[0].name}</span>
                  <span className="github-import-remote-pill__repo">{remotes[0].owner}/{remotes[0].repo}</span>
                </div>
              ) : (
                <div className="github-import-remote-select">
                  <label htmlFor="gh-remote" className="visually-hidden">{t("git.repositoryLabel", "Repository")}</label>
                  <select
                    id="gh-remote"
                    value={selectedRemoteName}
                    onChange={(e) => handleRemoteChange(e.target.value)}
                    disabled={loading || importing}
                    aria-label={t("git.selectRemoteAriaLabel", "Select Git remote")}
                  >
                    <option value="">{t("git.selectRemotePlaceholder", "Select remote…")}</option>
                    {remotes.map((remote) => (
                      <option key={remote.name} value={remote.name}>
                        {remote.name} ({remote.owner}/{remote.repo})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Center: Labels filter (only for issues) */}
            <div className="github-import-toolbar__zone github-import-toolbar__zone--filter">
              {activeTab === "issues" ? (
                <>
                  <label htmlFor="gh-labels" className="visually-hidden">{t("git.filterByLabelsLabel", "Filter by labels")}</label>
                  <input
                    id="gh-labels"
                    type="text"
                    placeholder={t("git.filterByLabelsPlaceholder", "Filter: bug,enhancement…")}
                    value={labels}
                    onChange={(e) => setLabels(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleLoad()}
                    disabled={loading || importing || !hasRemotes}
                    aria-label={t("git.filterIssuesByLabels", "Filter issues by labels")}
                  />
                </>
              ) : (
                <span className="github-import-filter-hint">
                  {t("git.openPullsFrom", "Open pull requests from {{remote}}", { remote: owner || t("git.selectedRemote", "selected remote") })}
                </span>
              )}
            </div>

            {/* Right: Load button */}
            <div className="github-import-toolbar__zone github-import-toolbar__zone--action">
              <button
                id="gh-load"
                className="btn btn-primary github-import-load-button"
                onClick={activeTab === "issues" ? handleLoad : handleLoadPulls}
                disabled={loading || importing || !owner.trim() || !repo.trim()}
                aria-label={loading ? t("git.loadingAriaLabel", "Loading {{tab}}", { tab: activeTab }) : t("git.loadFromRepoAriaLabel", "Load {{tab}} from repository", { tab: activeTab })}
                title={loading ? t("git.loadingTitle", "Loading…") : t("git.loadTabTitle", "Load {{tab}}", { tab: activeTab })}
              >
                {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                <span>{loading ? t("git.loading", "Loading…") : t("git.load", "Load")}</span>
              </button>
            </div>
          </div>

          {/* Warning/Error states below toolbar */}
          {!loadingRemotes && !hasRemotes && (
            <div className="github-import-state github-import-state--warning" role="alert">
              <div>
                <strong>{t("git.noRemotesDetected", "No GitHub remotes detected")}</strong>
                <span>{t("git.noRemotesInstructions", "Add a GitHub remote to this repository, then reopen the modal.")}</span>
              </div>
              <code className="github-import-command">
                git remote add origin https://github.com/owner/repo.git
              </code>
            </div>
          )}

          {showInlineErrorBanner && (
            <div className="form-error github-import-banner" role="alert">
              {error}
            </div>
          )}

          {/* Two-pane workspace */}
          <div className="github-import-workspace">
            {/* Left pane: Issue/PR list */}
            <section
              className={`github-import-list-pane ${isMobile ? 'mobile' : ''} ${mobileView === 'list' ? 'active' : ''}`}
              style={canResizePanes ? { flex: `0 0 ${listPaneWidth}px` } : undefined}
              data-testid="github-import-list-pane"
              aria-labelledby="github-import-results-heading"
            >
              <div className="github-import-pane-header">
                <h4 id="github-import-results-heading">
                  {activeTab === "issues" ? t("git.tabIssues", "Issues") : t("git.tabPullRequests", "Pull Requests")}
                </h4>
                {activeTab === "issues" && issues.length > 0 && (
                  <div className="github-import-results-meta" aria-live="polite">
                    <span>{t("git.issueCount", { count: issues.length, defaultValue_one: "{{count}} issue", defaultValue_other: "{{count}} issues" })}</span>
                    <span>{t("git.importedCount", "{{count}} imported", { count: importedIssueCount })}</span>
                  </div>
                )}
                {activeTab === "pulls" && pulls.length > 0 && (
                  <div className="github-import-results-meta" aria-live="polite">
                    <span>{t("git.pullCount", { count: pulls.length, defaultValue_one: "{{count}} pull request", defaultValue_other: "{{count}} pull requests" })}</span>
                    <span>{t("git.importedCount", "{{count}} imported", { count: importedPullCount })}</span>
                  </div>
                )}
              </div>

              <div className="github-import-pane-content">
                {!hasResultsContent && (
                  <div className="github-import-state github-import-state--idle" data-testid="github-import-results-idle">
                    <div>
                      <strong>{t("git.nothingLoadedYet", "Nothing loaded yet")}</strong>
                      <span>{t("git.nothingLoadedInstructions", "Select a repository and click Load to start reviewing import candidates.")}</span>
                    </div>
                  </div>
                )}

                {loading && (
                  <div className="github-import-state github-import-state--loading" role="status" aria-live="polite">
                    <Loader2 size={16} className="spin" />
                    <div>
                      <strong>{activeTab === "issues" ? t("git.loadingIssues", "Loading open issues…") : t("git.loadingPulls", "Loading open pull requests…")}</strong>
                      <span>{t("git.fetchingFromGitHub", "Fetching the latest list from GitHub.")}</span>
                    </div>
                  </div>
                )}

                {isResultsError && (
                  <div className="github-import-state github-import-state--error" role="alert">
                    <div>
                      <strong>{activeTab === "issues" ? t("git.couldNotLoadIssues", "Could not load issues") : t("git.couldNotLoadPulls", "Could not load pull requests")}</strong>
                      <span>{error}</span>
                    </div>
                  </div>
                )}

                {isEmptyState && (
                  <div className="github-import-state github-import-state--empty" role="status">
                    <div>
                      <strong>{activeTab === "issues" ? t("git.noOpenIssues", "No open issues found") : t("git.noOpenPulls", "No open pull requests found")}</strong>
                      <span>{activeTab === "issues" ? t("git.tryDifferentFilter", "Try a different label filter or choose another repository.") : t("git.chooseAnotherRepo", "Choose another repository.")}</span>
                    </div>
                  </div>
                )}

                {/* Issues list */}
                {activeTab === "issues" && issues.length > 0 && (
                  <div className="issues-list" aria-live="polite">
                    {issues.map((issue) => {
                      const isImported = importedUrls.has(issue.html_url);
                      return (
                        <div
                          key={issue.number}
                          className={`issue-item ${selectedIssueNumber === issue.number ? "selected" : ""} ${isImported ? "imported" : ""}`}
                          onClick={() => !isImported && handleIssueSelect(issue.number)}
                        >
                          <input
                            type="radio"
                            name="issue"
                            checked={selectedIssueNumber === issue.number}
                            onChange={() => handleIssueSelect(issue.number)}
                            disabled={isImported}
                            aria-label={t("git.selectIssueAriaLabel", "Select issue #{{number}}", { number: issue.number })}
                          />
                          <div className="issue-main">
                            <div className="issue-heading-row">
                              <span className="issue-number">#{issue.number}</span>
                              <span className="issue-title">{issue.title}</span>
                            </div>
                            {issue.labels.length > 0 && (
                              <span className="issue-labels">
                                {issue.labels.map((l) => (
                                  <span key={l.name} className="label-chip">
                                    {l.name}
                                  </span>
                                ))}
                              </span>
                            )}
                          </div>
                          {isImported && <span className="imported-badge">{t("git.imported", "Imported")}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Pulls list */}
                {activeTab === "pulls" && pulls.length > 0 && (
                  <div className="issues-list" aria-live="polite">
                    {pulls.map((pull) => {
                      const isImported = importedUrls.has(pull.html_url);
                      return (
                        <div
                          key={pull.number}
                          className={`issue-item ${selectedPullNumber === pull.number ? "selected" : ""} ${isImported ? "imported" : ""}`}
                          onClick={() => !isImported && handlePullSelect(pull.number)}
                        >
                          <input
                            type="radio"
                            name="pull"
                            checked={selectedPullNumber === pull.number}
                            onChange={() => handlePullSelect(pull.number)}
                            disabled={isImported}
                            aria-label={t("git.selectPullAriaLabel", "Select pull request #{{number}}", { number: pull.number })}
                          />
                          <div className="issue-main">
                            <div className="issue-heading-row">
                              <span className="issue-number">#{pull.number}</span>
                              <span className="issue-title">{pull.title}</span>
                            </div>
                            <span className="pull-branch-info">
                              {pull.headBranch} → {pull.baseBranch}
                            </span>
                          </div>
                          {isImported && <span className="imported-badge">{t("git.imported", "Imported")}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {canResizePanes && (
              <div
                className="github-import-workspace__resize-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("git.resizeIssuesList", "Resize issues list")}
                aria-valuemin={GITHUB_IMPORT_LIST_PANE_MIN_WIDTH}
                aria-valuemax={GITHUB_IMPORT_LIST_PANE_MAX_WIDTH}
                aria-valuenow={listPaneWidth}
                tabIndex={0}
                onPointerDown={handleListPaneResizeStart}
                onKeyDown={handleListPaneResizeKeyDown}
                data-testid="github-import-resize-handle"
              />
            )}

            {/* Right pane: Preview */}
            <section
              className={`github-import-preview-pane ${isMobile ? 'mobile' : ''} ${mobileView === 'preview' ? 'active' : ''}`}
              data-testid="github-import-preview-pane"
              aria-labelledby="github-import-preview-heading"
            >
              <div className="github-import-pane-header">
                {isMobile && (
                  <button
                    className="github-import-back-button"
                    onClick={handleBackToList}
                    data-testid="github-import-back-button"
                    aria-label={activeTab === "issues" ? t("git.backToIssuesList", "Back to issues list") : t("git.backToPullsList", "Back to pull requests list")}
                  >
                    <ArrowLeft size={16} />
                    <span>{t("common.back", "Back")}</span>
                  </button>
                )}
                <h4 id="github-import-preview-heading">{t("git.previewHeading", "Preview")}</h4>
              </div>

              <div className="github-import-pane-content">
                {/* Issue preview */}
                {/*
                FNXC:GitHubImport 2026-06-22-18:30:
                Full-issue preview: complete title, full body rendered as markdown, and key metadata (number, state, author, labels, URL). No body truncation/clamping.
                */}
                {activeTab === "issues" && selectedIssue ? (
                  <div className="issue-preview" data-testid="github-import-preview-card">
                    <div className="preview-meta">{t("git.previewIssueMeta", "Issue #{{number}}", { number: selectedIssue.number })}</div>
                    <div className="preview-title">{selectedIssue.title}</div>
                    <div className="preview-metadata">
                      {selectedIssue.state && (
                        <span className={`preview-state-badge preview-state-badge--${selectedIssue.state}`}>{selectedIssue.state}</span>
                      )}
                      {selectedIssue.author && (
                        <span className="preview-author">{t("git.previewAuthor", "by {{author}}", { author: selectedIssue.author })}</span>
                      )}
                      <a className="preview-url" href={selectedIssue.html_url} target="_blank" rel="noopener noreferrer">
                        {t("git.viewOnGitHub", "View on GitHub")}
                      </a>
                    </div>
                    {selectedIssue.labels.length > 0 && (
                      <span className="preview-labels">
                        {selectedIssue.labels.map((l) => (
                          <span key={l.name} className="label-chip">{l.name}</span>
                        ))}
                      </span>
                    )}
                    {selectedIssue.body ? (
                      <MailboxMessageContent
                        className="preview-body preview-body--markdown"
                        content={selectedIssue.body}
                        testId="github-import-preview-body"
                      />
                    ) : (
                      <div className="preview-body" data-testid="github-import-preview-body">
                        {t("git.noDescription", "(no description)")}
                      </div>
                    )}
                  </div>
                ) : activeTab === "issues" ? (
                  <div className="github-import-state github-import-state--idle" data-testid="github-import-preview-empty">
                    <div>
                      <strong>{t("git.noIssueSelected", "No issue selected")}</strong>
                      <span>{t("git.noIssueSelectedHint", "Choose an issue from the list to inspect its title and description.")}</span>
                    </div>
                  </div>
                ) : null}

                {/* Pull request preview */}
                {/*
                FNXC:GitHubImport 2026-06-22-18:30:
                Full-PR preview: complete title, full body as markdown, and key metadata (number, state, author, base/head branches, URL). No body truncation/clamping.
                */}
                {activeTab === "pulls" && selectedPull ? (
                  <div className="issue-preview" data-testid="github-import-preview-card">
                    <div className="preview-meta">{t("git.previewPullMeta", "Pull Request #{{number}}", { number: selectedPull.number })}</div>
                    <div className="preview-title">{selectedPull.title}</div>
                    <div className="preview-metadata">
                      {selectedPull.state && (
                        <span className={`preview-state-badge preview-state-badge--${selectedPull.state}`}>{selectedPull.state}</span>
                      )}
                      {selectedPull.author && (
                        <span className="preview-author">{t("git.previewAuthor", "by {{author}}", { author: selectedPull.author })}</span>
                      )}
                      <a className="preview-url" href={selectedPull.html_url} target="_blank" rel="noopener noreferrer">
                        {t("git.viewOnGitHub", "View on GitHub")}
                      </a>
                    </div>
                    <div className="preview-branch">
                      <strong>{t("git.branchLabel", "Branch:")}</strong> {selectedPull.headBranch} → {selectedPull.baseBranch}
                    </div>
                    {selectedPull.body ? (
                      <MailboxMessageContent
                        className="preview-body preview-body--markdown"
                        content={selectedPull.body}
                        testId="github-import-preview-body"
                      />
                    ) : (
                      <div className="preview-body" data-testid="github-import-preview-body">
                        {t("git.noDescription", "(no description)")}
                      </div>
                    )}
                  </div>
                ) : activeTab === "pulls" ? (
                  <div className="github-import-state github-import-state--idle" data-testid="github-import-preview-empty">
                    <div>
                      <strong>{t("git.noPullSelected", "No pull request selected")}</strong>
                      <span>{t("git.noPullSelectedHint", "Choose a pull request from the list to inspect its details.")}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </div>

        <div className="modal-actions github-import-modal__actions">
          <button className="btn" onClick={onClose} disabled={importing}>
            {t("common.cancel", "Cancel")}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleImport}
            disabled={
              (activeTab === "issues" ? selectedIssueNumber === null : selectedPullNumber === null) || importing
            }
          >
            {importing ? <Loader2 size={14} className="spin" /> : t("git.import", "Import")}
          </button>
        </div>
    </div>
  );

  if (isEmbedded) {
    return <div className="github-import-embedded right-dock-embedded-view">{inner}</div>;
  }

  return (
    <div className="modal-overlay open" {...overlayDismissProps} role="dialog" aria-modal="true">
      {inner}
    </div>
  );
}
