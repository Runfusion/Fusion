import { useState, useEffect, useCallback, useRef } from "react";
import type { Task } from "@kb/core";
import { apiFetchGitHubIssues, apiImportGitHubIssue, fetchGitRemotes, type GitHubIssue, type GitRemote } from "../api";
import { Loader2 } from "lucide-react";

interface GitHubImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (task: Task) => void;
  tasks: Task[];
}

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

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

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

  // Determine the repository selection UI state
  const hasRemotes = remotes.length > 0;
  const singleRemote = remotes.length === 1;
  const multipleRemotes = remotes.length > 1;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3>Import from GitHub</h3>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          {/* Repository Selection Section */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="gh-remote">
                Repository
                {loadingRemotes && <Loader2 size={12} className="spin" style={{ marginLeft: 8, display: "inline" }} />}
              </label>

              {/* Loading state */}
              {loadingRemotes && (
                <span className="text-muted">Loading remotes...</span>
              )}

              {/* No remotes */}
              {!loadingRemotes && !hasRemotes && (
                <div className="form-error">
                  No GitHub remotes detected. Add a remote with:
                  <code style={{ display: "block", marginTop: 4, padding: 4, background: "#f5f5f5", borderRadius: 4 }}>
                    git remote add origin https://github.com/owner/repo.git
                  </code>
                </div>
              )}

              {/* Single remote - read only display */}
              {!loadingRemotes && singleRemote && (
                <span className="text-muted">
                  {remotes[0].name} ({remotes[0].owner}/{remotes[0].repo})
                </span>
              )}

              {/* Multiple remotes - dropdown */}
              {!loadingRemotes && multipleRemotes && (
                <select
                  id="gh-remote"
                  value={selectedRemoteName}
                  onChange={(e) => handleRemoteChange(e.target.value)}
                  disabled={loading || importing}
                >
                  <option value="">Select a remote...</option>
                  {remotes.map((remote) => (
                    <option key={remote.name} value={remote.name}>
                      {remote.name} ({remote.owner}/{remote.repo})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="gh-labels">Labels (optional)</label>
              <input
                id="gh-labels"
                type="text"
                placeholder="bug,enhancement"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLoad()}
                disabled={loading || importing}
              />
            </div>

            <div className="form-group form-group--action">
              <label>&nbsp;</label>
              <button
                className="btn btn-primary"
                onClick={handleLoad}
                disabled={loading || importing || !owner.trim() || !repo.trim()}
              >
                {loading ? <Loader2 size={14} className="spin" /> : "Load"}
              </button>
            </div>
          </div>

          {/* Error Display */}
          {error && <div className="form-error">{error}</div>}

          {/* Issues List */}
          {issues.length > 0 && (
            <>
              <div className="issues-list">
                <h4>Found {issues.length} issues:</h4>
                {issues.map((issue) => {
                  const isImported = importedUrls.has(issue.html_url);
                  return (
                    <div
                      key={issue.number}
                      className={`issue-item ${selectedIssueNumber === issue.number ? "selected" : ""} ${isImported ? "imported" : ""}`}
                      onClick={() => !isImported && setSelectedIssueNumber(issue.number)}
                    >
                      <input
                        type="radio"
                        name="issue"
                        checked={selectedIssueNumber === issue.number}
                        onChange={() => setSelectedIssueNumber(issue.number)}
                        disabled={isImported}
                      />
                      <span className="issue-number">#{issue.number}</span>
                      <span className="issue-title">{issue.title}</span>
                      {issue.labels.length > 0 && (
                        <span className="issue-labels">
                          {issue.labels.map((l) => (
                            <span key={l.name} className="label-chip">
                              {l.name}
                            </span>
                          ))}
                        </span>
                      )}
                      {isImported && <span className="imported-badge">Imported</span>}
                    </div>
                  );
                })}
              </div>

              {/* Preview */}
              {selectedIssue && (
                <div className="issue-preview">
                  <h4>Preview</h4>
                  <div className="preview-title">{selectedIssue.title}</div>
                  <div className="preview-body">
                    {selectedIssue.body
                      ? selectedIssue.body.slice(0, 200) + (selectedIssue.body.length > 200 ? "…" : "")
                      : "(no description)"}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-actions">
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
