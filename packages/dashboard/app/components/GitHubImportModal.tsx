import { useState, useEffect, useCallback, useRef } from "react";
import type { Task } from "@kb/core";
import { apiFetchGitHubIssues, apiImportGitHubIssue, fetchGitRemotes, type GitHubIssue, type GitRemote } from "../api";
import { Loader2, RefreshCw, ArrowLeft } from "lucide-react";

interface GitHubImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (task: Task) => void;
  tasks: Task[];
}

// Mobile breakpoint in pixels
const MOBILE_BREAKPOINT = 640;

export function GitHubImportModal({ isOpen, onClose, onImport, tasks }: GitHubImportModalProps) {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [labels, setLabels] = useState("");
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // Git remotes state
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [loadingRemotes, setLoadingRemotes] = useState(false);
  const [selectedRemoteName, setSelectedRemoteName] = useState<string>("");
  const mountedRef = useRef(false);
  
  // Mobile view state
  const [isMobile, setIsMobile] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'preview'>('list');
  
  // Track which owner/repo we've already auto-loaded to prevent duplicate loads
  const autoLoadedRef = useRef<{ owner: string; repo: string; labels: string } | null>(null);

  // Build set of already imported URLs from existing tasks
  const importedUrls = new Set<string>();
  for (const task of tasks) {
    const match = task.description.match(/Source: (https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+)/);
    if (match) {
      importedUrls.add(match[1]);
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

  // Auto-load issues when owner and repo are set and valid
  useEffect(() => {
    if (!isOpen) return;
    if (!owner.trim() || !repo.trim()) return;
    if (loading || importing) return;
    
    // Check if we've already auto-loaded for this exact combination
    const currentKey = { owner: owner.trim(), repo: repo.trim(), labels: labels.trim() };
    if (
      autoLoadedRef.current?.owner === currentKey.owner &&
      autoLoadedRef.current?.repo === currentKey.repo &&
      autoLoadedRef.current?.labels === currentKey.labels
    ) {
      return;
    }
    
    // Mark as auto-loaded and trigger the load
    autoLoadedRef.current = currentKey;
    handleLoad();
  }, [owner, repo, labels, isOpen, loading, importing, handleLoad]);

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

  // Handle back button - return to list view on mobile
  const handleBackToList = useCallback(() => {
    setMobileView('list');
    // Optionally clear selection when going back
    // setSelectedIssueNumber(null);
  }, []);

  const handleImport = useCallback(async () => {
    if (selectedIssueNumber === null) return;

    setImporting(true);
    setError(null);

    try {
      const task = await apiImportGitHubIssue(owner.trim(), repo.trim(), selectedIssueNumber);
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
  }, [selectedIssueNumber, owner, repo, onImport, onClose]);

  const selectedIssue = issues.find((i) => i.number === selectedIssueNumber);

  if (!isOpen) return null;

  // Determine state flags
  const hasRemotes = remotes.length > 0;
  const singleRemote = remotes.length === 1;
  const multipleRemotes = remotes.length > 1;
  const importedIssueCount = issues.filter((issue) => importedUrls.has(issue.html_url)).length;
  const isEmptyState = error === "No open issues found";
  const isResultsError = Boolean(error) && !isEmptyState && issues.length === 0 && !loading;
  const hasResultsContent = loading || issues.length > 0 || isEmptyState || isResultsError;
  const showInlineErrorBanner = Boolean(error) && issues.length > 0 && !isEmptyState;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg github-import-modal">
        <div className="modal-header github-import-modal__header">
          <div>
            <h3>Import from GitHub</h3>
            <p className="github-import-modal__subtitle">
              Choose a detected remote, load open issues, and import one into the board.
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close import modal">
            &times;
          </button>
        </div>

        <div className="modal-body github-import-modal__body">
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

            {/* Center: Labels filter */}
            <div className="github-import-toolbar__zone github-import-toolbar__zone--filter">
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
            </div>

            {/* Right: Load button */}
            <div className="github-import-toolbar__zone github-import-toolbar__zone--action">
              <button
                id="gh-load"
                className="btn btn-primary github-import-load-button"
                onClick={handleLoad}
                disabled={loading || importing || !owner.trim() || !repo.trim()}
                aria-label={loading ? "Loading issues" : "Load issues from repository"}
                title={loading ? "Loading…" : "Load issues"}
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
            {/* Left pane: Issue list */}
            <section
              className={`github-import-list-pane ${isMobile ? 'mobile' : ''} ${mobileView === 'list' ? 'active' : ''}`}
              data-testid="github-import-list-pane"
              aria-labelledby="github-import-results-heading"
            >
              <div className="github-import-pane-header">
                <h4 id="github-import-results-heading">Issues</h4>
                {issues.length > 0 && (
                  <div className="github-import-results-meta" aria-live="polite">
                    <span>{issues.length} issue{issues.length === 1 ? "" : "s"}</span>
                    <span>{importedIssueCount} imported</span>
                  </div>
                )}
              </div>

              <div className="github-import-pane-content">
                {!hasResultsContent && (
                  <div className="github-import-state github-import-state--idle" data-testid="github-import-results-idle">
                    <div>
                      <strong>Nothing loaded yet</strong>
                      <span>Select a repository and load issues to start reviewing import candidates.</span>
                    </div>
                  </div>
                )}

                {loading && (
                  <div className="github-import-state github-import-state--loading" role="status" aria-live="polite">
                    <Loader2 size={16} className="spin" />
                    <div>
                      <strong>Loading open issues…</strong>
                      <span>Fetching the latest issue list from GitHub.</span>
                    </div>
                  </div>
                )}

                {isResultsError && (
                  <div className="github-import-state github-import-state--error" role="alert">
                    <div>
                      <strong>Could not load issues</strong>
                      <span>{error}</span>
                    </div>
                  </div>
                )}

                {isEmptyState && (
                  <div className="github-import-state github-import-state--empty" role="status">
                    <div>
                      <strong>No open issues found</strong>
                      <span>Try a different label filter or choose another repository.</span>
                    </div>
                  </div>
                )}

                {issues.length > 0 && (
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
                    aria-label="Back to issues list"
                  >
                    <ArrowLeft size={16} />
                    <span>Back</span>
                  </button>
                )}
                <h4 id="github-import-preview-heading">Preview</h4>
              </div>

              <div className="github-import-pane-content">
                {selectedIssue ? (
                  <div className="issue-preview" data-testid="github-import-preview-card">
                    <div className="preview-meta">Issue #{selectedIssue.number}</div>
                    <div className="preview-title">{selectedIssue.title}</div>
                    <div className="preview-body">
                      {selectedIssue.body
                        ? selectedIssue.body.slice(0, 200) + (selectedIssue.body.length > 200 ? "…" : "")
                        : "(no description)"}
                    </div>
                  </div>
                ) : (
                  <div className="github-import-state github-import-state--idle" data-testid="github-import-preview-empty">
                    <div>
                      <strong>No issue selected</strong>
                      <span>Choose an issue from the list to inspect its title and description.</span>
                    </div>
                  </div>
                )}
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
            disabled={selectedIssueNumber === null || importing}
          >
            {importing ? <Loader2 size={14} className="spin" /> : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
