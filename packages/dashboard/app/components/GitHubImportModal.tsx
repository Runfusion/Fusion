import { useState, useEffect, useCallback, useRef } from "react";
import type { Task } from "@fusion/core";
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

interface GitHubImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (task: Task) => void;
  tasks: Task[];
  projectId?: string;
}

// Mobile breakpoint in pixels
const MOBILE_BREAKPOINT = 640;

type TabType = "issues" | "pulls";

export function GitHubImportModal({ isOpen, onClose, onImport, tasks, projectId }: GitHubImportModalProps) {
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
  const [importing, setImporting] = useState(false);

  // Git remotes state
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [loadingRemotes, setLoadingRemotes] = useState(false);
  const [selectedRemoteName, setSelectedRemoteName] = useState<string>("");
  const mountedRef = useRef(false);

  // Mobile view state
  const [isMobile, setIsMobile] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "preview">("list");

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

          if (fetchedRemotes.length === 1) {
            // Single remote: auto-select it
            const remote = fetchedRemotes[0];
            setOwner(remote.owner);
            setRepo(remote.repo);
            setSelectedRemoteName(remote.name);
          } else if (fetchedRemotes.length > 1) {
            // Multiple remotes: don't auto-select, user must choose
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
      setError("Repository must be selected");
      return;
    }

    setLoading(true);
    setError(null);
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
        setError("No open issues found");
      }
    } catch (err: any) {
      setError(err.message || "Failed to fetch issues");
    } finally {
      setLoading(false);
    }
  }, [owner, repo, labels]);

  // Handle load pull requests
  const handleLoadPulls = useCallback(async () => {
    if (!owner.trim() || !repo.trim()) {
      setError("Repository must be selected");
      return;
    }

    setLoading(true);
    setError(null);
    setPulls([]);
    setSelectedPullNumber(null);

    try {
      const fetchedPulls = await apiFetchGitHubPulls(owner.trim(), repo.trim(), 30);
      setPulls(fetchedPulls);
      if (fetchedPulls.length === 0) {
        setError("No open pull requests found");
      }
    } catch (err: any) {
      setError(err.message || "Failed to fetch pull requests");
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
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  // Detect mobile viewport
  useEffect(() => {
    if (!isOpen) return;
    
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    };
    
    // Check initially
    checkMobile();
    
    // Listen for resize
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, [isOpen]);

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
        onClose();
      } catch (err: any) {
        if (err.message?.includes("already imported")) {
          setError(err.message);
        } else {
          setError(err.message || "Failed to import issue");
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
        onClose();
      } catch (err: any) {
        if (err.message?.includes("already imported")) {
          setError(err.message);
        } else {
          setError(err.message || "Failed to import pull request");
        }
      } finally {
        setImporting(false);
      }
    }
  }, [activeTab, selectedIssueNumber, selectedPullNumber, owner, repo, onImport, onClose]);

  const selectedIssue = issues.find((i) => i.number === selectedIssueNumber);
  const selectedPull = pulls.find((p) => p.number === selectedPullNumber);

  if (!isOpen) return null;

  // Determine state flags
  const hasRemotes = remotes.length > 0;
  const singleRemote = remotes.length === 1;
  const multipleRemotes = remotes.length > 1;

  // Tab-specific counts
  const importedIssueCount = issues.filter((issue) => importedUrls.has(issue.html_url)).length;
  const importedPullCount = pulls.filter((pull) => importedUrls.has(pull.html_url)).length;

  // Empty states
  const isIssuesEmpty = error === "No open issues found";
  const isPullsEmpty = error === "No open pull requests found";
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

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg github-import-modal">
        <div className="modal-header github-import-modal__header">
          <div>
            <h3>Import from GitHub</h3>
            <p className="github-import-modal__subtitle">
              Choose a detected remote, load open issues or pull requests, and import one into the board.
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close import modal">
            &times;
          </button>
        </div>

        <div className="modal-body github-import-modal__body">
          {/* Tab Navigation */}
          <div className="github-import-tabs" role="tablist" aria-label="Import type">
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
              <span>Issues</span>
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
              <span>Pull Requests</span>
            </button>
          </div>

          {/* Compact Toolbar */}
          <div className="github-import-toolbar" data-testid="github-import-toolbar" role="toolbar" aria-label="GitHub import controls">
            {/* Left: Remote selector */}
            <div className="github-import-toolbar__zone github-import-toolbar__zone--remote">
              {loadingRemotes ? (
                <div className="github-import-toolbar__loading" role="status" aria-live="polite">
                  <Loader2 size={16} className="spin" />
                  <span>Detecting…</span>
                </div>
              ) : !hasRemotes ? (
                <span className="github-import-toolbar__no-remote">No remotes</span>
              ) : singleRemote ? (
                <div className="github-import-remote-pill" data-testid="github-import-single-remote">
                  <span className="github-import-remote-pill__name">{remotes[0].name}</span>
                  <span className="github-import-remote-pill__repo">{remotes[0].owner}/{remotes[0].repo}</span>
                </div>
              ) : (
                <div className="github-import-remote-select">
                  <label htmlFor="gh-remote" className="visually-hidden">Repository</label>
                  <select
                    id="gh-remote"
                    value={selectedRemoteName}
                    onChange={(e) => handleRemoteChange(e.target.value)}
                    disabled={loading || importing}
                    aria-label="Select Git remote"
                  >
                    <option value="">Select remote…</option>
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
                  <label htmlFor="gh-labels" className="visually-hidden">Filter by labels</label>
                  <input
                    id="gh-labels"
                    type="text"
                    placeholder="Filter: bug,enhancement…"
                    value={labels}
                    onChange={(e) => setLabels(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleLoad()}
                    disabled={loading || importing || !hasRemotes}
                    aria-label="Filter issues by labels"
                  />
                </>
              ) : (
                <span className="github-import-filter-hint">
                  Open pull requests from {owner || "selected remote"}
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
                aria-label={loading ? `Loading ${activeTab}` : `Load ${activeTab} from repository`}
                title={loading ? "Loading…" : `Load ${activeTab}`}
              >
                {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                <span>{loading ? "Loading…" : "Load"}</span>
              </button>
            </div>
          </div>

          {/* Warning/Error states below toolbar */}
          {!loadingRemotes && !hasRemotes && (
            <div className="github-import-state github-import-state--warning" role="alert">
              <div>
                <strong>No GitHub remotes detected</strong>
                <span>Add a GitHub remote to this repository, then reopen the modal.</span>
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
              data-testid="github-import-list-pane"
              aria-labelledby="github-import-results-heading"
            >
              <div className="github-import-pane-header">
                <h4 id="github-import-results-heading">
                  {activeTab === "issues" ? "Issues" : "Pull Requests"}
                </h4>
                {activeTab === "issues" && issues.length > 0 && (
                  <div className="github-import-results-meta" aria-live="polite">
                    <span>{issues.length} issue{issues.length === 1 ? "" : "s"}</span>
                    <span>{importedIssueCount} imported</span>
                  </div>
                )}
                {activeTab === "pulls" && pulls.length > 0 && (
                  <div className="github-import-results-meta" aria-live="polite">
                    <span>{pulls.length} pull request{pulls.length === 1 ? "" : "s"}</span>
                    <span>{importedPullCount} imported</span>
                  </div>
                )}
              </div>

              <div className="github-import-pane-content">
                {!hasResultsContent && (
                  <div className="github-import-state github-import-state--idle" data-testid="github-import-results-idle">
                    <div>
                      <strong>Nothing loaded yet</strong>
                      <span>Select a repository and click Load to start reviewing import candidates.</span>
                    </div>
                  </div>
                )}

                {loading && (
                  <div className="github-import-state github-import-state--loading" role="status" aria-live="polite">
                    <Loader2 size={16} className="spin" />
                    <div>
                      <strong>Loading open {activeTab === "issues" ? "issues" : "pull requests"}…</strong>
                      <span>Fetching the latest list from GitHub.</span>
                    </div>
                  </div>
                )}

                {isResultsError && (
                  <div className="github-import-state github-import-state--error" role="alert">
                    <div>
                      <strong>Could not load {activeTab === "issues" ? "issues" : "pull requests"}</strong>
                      <span>{error}</span>
                    </div>
                  </div>
                )}

                {isEmptyState && (
                  <div className="github-import-state github-import-state--empty" role="status">
                    <div>
                      <strong>No open {activeTab === "issues" ? "issues" : "pull requests"} found</strong>
                      <span>{activeTab === "issues" ? "Try a different label filter or choose another repository." : "Choose another repository."}</span>
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
                            aria-label={`Select issue #${issue.number}`}
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
                          {isImported && <span className="imported-badge">Imported</span>}
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
                            aria-label={`Select pull request #${pull.number}`}
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
                          {isImported && <span className="imported-badge">Imported</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

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
                    aria-label={`Back to ${activeTab === "issues" ? "issues" : "pull requests"} list`}
                  >
                    <ArrowLeft size={16} />
                    <span>Back</span>
                  </button>
                )}
                <h4 id="github-import-preview-heading">Preview</h4>
              </div>

              <div className="github-import-pane-content">
                {/* Issue preview */}
                {activeTab === "issues" && selectedIssue ? (
                  <div className="issue-preview" data-testid="github-import-preview-card">
                    <div className="preview-meta">Issue #{selectedIssue.number}</div>
                    <div className="preview-title">{selectedIssue.title}</div>
                    <div className="preview-body">
                      {selectedIssue.body
                        ? selectedIssue.body.slice(0, 200) + (selectedIssue.body.length > 200 ? "…" : "")
                        : "(no description)"}
                    </div>
                  </div>
                ) : activeTab === "issues" ? (
                  <div className="github-import-state github-import-state--idle" data-testid="github-import-preview-empty">
                    <div>
                      <strong>No issue selected</strong>
                      <span>Choose an issue from the list to inspect its title and description.</span>
                    </div>
                  </div>
                ) : null}

                {/* Pull request preview */}
                {activeTab === "pulls" && selectedPull ? (
                  <div className="issue-preview" data-testid="github-import-preview-card">
                    <div className="preview-meta">Pull Request #{selectedPull.number}</div>
                    <div className="preview-title">{selectedPull.title}</div>
                    <div className="preview-branch">
                      <strong>Branch:</strong> {selectedPull.headBranch} → {selectedPull.baseBranch}
                    </div>
                    <div className="preview-body">
                      {selectedPull.body
                        ? selectedPull.body.slice(0, 200) + (selectedPull.body.length > 200 ? "…" : "")
                        : "(no description)"}
                    </div>
                  </div>
                ) : activeTab === "pulls" ? (
                  <div className="github-import-state github-import-state--idle" data-testid="github-import-preview-empty">
                    <div>
                      <strong>No pull request selected</strong>
                      <span>Choose a pull request from the list to inspect its details.</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </div>

        <div className="modal-actions github-import-modal__actions">
          <button className="btn" onClick={onClose} disabled={importing}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleImport}
            disabled={
              (activeTab === "issues" ? selectedIssueNumber === null : selectedPullNumber === null) || importing
            }
          >
            {importing ? <Loader2 size={14} className="spin" /> : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
