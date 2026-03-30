import { useState, useEffect, useCallback, useRef } from "react";
import type { Task } from "@kb/core";
import type { ToastType } from "../hooks/useToast";
import type {
  GitStatus,
  GitCommit,
  GitBranch,
  GitWorktree,
  GitFetchResult,
  GitPullResult,
  GitPushResult,
} from "../api";
import {
  fetchGitStatus,
  fetchGitCommits,
  fetchCommitDiff,
  fetchGitBranches,
  fetchGitWorktrees,
  createBranch,
  checkoutBranch,
  deleteBranch,
  fetchRemote,
  pullBranch,
  pushBranch,
} from "../api";
import {
  GitBranch as GitBranchIcon,
  GitCommit,
  GitPullRequest,
  GitMerge,
  RefreshCw,
  Plus,
  Trash2,
  ChevronRight,
  ChevronDown,
  Check,
  X,
  Loader2,
  HardDrive,
  Radio,
  ArrowUp,
  ArrowDown,
  AlertCircle,
} from "lucide-react";

type SectionId = "status" | "commits" | "branches" | "worktrees" | "remotes";

const SECTIONS = [
  { id: "status" as SectionId, label: "Status", icon: Radio },
  { id: "commits" as SectionId, label: "Commits", icon: GitCommit },
  { id: "branches" as SectionId, label: "Branches", icon: GitBranchIcon },
  { id: "worktrees" as SectionId, label: "Worktrees", icon: HardDrive },
  { id: "remotes" as SectionId, label: "Remotes", icon: GitMerge },
];

interface GitManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[];
  addToast: (message: string, type?: ToastType) => void;
}

export function GitManagerModal({ isOpen, onClose, tasks, addToast }: GitManagerModalProps) {
  const [activeSection, setActiveSection] = useState<SectionId>("status");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<{ stat: string; patch: string } | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchBase, setBranchBase] = useState("");
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState<string | null>(null);
  const [lastRemoteResult, setLastRemoteResult] = useState<GitFetchResult | GitPullResult | GitPushResult | null>(null);
  const [commitsLimit, setCommitsLimit] = useState(20);
  const modalRef = useRef<HTMLDivElement>(null);

  // Fetch data when section changes or modal opens
  const fetchSectionData = useCallback(async () => {
    if (!isOpen) return;
    setLoading(true);
    try {
      switch (activeSection) {
        case "status":
          const statusData = await fetchGitStatus();
          setStatus(statusData);
          break;
        case "commits":
          const commitsData = await fetchGitCommits(commitsLimit);
          setCommits(commitsData);
          break;
        case "branches":
          const [branchesData, statusForBranch] = await Promise.all([fetchGitBranches(), fetchGitStatus()]);
          setBranches(branchesData);
          setStatus(statusForBranch);
          break;
        case "worktrees":
          const worktreesData = await fetchGitWorktrees();
          setWorktrees(worktreesData);
          break;
        case "remotes":
          // Just refresh status for remote section
          const remoteStatus = await fetchGitStatus();
          setStatus(remoteStatus);
          break;
      }
    } catch (err: any) {
      addToast(err.message || "Failed to fetch git data", "error");
    } finally {
      setLoading(false);
    }
  }, [activeSection, isOpen, commitsLimit, addToast]);

  useEffect(() => {
    if (isOpen) {
      fetchSectionData();
    }
  }, [fetchSectionData, isOpen]);

  // Keyboard support
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  // Handle commit selection and diff loading
  const handleCommitClick = useCallback(async (hash: string) => {
    if (selectedCommit === hash) {
      setSelectedCommit(null);
      setCommitDiff(null);
      return;
    }
    setSelectedCommit(hash);
    setLoadingDiff(true);
    try {
      const diff = await fetchCommitDiff(hash);
      setCommitDiff(diff);
    } catch (err: any) {
      addToast(err.message || "Failed to load diff", "error");
      setCommitDiff(null);
    } finally {
      setLoadingDiff(false);
    }
  }, [selectedCommit, addToast]);

  // Handle branch creation
  const handleCreateBranch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBranchName.trim()) return;
    setLoading(true);
    try {
      await createBranch(newBranchName.trim(), branchBase.trim() || undefined);
      addToast(`Created branch ${newBranchName}`, "success");
      setNewBranchName("");
      setBranchBase("");
      // Refresh branches
      const branchesData = await fetchGitBranches();
      setBranches(branchesData);
    } catch (err: any) {
      addToast(err.message || "Failed to create branch", "error");
    } finally {
      setLoading(false);
    }
  }, [newBranchName, branchBase, addToast]);

  // Handle branch checkout
  const handleCheckoutBranch = useCallback(async (name: string) => {
    setLoading(true);
    try {
      await checkoutBranch(name);
      addToast(`Switched to ${name}`, "success");
      // Refresh status and branches
      const [statusData, branchesData] = await Promise.all([fetchGitStatus(), fetchGitBranches()]);
      setStatus(statusData);
      setBranches(branchesData);
    } catch (err: any) {
      addToast(err.message || "Failed to checkout branch", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  // Handle branch deletion
  const handleDeleteBranch = useCallback(async (name: string) => {
    if (!confirm(`Delete branch "${name}"?`)) return;
    setLoading(true);
    try {
      await deleteBranch(name);
      addToast(`Deleted branch ${name}`, "success");
      // Refresh branches
      const branchesData = await fetchGitBranches();
      setBranches(branchesData);
    } catch (err: any) {
      if (err.message?.includes("not fully merged")) {
        if (confirm("Branch has unmerged commits. Force delete?")) {
          try {
            await deleteBranch(name, true);
            addToast(`Force deleted branch ${name}`, "success");
            const branchesData = await fetchGitBranches();
            setBranches(branchesData);
          } catch (forceErr: any) {
            addToast(forceErr.message || "Failed to delete branch", "error");
          }
        }
      } else {
        addToast(err.message || "Failed to delete branch", "error");
      }
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  // Handle fetch
  const handleFetch = useCallback(async () => {
    setRemoteLoading("fetch");
    try {
      const result = await fetchRemote();
      setLastRemoteResult(result);
      addToast(result.message || "Fetch completed", result.fetched ? "success" : "info");
      // Refresh status
      const statusData = await fetchGitStatus();
      setStatus(statusData);
    } catch (err: any) {
      addToast(err.message || "Fetch failed", "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast]);

  // Handle pull
  const handlePull = useCallback(async () => {
    setRemoteLoading("pull");
    try {
      const result = await pullBranch();
      setLastRemoteResult(result);
      if (result.conflict) {
        addToast("Merge conflict detected. Resolve manually.", "error");
      } else {
        addToast(result.message || "Pull completed", "success");
      }
      // Refresh status
      const statusData = await fetchGitStatus();
      setStatus(statusData);
    } catch (err: any) {
      addToast(err.message || "Pull failed", "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast]);

  // Handle push
  const handlePush = useCallback(async () => {
    setRemoteLoading("push");
    try {
      const result = await pushBranch();
      setLastRemoteResult(result);
      addToast(result.message || "Push completed", "success");
      // Refresh status
      const statusData = await fetchGitStatus();
      setStatus(statusData);
    } catch (err: any) {
      addToast(err.message || "Push failed", "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast]);

  // Load more commits
  const handleLoadMoreCommits = useCallback(() => {
    setCommitsLimit((prev) => Math.min(prev + 20, 100));
  }, []);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg" ref={modalRef}>
        <div className="modal-header">
          <h3>
            <GitBranchIcon size={18} style={{ marginRight: 8, verticalAlign: "middle" }} />
            Git Manager
          </h3>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="git-manager-layout">
          {/* Sidebar */}
          <nav className="git-manager-sidebar">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  className={`git-manager-nav-item${activeSection === section.id ? " active" : ""}`}
                  onClick={() => setActiveSection(section.id)}
                >
                  <Icon size={16} />
                  {section.label}
                </button>
              );
            })}
          </nav>

          {/* Content */}
          <div className="git-manager-content">
            {loading && (
              <div className="git-manager-loading">
                <Loader2 size={24} className="spin" />
                <span>Loading...</span>
              </div>
            )}

            {/* Status Tab */}
            {activeSection === "status" && status && (
              <div className="git-status-panel">
                <h4>Repository Status</h4>
                <div className="git-status-grid">
                  <div className="git-status-item">
                    <span className="git-status-label">Branch</span>
                    <span className="git-status-value">
                      <GitBranchIcon size={14} />
                      {status.branch}
                    </span>
                  </div>
                  <div className="git-status-item">
                    <span className="git-status-label">Commit</span>
                    <code className="git-status-commit">{status.commit}</code>
                  </div>
                  <div className="git-status-item">
                    <span className="git-status-label">Status</span>
                    <span className={`git-status-badge ${status.isDirty ? "dirty" : "clean"}`}>
                      {status.isDirty ? "Modified" : "Clean"}
                    </span>
                  </div>
                  <div className="git-status-item">
                    <span className="git-status-label">Remote</span>
                    <span className="git-status-value">
                      {status.ahead > 0 && (
                        <span className="git-ahead" title={`${status.ahead} commit(s) ahead`}>
                          <ArrowUp size={12} />
                          {status.ahead}
                        </span>
                      )}
                      {status.behind > 0 && (
                        <span className="git-behind" title={`${status.behind} commit(s) behind`}>
                          <ArrowDown size={12} />
                          {status.behind}
                        </span>
                      )}
                      {status.ahead === 0 && status.behind === 0 && (
                        <span className="git-in-sync">Up to date</span>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Commits Tab */}
            {activeSection === "commits" && (
              <div className="git-commits-panel">
                <h4>Recent Commits</h4>
                <div className="git-commits-list">
                  {commits.map((commit) => (
                    <div key={commit.hash} className="git-commit-item">
                      <button
                        className="git-commit-header"
                        onClick={() => handleCommitClick(commit.hash)}
                      >
                        {selectedCommit === commit.hash ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                        <code className="git-commit-hash">{commit.shortHash}</code>
                        <span className="git-commit-message" title={commit.message}>
                          {commit.message}
                        </span>
                        <span className="git-commit-meta">
                          {commit.author} • {new Date(commit.date).toLocaleDateString()}
                        </span>
                      </button>
                      {selectedCommit === commit.hash && (
                        <div className="git-commit-diff">
                          {loadingDiff ? (
                            <div className="git-diff-loading">
                              <Loader2 size={16} className="spin" />
                              Loading diff...
                            </div>
                          ) : commitDiff ? (
                            <>
                              <pre className="git-diff-stat">{commitDiff.stat}</pre>
                              <pre className="git-diff-patch">{commitDiff.patch}</pre>
                            </>
                          ) : (
                            <div className="git-diff-error">Failed to load diff</div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {commits.length >= commitsLimit && commitsLimit < 100 && (
                  <button className="git-load-more" onClick={handleLoadMoreCommits}>
                    Load more commits
                  </button>
                )}
              </div>
            )}

            {/* Branches Tab */}
            {activeSection === "branches" && (
              <div className="git-branches-panel">
                <h4>Branches</h4>
                
                {/* Create branch form */}
                <form className="git-create-branch-form" onSubmit={handleCreateBranch}>
                  <input
                    type="text"
                    placeholder="New branch name"
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    disabled={loading}
                  />
                  <input
                    type="text"
                    placeholder="Base branch (optional)"
                    value={branchBase}
                    onChange={(e) => setBranchBase(e.target.value)}
                    disabled={loading}
                  />
                  <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !newBranchName.trim()}>
                    <Plus size={14} />
                    Create
                  </button>
                </form>

                {/* Branches list */}
                <div className="git-branches-list">
                  {branches.map((branch) => (
                    <div
                      key={branch.name}
                      className={`git-branch-item ${branch.isCurrent ? "current" : ""}`}
                    >
                      <span className="git-branch-name">
                        {branch.isCurrent && <Check size={14} className="git-branch-current-icon" />}
                        {branch.name}
                        {branch.remote && (
                          <span className="git-branch-remote">→ {branch.remote}</span>
                        )}
                      </span>
                      <div className="git-branch-actions">
                        {!branch.isCurrent && (
                          <>
                            <button
                              className="btn btn-sm"
                              onClick={() => handleCheckoutBranch(branch.name)}
                              disabled={loading}
                              title="Checkout"
                            >
                              <GitBranchIcon size={14} />
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => handleDeleteBranch(branch.name)}
                              disabled={loading}
                              title="Delete"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Worktrees Tab */}
            {activeSection === "worktrees" && (
              <div className="git-worktrees-panel">
                <h4>Worktrees</h4>
                <div className="git-worktrees-stats">
                  <span>{worktrees.length} total</span>
                  <span>{worktrees.filter((w) => w.taskId).length} in use by tasks</span>
                </div>
                <div className="git-worktrees-list">
                  {worktrees.map((worktree) => (
                    <div
                      key={worktree.path}
                      className={`git-worktree-item ${worktree.isMain ? "main" : ""}`}
                    >
                      <div className="git-worktree-info">
                        <span className="git-worktree-path" title={worktree.path}>
                          {worktree.isMain && <span className="git-worktree-badge main">main</span>}
                          {worktree.isBare && <span className="git-worktree-badge bare">bare</span>}
                          {worktree.path}
                        </span>
                        {worktree.branch && (
                          <span className="git-worktree-branch">
                            <GitBranchIcon size={12} />
                            {worktree.branch}
                          </span>
                        )}
                      </div>
                      {worktree.taskId && (
                        <span className="git-worktree-task">{worktree.taskId}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Remotes Tab */}
            {activeSection === "remotes" && (
              <div className="git-remotes-panel">
                <h4>Remote Operations</h4>
                
                {status && (status.ahead > 0 || status.behind > 0) && (
                  <div className="git-remote-status">
                    {status.ahead > 0 && (
                      <div className="git-remote-ahead">
                        <AlertCircle size={16} />
                        {status.ahead} commit(s) to push
                      </div>
                    )}
                    {status.behind > 0 && (
                      <div className="git-remote-behind">
                        <AlertCircle size={16} />
                        {status.behind} commit(s) to pull
                      </div>
                    )}
                  </div>
                )}

                <div className="git-remote-actions">
                  <button
                    className="btn btn-primary"
                    onClick={handleFetch}
                    disabled={remoteLoading !== null}
                  >
                    {remoteLoading === "fetch" ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Fetch
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={handlePull}
                    disabled={remoteLoading !== null}
                  >
                    {remoteLoading === "pull" ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <GitPullRequest size={14} />
                    )}
                    Pull
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={handlePush}
                    disabled={remoteLoading !== null || (status?.ahead === 0 && false)}
                  >
                    {remoteLoading === "push" ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <ArrowUp size={14} />
                    )}
                    Push
                  </button>
                </div>

                {lastRemoteResult && (
                  <div className={`git-remote-result ${"fetched" in lastRemoteResult ? "fetch" : "success" in lastRemoteResult ? (lastRemoteResult as GitPullResult).conflict ? "conflict" : (lastRemoteResult as GitPullResult).success ? "success" : "error" : "success" in lastRemoteResult ? (lastRemoteResult as GitPushResult).success ? "success" : "error" : ""}`}>
                    {lastRemoteResult.message}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
