import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { Task } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import type {
  GitStatus,
  GitCommit,
  GitBranch,
  GitWorktree,
  GitFetchResult,
  GitPullResult,
  GitPushResult,
  GitStash,
  GitFileChange,
  GitRemoteDetailed,
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
  fetchGitStashList,
  createStash,
  applyStash,
  dropStash,
  fetchFileChanges,
  stageFiles,
  unstageFiles,
  createCommit,
  discardChanges,
  fetchUnstagedDiff,
  fetchGitRemotesDetailed,
  addGitRemote,
  removeGitRemote,
  renameGitRemote,
  updateGitRemoteUrl,
  fetchAheadCommits,
  fetchRemoteCommits,
  fetchBranchCommits,
} from "../api";
import {
  GitBranch as GitBranchIcon,
  GitCommit as GitCommitIcon,
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
  Copy,
  Search,
  FileText,
  FolderGit2,
  Archive,
  FilePlus,
  FileMinus,
  FileEdit,
  FileQuestion,
  FileDiff,
  CheckCircle,
  XCircle,
  Send,
  Pencil,
} from "lucide-react";

// ── Types & Constants ─────────────────────────────────────────────

type SectionId = "status" | "changes" | "commits" | "branches" | "worktrees" | "stashes" | "remotes";

const SECTIONS: { id: SectionId; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "status", label: "Status", icon: Radio },
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "commits", label: "Commits", icon: GitCommitIcon },
  { id: "branches", label: "Branches", icon: GitBranchIcon },
  { id: "worktrees", label: "Worktrees", icon: HardDrive },
  { id: "stashes", label: "Stashes", icon: Archive },
  { id: "remotes", label: "Remotes", icon: GitMerge },
];

// ── Helper Utilities ──────────────────────────────────────────────

/** Icon for a file change status */
function FileStatusIcon({ status }: { status: GitFileChange["status"] }) {
  switch (status) {
    case "added":
    case "untracked":
      return <FilePlus size={14} className="gm-file-icon gm-file-added" />;
    case "modified":
      return <FileEdit size={14} className="gm-file-icon gm-file-modified" />;
    case "deleted":
      return <FileMinus size={14} className="gm-file-icon gm-file-deleted" />;
    case "renamed":
    case "copied":
      return <FileText size={14} className="gm-file-icon gm-file-renamed" />;
    default:
      return <FileQuestion size={14} className="gm-file-icon" />;
  }
}

/** Label badge for file status */
function FileStatusBadge({ status }: { status: GitFileChange["status"] }) {
  const label =
    status === "untracked" ? "U" :
    status === "added" ? "A" :
    status === "modified" ? "M" :
    status === "deleted" ? "D" :
    status === "renamed" ? "R" :
    status === "copied" ? "C" : "?";
  return <span className={`gm-file-badge gm-file-badge-${status}`}>{label}</span>;
}

/** Copy text to clipboard with toast feedback */
function useCopyToClipboard(addToast: (msg: string, type?: ToastType) => void) {
  return useCallback(
    async (text: string, label?: string) => {
      try {
        await navigator.clipboard.writeText(text);
        addToast(`Copied ${label || "to clipboard"}`, "success");
      } catch {
        addToast("Failed to copy", "error");
      }
    },
    [addToast]
  );
}

/** Format relative date. Returns "—" for invalid/empty dates. */
function relativeDate(dateStr: string | undefined | null): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ── Props ─────────────────────────────────────────────────────────

interface GitManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[];
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
}

// ── Main Component ────────────────────────────────────────────────

export function GitManagerModal({ isOpen, onClose, tasks, addToast, projectId }: GitManagerModalProps) {
  const [activeSection, setActiveSection] = useState<SectionId>("status");
  const [loading, setLoading] = useState(false);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const copyToClipboard = useCopyToClipboard(addToast);

  // ── Status state
  const [status, setStatus] = useState<GitStatus | null>(null);

  // ── Changes state
  const [fileChanges, setFileChanges] = useState<GitFileChange[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [changeDiff, setChangeDiff] = useState<{ stat: string; patch: string } | null>(null);
  const [loadingChangeDiff, setLoadingChangeDiff] = useState(false);

  // ── Commits state
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<{ stat: string; patch: string } | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [commitsLimit, setCommitsLimit] = useState(20);
  const [commitSearch, setCommitSearch] = useState("");

  // ── Branches state
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchBase, setBranchBase] = useState("");
  const [branchSearch, setBranchSearch] = useState("");
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [branchCommits, setBranchCommits] = useState<GitCommit[]>([]);
  const [loadingBranchCommits, setLoadingBranchCommits] = useState(false);
  const [expandedBranchCommit, setExpandedBranchCommit] = useState<string | null>(null);
  const [branchCommitDiff, setBranchCommitDiff] = useState<{ stat: string; patch: string } | null>(null);
  const [loadingBranchCommitDiff, setLoadingBranchCommitDiff] = useState(false);

  // ── Worktrees state
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);

  // ── Stashes state
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [stashMessage, setStashMessage] = useState("");
  const [stashLoading, setStashLoading] = useState<string | null>(null);

  // ── Remotes state
  const [remoteLoading, setRemoteLoading] = useState<string | null>(null);
  const [lastRemoteResult, setLastRemoteResult] = useState<GitFetchResult | GitPullResult | GitPushResult | null>(null);

  // ── Data Fetching ───────────────────────────────────────────────

  const fetchSectionData = useCallback(async () => {
    if (!isOpen) return;
    setLoading(true);
    setSectionError(null);
    try {
      switch (activeSection) {
        case "status": {
          const statusData = await fetchGitStatus(projectId);
          setStatus(statusData);
          break;
        }
        case "changes": {
          const [statusData, changes] = await Promise.all([fetchGitStatus(projectId), fetchFileChanges(projectId)]);
          setStatus(statusData);
          setFileChanges(changes);
          setSelectedFiles(new Set());
          break;
        }
        case "commits": {
          const commitsData = await fetchGitCommits(commitsLimit, projectId);
          setCommits(commitsData);
          break;
        }
        case "branches": {
          const [branchesData, statusForBranch] = await Promise.all([fetchGitBranches(projectId), fetchGitStatus(projectId)]);
          setBranches(branchesData);
          setStatus(statusForBranch);
          break;
        }
        case "worktrees": {
          const worktreesData = await fetchGitWorktrees(projectId);
          setWorktrees(worktreesData);
          break;
        }
        case "stashes": {
          const stashesData = await fetchGitStashList(projectId);
          setStashes(stashesData);
          break;
        }
        case "remotes": {
          const remoteStatus = await fetchGitStatus(projectId);
          setStatus(remoteStatus);
          break;
        }
      }
    } catch (err: any) {
      setSectionError(err.message || "Failed to fetch git data");
      addToast(err.message || "Failed to fetch git data", "error");
    } finally {
      setLoading(false);
    }
  }, [activeSection, isOpen, commitsLimit, addToast, projectId]);

  useEffect(() => {
    if (isOpen) {
      fetchSectionData();
    }
  }, [fetchSectionData, isOpen]);

  // ── Keyboard Navigation ─────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Arrow key navigation between sections
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey) {
        e.preventDefault();
        const currentIndex = SECTIONS.findIndex((s) => s.id === activeSection);
        if (e.key === "ArrowUp" && currentIndex > 0) {
          setActiveSection(SECTIONS[currentIndex - 1].id);
        } else if (e.key === "ArrowDown" && currentIndex < SECTIONS.length - 1) {
          setActiveSection(SECTIONS[currentIndex + 1].id);
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose, activeSection]);

  // ── Changes Handlers ────────────────────────────────────────────

  const handleStageFiles = useCallback(async (files: string[]) => {
    try {
      await stageFiles(files, projectId);
      addToast(`Staged ${files.length} file(s)`, "success");
      const changes = await fetchFileChanges(projectId);
      setFileChanges(changes);
      setSelectedFiles(new Set());
    } catch (err: any) {
      addToast(err.message || "Failed to stage files", "error");
    }
  }, [addToast, projectId]);

  const handleUnstageFiles = useCallback(async (files: string[]) => {
    try {
      await unstageFiles(files, projectId);
      addToast(`Unstaged ${files.length} file(s)`, "success");
      const changes = await fetchFileChanges(projectId);
      setFileChanges(changes);
      setSelectedFiles(new Set());
    } catch (err: any) {
      addToast(err.message || "Failed to unstage files", "error");
    }
  }, [addToast, projectId]);

  const handleDiscardChanges = useCallback(async (files: string[]) => {
    if (!confirm(`Discard changes to ${files.length} file(s)? This cannot be undone.`)) return;
    try {
      await discardChanges(files, projectId);
      addToast(`Discarded changes to ${files.length} file(s)`, "success");
      const [changes, statusData] = await Promise.all([fetchFileChanges(projectId), fetchGitStatus(projectId)]);
      setFileChanges(changes);
      setStatus(statusData);
      setSelectedFiles(new Set());
    } catch (err: any) {
      addToast(err.message || "Failed to discard changes", "error");
    }
  }, [addToast, projectId]);

  const handleCommit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commitMessage.trim()) return;
    setCommitting(true);
    try {
      const result = await createCommit(commitMessage.trim(), projectId);
      addToast(`Committed: ${result.hash}`, "success");
      setCommitMessage("");
      // Refresh changes and status
      const [changes, statusData] = await Promise.all([fetchFileChanges(projectId), fetchGitStatus(projectId)]);
      setFileChanges(changes);
      setStatus(statusData);
    } catch (err: any) {
      addToast(err.message || "Failed to commit", "error");
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, addToast, projectId]);

  const handleStageAllAndCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    try {
      const unstaged = fileChanges.filter((f) => !f.staged).map((f) => f.file);
      if (unstaged.length > 0) {
        await stageFiles(unstaged, projectId);
      }
      const result = await createCommit(commitMessage.trim(), projectId);
      addToast(`Committed: ${result.hash}`, "success");
      setCommitMessage("");
      const [changes, statusData] = await Promise.all([fetchFileChanges(projectId), fetchGitStatus(projectId)]);
      setFileChanges(changes);
      setStatus(statusData);
    } catch (err: any) {
      addToast(err.message || "Failed to commit", "error");
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, fileChanges, addToast, projectId]);

  const handleViewDiff = useCallback(async () => {
    setLoadingChangeDiff(true);
    try {
      const diff = await fetchUnstagedDiff(projectId);
      setChangeDiff(diff);
    } catch (err: any) {
      addToast(err.message || "Failed to load diff", "error");
    } finally {
      setLoadingChangeDiff(false);
    }
  }, [addToast, projectId]);

  const toggleFileSelection = useCallback((file: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) {
        next.delete(file);
      } else {
        next.add(file);
      }
      return next;
    });
  }, []);

  // ── Commit Handlers ─────────────────────────────────────────────

  const handleCommitClick = useCallback(async (hash: string) => {
    if (selectedCommit === hash) {
      setSelectedCommit(null);
      setCommitDiff(null);
      return;
    }
    setSelectedCommit(hash);
    setLoadingDiff(true);
    try {
      const diff = await fetchCommitDiff(hash, projectId);
      setCommitDiff(diff);
    } catch (err: any) {
      addToast(err.message || "Failed to load diff", "error");
      setCommitDiff(null);
    } finally {
      setLoadingDiff(false);
    }
  }, [selectedCommit, addToast, projectId]);

  const handleLoadMoreCommits = useCallback(() => {
    setCommitsLimit((prev) => Math.min(prev + 20, 100));
  }, []);

  const filteredCommits = useMemo(() => {
    if (!commitSearch.trim()) return commits;
    const q = commitSearch.toLowerCase();
    return commits.filter(
      (c) =>
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.shortHash.toLowerCase().includes(q)
    );
  }, [commits, commitSearch]);

  // ── Branch Handlers ─────────────────────────────────────────────

  const handleCreateBranch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBranchName.trim()) return;
    setLoading(true);
    try {
      await createBranch(newBranchName.trim(), branchBase.trim() || undefined, projectId);
      addToast(`Created branch ${newBranchName}`, "success");
      setNewBranchName("");
      setBranchBase("");
      const branchesData = await fetchGitBranches(projectId);
      setBranches(branchesData);
    } catch (err: any) {
      addToast(err.message || "Failed to create branch", "error");
    } finally {
      setLoading(false);
    }
  }, [newBranchName, branchBase, addToast, projectId]);

  const handleCheckoutBranch = useCallback(async (name: string) => {
    setLoading(true);
    try {
      await checkoutBranch(name, projectId);
      addToast(`Switched to ${name}`, "success");
      const [statusData, branchesData] = await Promise.all([fetchGitStatus(projectId), fetchGitBranches(projectId)]);
      setStatus(statusData);
      setBranches(branchesData);
    } catch (err: any) {
      addToast(err.message || "Failed to checkout branch", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, projectId]);

  const handleDeleteBranch = useCallback(async (name: string) => {
    if (!confirm(`Delete branch "${name}"?`)) return;
    setLoading(true);
    try {
      await deleteBranch(name, undefined, projectId);
      addToast(`Deleted branch ${name}`, "success");
      const branchesData = await fetchGitBranches(projectId);
      setBranches(branchesData);
    } catch (err: any) {
      if (err.message?.includes("not fully merged")) {
        if (confirm("Branch has unmerged commits. Force delete?")) {
          try {
            await deleteBranch(name, true, projectId);
            addToast(`Force deleted branch ${name}`, "success");
            const branchesData = await fetchGitBranches(projectId);
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
  }, [addToast, projectId]);

  const filteredBranches = useMemo(() => {
    if (!branchSearch.trim()) return branches;
    const q = branchSearch.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, branchSearch]);

  // ── Branch Selection Handlers ───────────────────────────────────

  /** Toggle branch selection to show commits for that branch */
  const handleSelectBranch = useCallback(async (name: string) => {
    if (selectedBranch === name) {
      // Deselect
      setSelectedBranch(null);
      setBranchCommits([]);
      setExpandedBranchCommit(null);
      setBranchCommitDiff(null);
      return;
    }
    setSelectedBranch(name);
    setBranchCommits([]);
    setExpandedBranchCommit(null);
    setBranchCommitDiff(null);
    setLoadingBranchCommits(true);
    try {
      const data = await fetchBranchCommits(name, 10, projectId);
      setBranchCommits(data);
    } catch {
      setBranchCommits([]);
    } finally {
      setLoadingBranchCommits(false);
    }
  }, [selectedBranch, projectId]);

  /** Click a commit in the branch view to expand/collapse its diff */
  const handleBranchCommitClick = useCallback(async (hash: string) => {
    if (expandedBranchCommit === hash) {
      setExpandedBranchCommit(null);
      setBranchCommitDiff(null);
      return;
    }
    setExpandedBranchCommit(hash);
    setBranchCommitDiff(null);
    setLoadingBranchCommitDiff(true);
    try {
      const diff = await fetchCommitDiff(hash, projectId);
      setBranchCommitDiff(diff);
    } catch {
      setBranchCommitDiff(null);
    } finally {
      setLoadingBranchCommitDiff(false);
    }
  }, [expandedBranchCommit, projectId]);

  /** Close branch details panel */
  const handleCloseBranchDetails = useCallback(() => {
    setSelectedBranch(null);
    setBranchCommits([]);
    setExpandedBranchCommit(null);
    setBranchCommitDiff(null);
  }, []);

  // ── Stash Handlers ──────────────────────────────────────────────

  const handleCreateStash = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setStashLoading("create");
    try {
      await createStash(stashMessage.trim() || undefined, projectId);
      addToast("Changes stashed", "success");
      setStashMessage("");
      const stashesData = await fetchGitStashList(projectId);
      setStashes(stashesData);
    } catch (err: any) {
      addToast(err.message || "Failed to stash changes", "error");
    } finally {
      setStashLoading(null);
    }
  }, [stashMessage, addToast, projectId]);

  const handleApplyStash = useCallback(async (index: number, drop: boolean = false) => {
    setStashLoading(`apply-${index}`);
    try {
      await applyStash(index, drop, projectId);
      addToast(drop ? "Stash popped" : "Stash applied", "success");
      const stashesData = await fetchGitStashList(projectId);
      setStashes(stashesData);
    } catch (err: any) {
      addToast(err.message || "Failed to apply stash", "error");
    } finally {
      setStashLoading(null);
    }
  }, [addToast, projectId]);

  const handleDropStash = useCallback(async (index: number) => {
    if (!confirm(`Drop stash@{${index}}? This cannot be undone.`)) return;
    setStashLoading(`drop-${index}`);
    try {
      await dropStash(index, projectId);
      addToast("Stash dropped", "success");
      const stashesData = await fetchGitStashList(projectId);
      setStashes(stashesData);
    } catch (err: any) {
      addToast(err.message || "Failed to drop stash", "error");
    } finally {
      setStashLoading(null);
    }
  }, [addToast, projectId]);

  // ── Remote Handlers ─────────────────────────────────────────────

  const handleFetch = useCallback(async () => {
    setRemoteLoading("fetch");
    try {
      const result = await fetchRemote(undefined, projectId);
      setLastRemoteResult(result);
      addToast(result.message || "Fetch completed", result.fetched ? "success" : "info");
      const statusData = await fetchGitStatus(projectId);
      setStatus(statusData);
    } catch (err: any) {
      addToast(err.message || "Fetch failed", "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast, projectId]);

  const handlePull = useCallback(async () => {
    setRemoteLoading("pull");
    try {
      const result = await pullBranch(projectId);
      setLastRemoteResult(result);
      if (result.conflict) {
        addToast("Merge conflict detected. Resolve manually.", "error");
      } else {
        addToast(result.message || "Pull completed", "success");
      }
      const statusData = await fetchGitStatus(projectId);
      setStatus(statusData);
    } catch (err: any) {
      addToast(err.message || "Pull failed", "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast, projectId]);

  const handlePush = useCallback(async () => {
    setRemoteLoading("push");
    try {
      const result = await pushBranch(projectId);
      setLastRemoteResult(result);
      addToast(result.message || "Push completed", "success");
      const statusData = await fetchGitStatus(projectId);
      setStatus(statusData);
    } catch (err: any) {
      addToast(err.message || "Push failed", "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast, projectId]);

  // ── Derived state ───────────────────────────────────────────────

  const stagedFiles = useMemo(() => fileChanges.filter((f) => f.staged), [fileChanges]);
  const unstagedFiles = useMemo(() => fileChanges.filter((f) => !f.staged), [fileChanges]);

  // ── Render ──────────────────────────────────────────────────────

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal gm-modal" ref={modalRef}>
        <div className="modal-header">
          <h3>
            <FolderGit2 size={18} style={{ marginRight: 8, verticalAlign: "middle" }} />
            Git Manager
          </h3>
          <div className="gm-header-actions">
            <button
              className="btn btn-sm"
              onClick={fetchSectionData}
              disabled={loading}
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? "spin" : ""} />
            </button>
            <button className="modal-close" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="gm-layout">
          {/* Sidebar Navigation */}
          <nav className="gm-sidebar" role="tablist" aria-label="Git Manager Sections">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  role="tab"
                  aria-selected={activeSection === section.id}
                  className={`gm-nav-item${activeSection === section.id ? " active" : ""}`}
                  onClick={() => setActiveSection(section.id)}
                >
                  <Icon size={16} />
                  <span className="gm-nav-label">{section.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Content Area */}
          <div className="gm-content" role="tabpanel">
            {/* Loading overlay */}
            {loading && (
              <div className="gm-loading">
                <Loader2 size={24} className="spin" />
                <span>Loading...</span>
              </div>
            )}

            {/* Error state */}
            {sectionError && !loading && (
              <div className="gm-error">
                <AlertCircle size={18} />
                <span>{sectionError}</span>
                <button className="btn btn-sm" onClick={fetchSectionData}>
                  Retry
                </button>
              </div>
            )}

            {/* ── Status Panel ── */}
            {activeSection === "status" && !loading && status && (
              <StatusPanel status={status} copyToClipboard={copyToClipboard} />
            )}

            {/* ── Changes Panel ── */}
            {activeSection === "changes" && !loading && (
              <ChangesPanel
                status={status}
                stagedFiles={stagedFiles}
                unstagedFiles={unstagedFiles}
                selectedFiles={selectedFiles}
                toggleFileSelection={toggleFileSelection}
                onStageFiles={handleStageFiles}
                onUnstageFiles={handleUnstageFiles}
                onDiscardChanges={handleDiscardChanges}
                onViewDiff={handleViewDiff}
                changeDiff={changeDiff}
                loadingChangeDiff={loadingChangeDiff}
                commitMessage={commitMessage}
                setCommitMessage={setCommitMessage}
                onCommit={handleCommit}
                onStageAllAndCommit={handleStageAllAndCommit}
                committing={committing}
              />
            )}

            {/* ── Commits Panel ── */}
            {activeSection === "commits" && !loading && (
              <CommitsPanel
                commits={filteredCommits}
                commitSearch={commitSearch}
                setCommitSearch={setCommitSearch}
                selectedCommit={selectedCommit}
                commitDiff={commitDiff}
                loadingDiff={loadingDiff}
                onCommitClick={handleCommitClick}
                onLoadMore={handleLoadMoreCommits}
                canLoadMore={commits.length >= commitsLimit && commitsLimit < 100}
                copyToClipboard={copyToClipboard}
              />
            )}

            {/* ── Branches Panel ── */}
            {activeSection === "branches" && !loading && (
              <BranchesPanel
                branches={filteredBranches}
                branchSearch={branchSearch}
                setBranchSearch={setBranchSearch}
                newBranchName={newBranchName}
                setNewBranchName={setNewBranchName}
                branchBase={branchBase}
                setBranchBase={setBranchBase}
                onCreateBranch={handleCreateBranch}
                onCheckoutBranch={handleCheckoutBranch}
                onDeleteBranch={handleDeleteBranch}
                loading={loading}
                allBranches={branches}
                selectedBranch={selectedBranch}
                branchCommits={branchCommits}
                loadingBranchCommits={loadingBranchCommits}
                expandedBranchCommit={expandedBranchCommit}
                branchCommitDiff={branchCommitDiff}
                loadingBranchCommitDiff={loadingBranchCommitDiff}
                onSelectBranch={handleSelectBranch}
                onBranchCommitClick={handleBranchCommitClick}
                onCloseBranchDetails={handleCloseBranchDetails}
              />
            )}

            {/* ── Worktrees Panel ── */}
            {activeSection === "worktrees" && !loading && (
              <WorktreesPanel worktrees={worktrees} />
            )}

            {/* ── Stashes Panel ── */}
            {activeSection === "stashes" && !loading && (
              <StashesPanel
                stashes={stashes}
                stashMessage={stashMessage}
                setStashMessage={setStashMessage}
                onCreateStash={handleCreateStash}
                onApplyStash={handleApplyStash}
                onDropStash={handleDropStash}
                stashLoading={stashLoading}
              />
            )}

            {/* ── Remotes Panel ── */}
            {activeSection === "remotes" && !loading && (
              <RemotesPanel
                status={status}
                remoteLoading={remoteLoading}
                lastRemoteResult={lastRemoteResult}
                onFetch={handleFetch}
                onPull={handlePull}
                onPush={handlePush}
                addToast={addToast}
                projectId={projectId}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-Components ────────────────────────────────────────────────

/** Status overview panel */
function StatusPanel({
  status,
  copyToClipboard,
}: {
  status: GitStatus;
  copyToClipboard: (text: string, label?: string) => void;
}) {
  return (
    <div className="gm-panel" data-testid="status-panel">
      <div className="gm-panel-header">
        <h4>Repository Status</h4>
      </div>
      <div className="gm-status-grid">
        <div className="gm-status-card">
          <span className="gm-status-label">Branch</span>
          <span className="gm-status-value">
            <GitBranchIcon size={14} />
            <span>{status.branch}</span>
          </span>
        </div>
        <div className="gm-status-card">
          <span className="gm-status-label">Commit</span>
          <span className="gm-status-value">
            <code className="gm-hash">{status.commit}</code>
            <button
              className="gm-icon-btn"
              onClick={() => copyToClipboard(status.commit, "commit hash")}
              title="Copy commit hash"
            >
              <Copy size={12} />
            </button>
          </span>
        </div>
        <div className="gm-status-card">
          <span className="gm-status-label">Working Tree</span>
          <span className={`gm-status-badge ${status.isDirty ? "dirty" : "clean"}`}>
            {status.isDirty ? (
              <>
                <AlertCircle size={12} />
                Modified
              </>
            ) : (
              <>
                <CheckCircle size={12} />
                Clean
              </>
            )}
          </span>
        </div>
        <div className="gm-status-card">
          <span className="gm-status-label">Remote Sync</span>
          <span className="gm-status-value">
            {status.ahead > 0 && (
              <span className="gm-ahead" title={`${status.ahead} commit(s) ahead`}>
                <ArrowUp size={12} />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span className="gm-behind" title={`${status.behind} commit(s) behind`}>
                <ArrowDown size={12} />
                {status.behind}
              </span>
            )}
            {status.ahead === 0 && status.behind === 0 && (
              <span className="gm-in-sync">
                <CheckCircle size={12} />
                Up to date
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Changes panel with staging, unstaging, committing */
function ChangesPanel({
  status,
  stagedFiles,
  unstagedFiles,
  selectedFiles,
  toggleFileSelection,
  onStageFiles,
  onUnstageFiles,
  onDiscardChanges,
  onViewDiff,
  changeDiff,
  loadingChangeDiff,
  commitMessage,
  setCommitMessage,
  onCommit,
  onStageAllAndCommit,
  committing,
}: {
  status: GitStatus | null;
  stagedFiles: GitFileChange[];
  unstagedFiles: GitFileChange[];
  selectedFiles: Set<string>;
  toggleFileSelection: (file: string) => void;
  onStageFiles: (files: string[]) => void;
  onUnstageFiles: (files: string[]) => void;
  onDiscardChanges: (files: string[]) => void;
  onViewDiff: () => void;
  changeDiff: { stat: string; patch: string } | null;
  loadingChangeDiff: boolean;
  commitMessage: string;
  setCommitMessage: (msg: string) => void;
  onCommit: (e: React.FormEvent) => void;
  onStageAllAndCommit: () => void;
  committing: boolean;
}) {
  const selectedUnstaged = unstagedFiles.filter((f) => selectedFiles.has(`unstaged:${f.file}`));
  const selectedStaged = stagedFiles.filter((f) => selectedFiles.has(`staged:${f.file}`));

  return (
    <div className="gm-panel" data-testid="changes-panel">
      {/* Current branch indicator */}
      {status && (
        <div className="gm-changes-header">
          <span className="gm-branch-indicator">
            <GitBranchIcon size={14} />
            {status.branch}
          </span>
          {status.isDirty && (
            <span className="gm-dirty-badge">Modified</span>
          )}
        </div>
      )}

      {/* Unstaged Changes */}
      <div className="gm-file-section">
        <div className="gm-file-section-header">
          <h5>Unstaged Changes ({unstagedFiles.length})</h5>
          <div className="gm-file-section-actions">
            {selectedUnstaged.length > 0 && (
              <>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => onStageFiles(selectedUnstaged.map((f) => f.file))}
                  title="Stage selected"
                >
                  <Plus size={12} /> Stage ({selectedUnstaged.length})
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => onDiscardChanges(selectedUnstaged.map((f) => f.file))}
                  title="Discard selected"
                >
                  <XCircle size={12} />
                </button>
              </>
            )}
            {unstagedFiles.length > 0 && (
              <button
                className="btn btn-sm"
                onClick={() => onStageFiles(unstagedFiles.map((f) => f.file))}
                title="Stage all"
              >
                Stage All
              </button>
            )}
          </div>
        </div>
        <div className="gm-file-list">
          {unstagedFiles.length === 0 ? (
            <div className="gm-empty">No unstaged changes</div>
          ) : (
            unstagedFiles.map((f) => (
              <div key={`unstaged:${f.file}`} className="gm-file-item">
                <label className="gm-file-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(`unstaged:${f.file}`)}
                    onChange={() => toggleFileSelection(`unstaged:${f.file}`)}
                  />
                </label>
                <FileStatusIcon status={f.status} />
                <span className="gm-file-name" title={f.file}>{f.file}</span>
                <FileStatusBadge status={f.status} />
                <button
                  className="gm-icon-btn"
                  onClick={() => onStageFiles([f.file])}
                  title="Stage file"
                >
                  <Plus size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Staged Changes */}
      <div className="gm-file-section">
        <div className="gm-file-section-header">
          <h5>Staged Changes ({stagedFiles.length})</h5>
          <div className="gm-file-section-actions">
            {selectedStaged.length > 0 && (
              <button
                className="btn btn-sm"
                onClick={() => onUnstageFiles(selectedStaged.map((f) => f.file))}
                title="Unstage selected"
              >
                Unstage ({selectedStaged.length})
              </button>
            )}
            {stagedFiles.length > 0 && (
              <button
                className="btn btn-sm"
                onClick={() => onUnstageFiles(stagedFiles.map((f) => f.file))}
                title="Unstage all"
              >
                Unstage All
              </button>
            )}
          </div>
        </div>
        <div className="gm-file-list">
          {stagedFiles.length === 0 ? (
            <div className="gm-empty">No staged changes</div>
          ) : (
            stagedFiles.map((f) => (
              <div key={`staged:${f.file}`} className="gm-file-item staged">
                <label className="gm-file-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedFiles.has(`staged:${f.file}`)}
                    onChange={() => toggleFileSelection(`staged:${f.file}`)}
                  />
                </label>
                <FileStatusIcon status={f.status} />
                <span className="gm-file-name" title={f.file}>{f.file}</span>
                <FileStatusBadge status={f.status} />
                <button
                  className="gm-icon-btn"
                  onClick={() => onUnstageFiles([f.file])}
                  title="Unstage file"
                >
                  <X size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Diff Viewer */}
      {unstagedFiles.length > 0 && (
        <div className="gm-diff-section">
          <button
            className="btn btn-sm"
            onClick={onViewDiff}
            disabled={loadingChangeDiff}
          >
            {loadingChangeDiff ? <Loader2 size={14} className="spin" /> : <FileDiff size={14} />}
            View Diff
          </button>
          {changeDiff && (
            <div className="gm-diff-viewer">
              {changeDiff.stat && <pre className="gm-diff-stat">{changeDiff.stat}</pre>}
              <pre className="gm-diff-patch">{changeDiff.patch}</pre>
            </div>
          )}
        </div>
      )}

      {/* Commit Form */}
      <form className="gm-commit-form" onSubmit={onCommit}>
        <textarea
          className="gm-commit-input"
          placeholder="Commit message..."
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          rows={3}
          disabled={committing}
        />
        <div className="gm-commit-actions">
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={committing || !commitMessage.trim() || stagedFiles.length === 0}
            title={stagedFiles.length === 0 ? "No staged changes to commit" : "Commit staged changes"}
          >
            {committing ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            Commit
          </button>
          {unstagedFiles.length > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onStageAllAndCommit}
              disabled={committing || !commitMessage.trim()}
              title="Stage all and commit"
            >
              Stage All & Commit
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Commits panel with search, diff viewer */
function CommitsPanel({
  commits,
  commitSearch,
  setCommitSearch,
  selectedCommit,
  commitDiff,
  loadingDiff,
  onCommitClick,
  onLoadMore,
  canLoadMore,
  copyToClipboard,
}: {
  commits: GitCommit[];
  commitSearch: string;
  setCommitSearch: (q: string) => void;
  selectedCommit: string | null;
  commitDiff: { stat: string; patch: string } | null;
  loadingDiff: boolean;
  onCommitClick: (hash: string) => void;
  onLoadMore: () => void;
  canLoadMore: boolean;
  copyToClipboard: (text: string, label?: string) => void;
}) {
  return (
    <div className="gm-panel" data-testid="commits-panel">
      <div className="gm-panel-header">
        <h4>Commits</h4>
        <div className="gm-search-box">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search commits..."
            value={commitSearch}
            onChange={(e) => setCommitSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="gm-commits-list">
        {commits.length === 0 ? (
          <div className="gm-empty">
            {commitSearch ? "No matching commits" : "No commits found"}
          </div>
        ) : (
          commits.map((commit, idx) => (
            <div key={commit.hash} className="gm-commit-item">
              {/* Simple commit graph line */}
              <div className="gm-commit-graph">
                <div className="gm-commit-dot" />
                {idx < commits.length - 1 && <div className="gm-commit-line" />}
              </div>
              <div className="gm-commit-body">
                <button
                  className="gm-commit-header"
                  onClick={() => onCommitClick(commit.hash)}
                >
                  <div className="gm-commit-top-row">
                    <code className="gm-hash">{commit.shortHash}</code>
                    <span className="gm-commit-message" title={commit.message}>
                      {commit.message}
                    </span>
                  </div>
                  <div className="gm-commit-meta">
                    <span>{commit.author}</span>
                    <span>•</span>
                    <span>{relativeDate(commit.date)}</span>
                    {commit.parents.length > 1 && (
                      <span className="gm-merge-badge">merge</span>
                    )}
                  </div>
                </button>
                <div className="gm-commit-actions-row">
                  <button
                    className="gm-icon-btn"
                    onClick={() => copyToClipboard(commit.hash, "commit hash")}
                    title="Copy full hash"
                  >
                    <Copy size={12} />
                  </button>
                </div>
                {selectedCommit === commit.hash && (
                  <div className="gm-commit-diff">
                    {loadingDiff ? (
                      <div className="gm-diff-loading">
                        <Loader2 size={16} className="spin" />
                        Loading diff...
                      </div>
                    ) : commitDiff ? (
                      <>
                        {commitDiff.stat && <pre className="gm-diff-stat">{commitDiff.stat}</pre>}
                        <pre className="gm-diff-patch">{commitDiff.patch}</pre>
                      </>
                    ) : (
                      <div className="gm-diff-error">Failed to load diff</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      {canLoadMore && (
        <button className="gm-load-more" onClick={onLoadMore}>
          Load more commits
        </button>
      )}
    </div>
  );
}

/** Branches panel with creation, search, checkout, delete, and branch commit viewing */
function BranchesPanel({
  branches,
  branchSearch,
  setBranchSearch,
  newBranchName,
  setNewBranchName,
  branchBase,
  setBranchBase,
  onCreateBranch,
  onCheckoutBranch,
  onDeleteBranch,
  loading,
  allBranches,
  selectedBranch,
  branchCommits,
  loadingBranchCommits,
  expandedBranchCommit,
  branchCommitDiff,
  loadingBranchCommitDiff,
  onSelectBranch,
  onBranchCommitClick,
  onCloseBranchDetails,
}: {
  branches: GitBranch[];
  branchSearch: string;
  setBranchSearch: (q: string) => void;
  newBranchName: string;
  setNewBranchName: (name: string) => void;
  branchBase: string;
  setBranchBase: (base: string) => void;
  onCreateBranch: (e: React.FormEvent) => void;
  onCheckoutBranch: (name: string) => void;
  onDeleteBranch: (name: string) => void;
  loading: boolean;
  allBranches: GitBranch[];
  selectedBranch: string | null;
  branchCommits: GitCommit[];
  loadingBranchCommits: boolean;
  expandedBranchCommit: string | null;
  branchCommitDiff: { stat: string; patch: string } | null;
  loadingBranchCommitDiff: boolean;
  onSelectBranch: (name: string) => void;
  onBranchCommitClick: (hash: string) => void;
  onCloseBranchDetails: () => void;
}) {
  return (
    <div className="gm-panel" data-testid="branches-panel">
      <div className="gm-panel-header">
        <h4>Branches</h4>
        <div className="gm-search-box">
          <Search size={14} />
          <input
            type="text"
            placeholder="Filter branches..."
            value={branchSearch}
            onChange={(e) => setBranchSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Create branch form */}
      <form className="gm-create-form" onSubmit={onCreateBranch}>
        <input
          type="text"
          placeholder="New branch name"
          value={newBranchName}
          onChange={(e) => setNewBranchName(e.target.value)}
          disabled={loading}
        />
        <select
          value={branchBase}
          onChange={(e) => setBranchBase(e.target.value)}
          disabled={loading}
          className="gm-branch-select"
        >
          <option value="">Base: HEAD</option>
          {allBranches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={loading || !newBranchName.trim()}
        >
          <Plus size={14} />
          Create
        </button>
      </form>

      {/* Branches list */}
      <div className="gm-branches-list">
        {branches.length === 0 ? (
          <div className="gm-empty">
            {branchSearch ? "No matching branches" : "No branches found"}
          </div>
        ) : (
          branches.map((branch) => (
            <div key={branch.name}>
              <div
                className={`gm-branch-item${branch.isCurrent ? " current" : ""}${selectedBranch === branch.name ? " selected" : ""}`}
                onClick={() => onSelectBranch(branch.name)}
              >
                <div className="gm-branch-info">
                  <span className="gm-branch-name">
                    {branch.isCurrent && <Check size={14} className="gm-current-icon" />}
                    {branch.name}
                  </span>
                  {branch.remote && (
                    <span className="gm-branch-remote">→ {branch.remote}</span>
                  )}
                  {branch.lastCommitDate && (
                    <span className="gm-branch-date">{relativeDate(branch.lastCommitDate)}</span>
                  )}
                </div>
                <div className="gm-branch-actions">
                  {!branch.isCurrent && (
                    <>
                      <button
                        className="btn btn-sm"
                        onClick={(e) => { e.stopPropagation(); onCheckoutBranch(branch.name); }}
                        disabled={loading}
                        title="Checkout"
                      >
                        <GitBranchIcon size={14} />
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={(e) => { e.stopPropagation(); onDeleteBranch(branch.name); }}
                        disabled={loading}
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Branch commit details — shown when this branch is selected */}
              {selectedBranch === branch.name && (
                <div className="gm-branch-details">
                  <div className="gm-branch-details-header">
                    <span className="gm-branch-details-title">
                      <GitCommitIcon size={14} />
                      Commits on {branch.name}
                    </span>
                    <button
                      className="gm-icon-btn"
                      onClick={onCloseBranchDetails}
                      title="Close"
                      data-testid="close-branch-details"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {loadingBranchCommits ? (
                    <div className="gm-branch-details-loading">
                      <Loader2 size={16} className="spin" />
                      Loading commits...
                    </div>
                  ) : branchCommits.length === 0 ? (
                    <div className="gm-empty">No commits found</div>
                  ) : (
                    <div className="gm-branch-commits-list">
                      {branchCommits.map((commit) => (
                        <div key={commit.hash} className="gm-branch-commit">
                          <button
                            className="gm-branch-commit-row"
                            onClick={() => onBranchCommitClick(commit.hash)}
                            data-testid={`branch-commit-${commit.shortHash}`}
                          >
                            <span className="gm-commit-hash">{commit.shortHash}</span>
                            <span className="gm-commit-message" title={commit.message}>
                              {commit.message}
                            </span>
                            <div className="gm-commit-meta">
                              <span>{commit.author}</span>
                              <span>•</span>
                              <span>{relativeDate(commit.date)}</span>
                              {commit.parents.length > 1 && (
                                <span className="gm-merge-badge">merge</span>
                              )}
                            </div>
                          </button>
                          {expandedBranchCommit === commit.hash && (
                            <div className="gm-commit-diff">
                              {loadingBranchCommitDiff ? (
                                <div className="gm-diff-loading">
                                  <Loader2 size={16} className="spin" />
                                  Loading diff...
                                </div>
                              ) : branchCommitDiff ? (
                                <>
                                  {branchCommitDiff.stat && <pre className="gm-diff-stat">{branchCommitDiff.stat}</pre>}
                                  <pre className="gm-diff-patch">{branchCommitDiff.patch}</pre>
                                </>
                              ) : (
                                <div className="gm-diff-error">Failed to load diff</div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Worktrees panel */
function WorktreesPanel({ worktrees }: { worktrees: GitWorktree[] }) {
  return (
    <div className="gm-panel" data-testid="worktrees-panel">
      <div className="gm-panel-header">
        <h4>Worktrees</h4>
        <div className="gm-worktree-stats">
          <span>{worktrees.length} total</span>
          <span className="gm-stat-separator">•</span>
          <span>{worktrees.filter((w) => w.taskId).length} in use</span>
        </div>
      </div>
      <div className="gm-worktrees-list">
        {worktrees.map((worktree) => (
          <div
            key={worktree.path}
            className={`gm-worktree-item${worktree.isMain ? " main" : ""}`}
          >
            <div className="gm-worktree-info">
              <div className="gm-worktree-path-row">
                {worktree.isMain && <span className="gm-badge main">main</span>}
                {worktree.isBare && <span className="gm-badge bare">bare</span>}
                <span className="gm-worktree-path" title={worktree.path}>
                  {worktree.path.split("/").pop() || worktree.path}
                </span>
              </div>
              <div className="gm-worktree-detail">
                {worktree.branch && (
                  <span className="gm-worktree-branch">
                    <GitBranchIcon size={12} />
                    {worktree.branch}
                  </span>
                )}
                {worktree.taskId && (
                  <span className="gm-worktree-task">{worktree.taskId}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stashes panel */
function StashesPanel({
  stashes,
  stashMessage,
  setStashMessage,
  onCreateStash,
  onApplyStash,
  onDropStash,
  stashLoading,
}: {
  stashes: GitStash[];
  stashMessage: string;
  setStashMessage: (msg: string) => void;
  onCreateStash: (e: React.FormEvent) => void;
  onApplyStash: (index: number, drop?: boolean) => void;
  onDropStash: (index: number) => void;
  stashLoading: string | null;
}) {
  return (
    <div className="gm-panel" data-testid="stashes-panel">
      <div className="gm-panel-header">
        <h4>Stashes</h4>
      </div>

      {/* Create stash form */}
      <form className="gm-create-form" onSubmit={onCreateStash}>
        <input
          type="text"
          placeholder="Stash message (optional)"
          value={stashMessage}
          onChange={(e) => setStashMessage(e.target.value)}
          disabled={stashLoading !== null}
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={stashLoading !== null}
        >
          {stashLoading === "create" ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <Archive size={14} />
          )}
          Stash
        </button>
      </form>

      {/* Stash list */}
      <div className="gm-stash-list">
        {stashes.length === 0 ? (
          <div className="gm-empty">No stashes</div>
        ) : (
          stashes.map((stash) => (
            <div key={stash.index} className="gm-stash-item">
              <div className="gm-stash-info">
                <span className="gm-stash-ref">stash@{`{${stash.index}}`}</span>
                <span className="gm-stash-message">{stash.message}</span>
                <div className="gm-stash-meta">
                  {stash.branch && (
                    <span className="gm-stash-branch">
                      <GitBranchIcon size={12} />
                      {stash.branch}
                    </span>
                  )}
                  <span>{relativeDate(stash.date)}</span>
                </div>
              </div>
              <div className="gm-stash-actions">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => onApplyStash(stash.index, false)}
                  disabled={stashLoading !== null}
                  title="Apply stash (keep)"
                >
                  {stashLoading === `apply-${stash.index}` ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    "Apply"
                  )}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => onApplyStash(stash.index, true)}
                  disabled={stashLoading !== null}
                  title="Pop stash (apply and drop)"
                >
                  Pop
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => onDropStash(stash.index)}
                  disabled={stashLoading !== null}
                  title="Drop stash"
                >
                  {stashLoading === `drop-${stash.index}` ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Enhanced Remotes panel with full remote management capabilities */
function RemotesPanel({
  status,
  remoteLoading,
  lastRemoteResult,
  onFetch,
  onPull,
  onPush,
  addToast,
  projectId,
}: {
  status: GitStatus | null;
  remoteLoading: string | null;
  lastRemoteResult: GitFetchResult | GitPullResult | GitPushResult | null;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
}) {
  const [remotes, setRemotes] = useState<GitRemoteDetailed[]>([]);
  const [loading, setLoading] = useState(false);
  const [remoteActionLoading, setRemoteActionLoading] = useState<string | null>(null);
  const [newRemoteName, setNewRemoteName] = useState("");
  const [newRemoteUrl, setNewRemoteUrl] = useState("");
  const [editingRemote, setEditingRemote] = useState<string | null>(null);
  const [editUrlValue, setEditUrlValue] = useState("");
  const [editNameValue, setEditNameValue] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  // Ahead commits (local commits to push)
  const [aheadCommits, setAheadCommits] = useState<GitCommit[]>([]);
  const [loadingAhead, setLoadingAhead] = useState(false);

  // Selected remote and its recent commits
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);
  const [remoteCommits, setRemoteCommits] = useState<GitCommit[]>([]);
  const [loadingRemoteCommits, setLoadingRemoteCommits] = useState(false);
  const [remoteCommitsError, setRemoteCommitsError] = useState<string | null>(null);

  // Inline commit diff expansion (one per list context)
  const [expandedAheadCommit, setExpandedAheadCommit] = useState<string | null>(null);
  const [aheadCommitDiff, setAheadCommitDiff] = useState<{ stat: string; patch: string } | null>(null);
  const [loadingAheadCommitDiff, setLoadingAheadCommitDiff] = useState(false);
  const [expandedRemoteCommit, setExpandedRemoteCommit] = useState<string | null>(null);
  const [remoteCommitDiff, setRemoteCommitDiff] = useState<{ stat: string; patch: string } | null>(null);
  const [loadingRemoteCommitDiff, setLoadingRemoteCommitDiff] = useState(false);

  // Fetch remotes when panel mounts
  useEffect(() => {
    loadRemotes();
  }, []);

  // Load ahead commits whenever the ahead count indicates commits to push.
  // This covers: initial mount (when status arrives), status refresh after
  // remote actions (fetch/pull/push), and any other status updates.
  useEffect(() => {
    if (status && status.ahead > 0) {
      loadAheadCommits();
    } else if (status && status.ahead === 0) {
      // Clear stale ahead commits when push succeeds or upstream catches up
      setAheadCommits([]);
    }
  }, [status?.ahead]);

  // Auto-select first remote when remotes load
  useEffect(() => {
    if (remotes.length > 0 && !selectedRemote) {
      setSelectedRemote(remotes[0].name);
    }
  }, [remotes]);

  // Load commits for selected remote
  useEffect(() => {
    if (selectedRemote) {
      loadRemoteCommits(selectedRemote);
    } else {
      setRemoteCommits([]);
      setRemoteCommitsError(null);
    }
  }, [selectedRemote]);

  // Clear selected remote if it was removed from the list
  useEffect(() => {
    if (selectedRemote && !remotes.find((r) => r.name === selectedRemote)) {
      setSelectedRemote(remotes.length > 0 ? remotes[0].name : null);
    }
  }, [remotes, selectedRemote]);

  const loadRemotes = async () => {
    setLoading(true);
    try {
      const data = await fetchGitRemotesDetailed(projectId);
      setRemotes(data);
    } catch (err: any) {
      addToast(err.message || "Failed to load remotes", "error");
    } finally {
      setLoading(false);
    }
  };

  const loadAheadCommits = async () => {
    setLoadingAhead(true);
    try {
      const commits = await fetchAheadCommits(projectId);
      setAheadCommits(commits);
    } catch {
      // Silently ignore — ahead commits are a nice-to-have
      setAheadCommits([]);
    } finally {
      setLoadingAhead(false);
    }
  };

  const loadRemoteCommits = async (remoteName: string) => {
    setLoadingRemoteCommits(true);
    setRemoteCommitsError(null);
    try {
      const commits = await fetchRemoteCommits(remoteName, undefined, 10, projectId);
      setRemoteCommits(commits);
    } catch (err: any) {
      setRemoteCommitsError(err.message || "Failed to load remote commits");
      setRemoteCommits([]);
    } finally {
      setLoadingRemoteCommits(false);
    }
  };

  const handleAddRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRemoteName.trim() || !newRemoteUrl.trim()) return;

    setRemoteActionLoading("add");
    try {
      await addGitRemote(newRemoteName.trim(), newRemoteUrl.trim(), projectId);
      addToast(`Remote '${newRemoteName}' added successfully`, "success");
      setNewRemoteName("");
      setNewRemoteUrl("");
      setShowAddForm(false);
      await loadRemotes();
    } catch (err: any) {
      addToast(err.message || "Failed to add remote", "error");
    } finally {
      setRemoteActionLoading(null);
    }
  };

  const handleRemoveRemote = async (name: string) => {
    if (!confirm(`Are you sure you want to remove remote '${name}'?`)) return;

    setRemoteActionLoading(`remove-${name}`);
    try {
      await removeGitRemote(name, projectId);
      addToast(`Remote '${name}' removed`, "success");
      await loadRemotes();
    } catch (err: any) {
      addToast(err.message || "Failed to remove remote", "error");
    } finally {
      setRemoteActionLoading(null);
    }
  };

  const handleRenameRemote = async (oldName: string) => {
    if (!editNameValue.trim()) return;

    setRemoteActionLoading(`rename-${oldName}`);
    try {
      await renameGitRemote(oldName, editNameValue.trim(), projectId);
      addToast(`Remote renamed to '${editNameValue.trim()}'`, "success");
      setEditingRemote(null);
      setEditNameValue("");
      await loadRemotes();
    } catch (err: any) {
      addToast(err.message || "Failed to rename remote", "error");
    } finally {
      setRemoteActionLoading(null);
    }
  };

  const handleUpdateUrl = async (name: string) => {
    if (!editUrlValue.trim()) return;

    setRemoteActionLoading(`url-${name}`);
    try {
      await updateGitRemoteUrl(name, editUrlValue.trim(), projectId);
      addToast(`Remote URL updated`, "success");
      setEditingRemote(null);
      setEditUrlValue("");
      await loadRemotes();
    } catch (err: any) {
      addToast(err.message || "Failed to update remote URL", "error");
    } finally {
      setRemoteActionLoading(null);
    }
  };

  const handleCompactCommitClick = useCallback(async (
    hash: string,
    listType: "ahead" | "remote",
  ) => {
    if (listType === "ahead") {
      if (expandedAheadCommit === hash) {
        setExpandedAheadCommit(null);
        setAheadCommitDiff(null);
        return;
      }
      setExpandedAheadCommit(hash);
      setAheadCommitDiff(null);
      setLoadingAheadCommitDiff(true);
      try {
        const diff = await fetchCommitDiff(hash);
        setAheadCommitDiff(diff);
      } catch {
        setAheadCommitDiff(null);
      } finally {
        setLoadingAheadCommitDiff(false);
      }
    } else {
      if (expandedRemoteCommit === hash) {
        setExpandedRemoteCommit(null);
        setRemoteCommitDiff(null);
        return;
      }
      setExpandedRemoteCommit(hash);
      setRemoteCommitDiff(null);
      setLoadingRemoteCommitDiff(true);
      try {
        const diff = await fetchCommitDiff(hash);
        setRemoteCommitDiff(diff);
      } catch {
        setRemoteCommitDiff(null);
      } finally {
        setLoadingRemoteCommitDiff(false);
      }
    }
  }, [expandedAheadCommit, expandedRemoteCommit]);

  const startEditingUrl = (remote: GitRemoteDetailed) => {
    setEditingRemote(`url-${remote.name}`);
    setEditUrlValue(remote.pushUrl || remote.fetchUrl);
  };

  const startEditingName = (remote: GitRemoteDetailed) => {
    setEditingRemote(`name-${remote.name}`);
    setEditNameValue(remote.name);
  };

  return (
    <div className="gm-panel gm-remotes-panel" data-testid="remotes-panel">
      <div className="gm-panel-header">
        <h4>Remote Management</h4>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setShowAddForm(!showAddForm)}
          disabled={remoteActionLoading !== null}
        >
          {showAddForm ? <X size={14} /> : <Plus size={14} />}
          {showAddForm ? "Cancel" : "Add Remote"}
        </button>
      </div>

      {/* Add Remote Form */}
      {showAddForm && (
        <form className="gm-remote-form" onSubmit={handleAddRemote}>
          <div className="gm-form-row">
            <input
              type="text"
              placeholder="Remote name (e.g., origin)"
              value={newRemoteName}
              onChange={(e) => setNewRemoteName(e.target.value)}
              disabled={remoteActionLoading === "add"}
              className="gm-input"
            />
            <input
              type="text"
              placeholder="Repository URL"
              value={newRemoteUrl}
              onChange={(e) => setNewRemoteUrl(e.target.value)}
              disabled={remoteActionLoading === "add"}
              className="gm-input gm-input-url"
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!newRemoteName.trim() || !newRemoteUrl.trim() || remoteActionLoading === "add"}
            >
              {remoteActionLoading === "add" ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Plus size={14} />
              )}
              Add
            </button>
          </div>
        </form>
      )}

      {/* Remote Operations (Fetch/Pull/Push) */}
      <div className="gm-remote-operations">
        {/* Commits to Push */}
        {status && status.ahead > 0 && (
          <div className="gm-commits-to-push" data-testid="commits-to-push">
            <div className="gm-section-subheader">
              <h5>
                <ArrowUp size={14} />
                Commits to Push ({status.ahead})
              </h5>
            </div>
            {loadingAhead ? (
              <div className="gm-loading">
                <Loader2 size={14} className="spin" />
                Loading...
              </div>
            ) : aheadCommits.length > 0 ? (
              <div className="gm-ahead-commits-list" data-testid="ahead-commits-list">
                {aheadCommits.map((commit) => (
                  <div key={commit.hash} className="gm-commit-item-compact-wrapper">
                    <div
                      className="gm-commit-item-compact gm-commit-clickable"
                      onClick={() => handleCompactCommitClick(commit.hash, "ahead")}
                      role="button"
                      tabIndex={0}
                      title="Click to view diff"
                    >
                      <div className="gm-commit-compact-hash">
                        <code className="gm-hash">{commit.shortHash}</code>
                      </div>
                      <div className="gm-commit-compact-info">
                        <span className="gm-commit-message" title={commit.message}>
                          {commit.message}
                        </span>
                        <span className="gm-commit-meta">
                          <span>{commit.author}</span>
                          <span>•</span>
                          <span>{relativeDate(commit.date)}</span>
                        </span>
                      </div>
                      <span className="gm-commit-expand-icon">
                        {expandedAheadCommit === commit.hash ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                    </div>
                    {expandedAheadCommit === commit.hash && (
                      <div className="gm-commit-diff gm-commit-diff-compact">
                        {loadingAheadCommitDiff ? (
                          <div className="gm-diff-loading">
                            <Loader2 size={16} className="spin" />
                            Loading diff...
                          </div>
                        ) : aheadCommitDiff ? (
                          <>
                            {commit.message && (
                              <div className="gm-commit-message-full">{commit.message}</div>
                            )}
                            {aheadCommitDiff.stat && <pre className="gm-diff-stat">{aheadCommitDiff.stat}</pre>}
                            <pre className="gm-diff-patch">{aheadCommitDiff.patch}</pre>
                          </>
                        ) : (
                          <div className="gm-diff-error">Failed to load diff</div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="gm-empty">
                No ahead commits found (may need to fetch first)
              </div>
            )}
          </div>
        )}

        {/* Ahead/Behind indicators */}
        {status && (status.ahead > 0 || status.behind > 0) && (
          <div className="gm-remote-status">
            {status.ahead > 0 && (
              <div className="gm-remote-indicator ahead">
                <ArrowUp size={16} />
                {status.ahead} commit(s) to push
              </div>
            )}
            {status.behind > 0 && (
              <div className="gm-remote-indicator behind">
                <ArrowDown size={16} />
                {status.behind} commit(s) to pull
              </div>
            )}
          </div>
        )}

        <div className="gm-remote-actions">
          <button
            className="btn btn-primary"
            onClick={onFetch}
            disabled={remoteLoading !== null || loading}
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
            onClick={onPull}
            disabled={remoteLoading !== null || loading}
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
            onClick={onPush}
            disabled={remoteLoading !== null || loading}
          >
            {remoteLoading === "push" ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <ArrowUp size={14} />
            )}
            Push
          </button>
        </div>
      </div>

      {/* Remotes List */}
      <div className="gm-remote-list">
        {loading ? (
          <div className="gm-loading">
            <Loader2 size={20} className="spin" />
            Loading remotes...
          </div>
        ) : remotes.length === 0 ? (
          <div className="gm-empty">No remotes configured</div>
        ) : (
          remotes.map((remote) => (
            <div
              key={remote.name}
              className={`gm-remote-item${selectedRemote === remote.name ? " selected" : ""}`}
              onClick={() => setSelectedRemote(remote.name)}
              role="button"
              tabIndex={0}
            >
              <div className="gm-remote-info">
                {editingRemote === `name-${remote.name}` ? (
                  <div className="gm-remote-edit">
                    <input
                      type="text"
                      value={editNameValue}
                      onChange={(e) => setEditNameValue(e.target.value)}
                      className="gm-input"
                      autoFocus
                    />
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => handleRenameRemote(remote.name)}
                      disabled={remoteActionLoading === `rename-${remote.name}`}
                    >
                      {remoteActionLoading === `rename-${remote.name}` ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <Check size={12} />
                      )}
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        setEditingRemote(null);
                        setEditNameValue("");
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div className="gm-remote-name-row">
                    <span className="gm-remote-name">{remote.name}</span>
                    <button
                      className="btn btn-icon gm-remote-edit-btn"
                      onClick={(e) => { e.stopPropagation(); startEditingName(remote); }}
                      disabled={remoteActionLoading !== null}
                      title="Edit remote name"
                    >
                      <Pencil size={16} />
                    </button>
                  </div>
                )}

                <div className="gm-remote-urls">
                  <div className="gm-remote-url">
                    <span className="gm-url-label">Fetch:</span>
                    <span className="gm-url-value" title={remote.fetchUrl}>
                      {remote.fetchUrl}
                    </span>
                  </div>
                  {editingRemote === `url-${remote.name}` ? (
                    <div className="gm-remote-edit gm-url-edit">
                      <input
                        type="text"
                        value={editUrlValue}
                        onChange={(e) => setEditUrlValue(e.target.value)}
                        className="gm-input"
                        autoFocus
                      />
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => handleUpdateUrl(remote.name)}
                        disabled={remoteActionLoading === `url-${remote.name}`}
                      >
                        {remoteActionLoading === `url-${remote.name}` ? (
                          <Loader2 size={12} className="spin" />
                        ) : (
                          <Check size={12} />
                        )}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setEditingRemote(null);
                          setEditUrlValue("");
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="gm-remote-url gm-push-url">
                      <span className="gm-url-label">Push:</span>
                      <span className="gm-url-value" title={remote.pushUrl}>
                        {remote.pushUrl || remote.fetchUrl}
                      </span>
                      <button
                        className="btn btn-icon gm-remote-edit-btn"
                        onClick={(e) => { e.stopPropagation(); startEditingUrl(remote); }}
                        disabled={remoteActionLoading !== null}
                        title="Edit remote URL"
                      >
                        <Pencil size={16} />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="gm-remote-actions-inline">
                <button
                  className="btn btn-sm btn-danger"
                  onClick={(e) => { e.stopPropagation(); handleRemoveRemote(remote.name); }}
                  disabled={remoteActionLoading !== null}
                  title="Remove remote"
                >
                  {remoteActionLoading === `remove-${remote.name}` ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Selected Remote Commits */}
      {selectedRemote && (
        <div className="gm-remote-commits-section" data-testid="remote-commits-section">
          <div className="gm-section-subheader">
            <h5>
              <Radio size={14} />
              Recent commits on {selectedRemote}
            </h5>
          </div>
          {loadingRemoteCommits ? (
            <div className="gm-loading">
              <Loader2 size={14} className="spin" />
              Loading commits...
            </div>
          ) : remoteCommitsError ? (
            <div className="gm-error">
              <AlertCircle size={14} />
              {remoteCommitsError}
            </div>
          ) : remoteCommits.length === 0 ? (
            <div className="gm-empty">
              No commits found on {selectedRemote}. Try fetching first.
            </div>
          ) : (
            <div className="gm-remote-commits-list" data-testid="remote-commits-list">
              {remoteCommits.map((commit) => (
                <div key={commit.hash} className="gm-commit-item-compact-wrapper">
                  <div
                    className="gm-commit-item-compact gm-commit-clickable"
                    onClick={() => handleCompactCommitClick(commit.hash, "remote")}
                    role="button"
                    tabIndex={0}
                    title="Click to view diff"
                  >
                    <div className="gm-commit-compact-hash">
                      <code className="gm-hash">{commit.shortHash}</code>
                    </div>
                    <div className="gm-commit-compact-info">
                      <span className="gm-commit-message" title={commit.message}>
                        {commit.message}
                      </span>
                      <span className="gm-commit-meta">
                        <span>{commit.author}</span>
                        <span>•</span>
                        <span>{relativeDate(commit.date)}</span>
                      </span>
                    </div>
                    <span className="gm-commit-expand-icon">
                      {expandedRemoteCommit === commit.hash ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                  </div>
                  {expandedRemoteCommit === commit.hash && (
                    <div className="gm-commit-diff gm-commit-diff-compact">
                      {loadingRemoteCommitDiff ? (
                        <div className="gm-diff-loading">
                          <Loader2 size={16} className="spin" />
                          Loading diff...
                        </div>
                      ) : remoteCommitDiff ? (
                        <>
                          {commit.message && (
                            <div className="gm-commit-message-full">{commit.message}</div>
                          )}
                          {remoteCommitDiff.stat && <pre className="gm-diff-stat">{remoteCommitDiff.stat}</pre>}
                          <pre className="gm-diff-patch">{remoteCommitDiff.patch}</pre>
                        </>
                      ) : (
                        <div className="gm-diff-error">Failed to load diff</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {lastRemoteResult && (
        <div className="gm-remote-result">
          {lastRemoteResult.message}
        </div>
      )}
    </div>
  );
}
