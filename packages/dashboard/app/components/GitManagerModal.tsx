import "./ScriptsModal.css";
import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from "react";
import { useTranslation, Trans } from "react-i18next";
import type { Task } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";
import { getPathBasename } from "../utils/pathDisplay";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useEmbeddedPresentation, type ModalPresentation } from "../hooks/useEmbeddedPresentation";
import { useViewportMode } from "../hooks/useViewportMode";
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
import { getRelativeTimeBucket } from "../utils/relativeTimeAgo";
import {
  api,
  fetchConfig,
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
  fetchStashDiff,
  fetchFileChanges,
  stageFiles,
  unstageFiles,
  createCommit,
  discardChanges,
  fetchGitFileDiff,
  fetchGitRemotesDetailed,
  addGitRemote,
  removeGitRemote,
  renameGitRemote,
  updateGitRemoteUrl,
  fetchAheadCommits,
  fetchRemoteCommits,
  fetchBranchCommits,
} from "../api";
import { StashRecoveryView } from "./StashRecoveryView";
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
  Info,
  History,
} from "lucide-react";

// ── Types & Constants ─────────────────────────────────────────────

type SectionId = "status" | "changes" | "commits" | "branches" | "worktrees" | "stashes" | "recovery" | "remotes";


const SECTIONS: { id: SectionId; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "status", label: "Status", icon: Radio },
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "commits", label: "Commits", icon: GitCommitIcon },
  { id: "branches", label: "Branches", icon: GitBranchIcon },
  { id: "worktrees", label: "Worktrees", icon: HardDrive },
  { id: "stashes", label: "Stashes", icon: Archive },
  /*
  FNXC:GitManager 2026-06-21-00:00:
  FN-6881 re-homes orphaned-autostash Stash Recovery from a standalone top-level view into a Git Manager section so users have one canonical recovery destination while the /stash-recovery API remains unchanged.
  */
  { id: "recovery", label: "Recovery", icon: History },
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
  const { t } = useTranslation("app");
  return useCallback(
    async (text: string, label?: string) => {
      try {
        await navigator.clipboard.writeText(text);
        addToast(label ? t("git.copiedLabel", "Copied {{label}}", { label }) : t("git.copiedToClipboard", "Copied to clipboard"), "success");
      } catch {
        addToast(t("git.failedToCopy", "Failed to copy"), "error");
      }
    },
    [addToast, t]
  );
}

/**
 * Format relative date. Returns "—" for invalid/empty dates.
 *
 * FNXC:RelativeTime 2026-06-17-20:48:
 * FN-6618 shares relative-time bucket math while preserving GitManagerModal's empty/invalid "—" guard, future-as-just-now behavior, and <30d day threshold keyed from total days.
 */
function relativeDate(dateStr: string | undefined | null): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "—";

  const bucket = getRelativeTimeBucket(dateStr);
  if (!bucket) return "just now";

  switch (bucket.bucket) {
    case "just-now":
      return "just now";
    case "minutes":
      return `${bucket.count}m ago`;
    case "hours":
      return `${bucket.count}h ago`;
    case "days":
    case "weeks":
    case "older":
      return bucket.days < 30 ? `${bucket.days}d ago` : date.toLocaleDateString();
  }
}

// ── Props ─────────────────────────────────────────────────────────

interface GitManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[];
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
  /*
  FNXC:RightDockEmbedding 2026-06-22-00:00:
  Right-dock redesign renders dock items inline inside the dock container rather than as fixed popup modals.
  `presentation="embedded"` switches GitManager from a fixed `.modal-overlay` overlay to an inline view that fills its container.
  Default stays "modal" so all existing overlay call sites keep byte-identical behavior.
  Embedded mode must disable modal-only behaviors (scroll lock, resize persistence, Escape-to-close, overlay click dismiss) since they break the host page.
  */
  presentation?: ModalPresentation;
}

// ── Main Component ────────────────────────────────────────────────

export function GitManagerModal({ isOpen, onClose, tasks: _tasks, addToast, projectId, presentation = "modal" }: GitManagerModalProps) {
  const { t } = useTranslation("app");
  const confirmContext = useConfirm();
  const viewportMode = useViewportMode();
  // FNXC:RightDockEmbedding 2026-06-22-00:00: embedded mode gates modal-only behaviors below (shared hook).
  const { isEmbedded, scrollLockEnabled, resizePersistEnabled, escapeEnabled } = useEmbeddedPresentation(presentation);
  useMobileScrollLock(isOpen && scrollLockEnabled);
  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } = useMobileKeyboard({
    enabled: viewportMode === "mobile",
  });
  const keyboardStyle: CSSProperties = keyboardOpen
    ? ({
        "--keyboard-overlap": `${keyboardOverlap}px`,
        "--vv-offset-top": `${viewportOffsetTop}px`,
        ...(viewportHeight !== null ? { "--vv-height": `${viewportHeight}px` } : {}),
      } as CSSProperties)
    : {};
  const handleClose = useCallback(() => {
    if (viewportMode === "mobile") {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      window.scrollTo(0, 0);
      requestAnimationFrame(() => {
        window.scrollTo(0, 0);
      });
    }
    onClose();
  }, [onClose, viewportMode]);
  const [activeSection, setActiveSection] = useState<SectionId>("status");
  const [loading, setLoading] = useState(false);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  // FNXC:RightDockEmbedding 2026-06-22-00:00: skip modal resize persist/restore when embedded inline.
  useModalResizePersist(modalRef, isOpen && resizePersistEnabled, "fusion:git-modal-size");
  const overlayDismissProps = useOverlayDismiss(handleClose);
  const copyToClipboard = useCopyToClipboard(addToast);

  // ── Status state
  const [status, setStatus] = useState<GitStatus | null>(null);

  const [rootDir, setRootDir] = useState<string | null>(null);

  // ── Changes state
  const [fileChanges, setFileChanges] = useState<GitFileChange[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [changeDiff, setChangeDiff] = useState<{ stat: string; patch: string } | null>(null);
  const [loadingChangeDiff, setLoadingChangeDiff] = useState(false);
  const [changeDiffError, setChangeDiffError] = useState<string | null>(null);
  const [selectedDiffTarget, setSelectedDiffTarget] = useState<{ file: string; staged: boolean } | null>(null);
  const changeDiffRequestIdRef = useRef(0);

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
  const [expandedStashIndex, setExpandedStashIndex] = useState<number | null>(null);
  const [stashDiff, setStashDiff] = useState<{ stat: string; patch: string } | null>(null);
  const [loadingStashDiff, setLoadingStashDiff] = useState(false);
  const [stashDiffError, setStashDiffError] = useState<string | null>(null);
  const stashDiffRequestIdRef = useRef(0);

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
          const statusData = await fetchGitStatus(projectId, { extended: true });
          setStatus(statusData);
          break;
        }
        case "changes": {
          const [statusData, changes] = await Promise.all([fetchGitStatus(projectId, { extended: true }), fetchFileChanges(projectId)]);
          setStatus(statusData);
          setFileChanges(changes);
          setSelectedFiles(new Set());
          setSelectedDiffTarget(null);
          setChangeDiff(null);
          setChangeDiffError(null);
          break;
        }
        case "commits": {
          const commitsData = await fetchGitCommits(commitsLimit, projectId);
          setCommits(commitsData);
          break;
        }
        case "branches": {
          const [branchesData, statusForBranch] = await Promise.all([fetchGitBranches(projectId), fetchGitStatus(projectId, { extended: true })]);
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
          setExpandedStashIndex(null);
          setStashDiff(null);
          setStashDiffError(null);
          stashDiffRequestIdRef.current += 1;
          break;
        }
        case "recovery": {
          // StashRecoveryView self-fetches /stash-recovery/orphans; this branch exists so selecting Recovery clears the modal loading state without issuing an unrelated git status request.
          break;
        }
        case "remotes": {
          const remoteStatus = await fetchGitStatus(projectId, { extended: true });
          setStatus(remoteStatus);
          break;
        }
      }
    } catch (err) {
      setSectionError(getErrorMessage(err) || t("git.failedToFetchData", "Failed to fetch git data"));
      addToast(getErrorMessage(err) || t("git.failedToFetchData", "Failed to fetch git data"), "error");
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
    // FNXC:RightDockEmbedding 2026-06-22-00:00: embedded mode has no overlay to dismiss; a global Escape listener would hijack page keys.
    if (!isOpen || !escapeEnabled) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
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
  }, [isOpen, escapeEnabled, handleClose, activeSection]);

  // ── Changes Handlers ────────────────────────────────────────────

  const handleStageFiles = useCallback(async (files: string[]) => {
    try {
      await stageFiles(files, projectId);
      addToast(t("git.stagedFiles", "Staged {{count}} file(s)", { count: files.length }), "success");
      const changes = await fetchFileChanges(projectId);
      setFileChanges(changes);
      setSelectedFiles(new Set());
      setSelectedDiffTarget(null);
      setChangeDiff(null);
      setChangeDiffError(null);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToStageFiles", "Failed to stage files"), "error");
    }
  }, [addToast, projectId]);

  const handleUnstageFiles = useCallback(async (files: string[]) => {
    try {
      await unstageFiles(files, projectId);
      addToast(t("git.unstagedFiles", "Unstaged {{count}} file(s)", { count: files.length }), "success");
      const changes = await fetchFileChanges(projectId);
      setFileChanges(changes);
      setSelectedFiles(new Set());
      setSelectedDiffTarget(null);
      setChangeDiff(null);
      setChangeDiffError(null);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToUnstageFiles", "Failed to unstage files"), "error");
    }
  }, [addToast, projectId]);

  const handleDiscardChanges = useCallback(async (files: string[]) => {
    const shouldDiscard = await confirmContext.confirm({
      title: t("git.discardChangesTitle", "Discard Changes"),
      message: t("git.discardChangesMessage", "Discard changes to {{count}} file(s)? This cannot be undone.", { count: files.length }),
      danger: true,
    });
    if (!shouldDiscard) return;
    try {
      await discardChanges(files, projectId);
      addToast(t("git.discardedFiles", "Discarded changes to {{count}} file(s)", { count: files.length }), "success");
      const [changes, statusData] = await Promise.all([fetchFileChanges(projectId), fetchGitStatus(projectId, { extended: true })]);
      setFileChanges(changes);
      setStatus(statusData);
      setSelectedFiles(new Set());
      setSelectedDiffTarget(null);
      setChangeDiff(null);
      setChangeDiffError(null);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToDiscardChanges", "Failed to discard changes"), "error");
    }
  }, [addToast, projectId, confirmContext]);

  const handleCommit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commitMessage.trim()) return;
    setCommitting(true);
    try {
      const result = await createCommit(commitMessage.trim(), projectId);
      addToast(t("git.committedHash", "Committed: {{hash}}", { hash: result.hash }), "success");
      setCommitMessage("");
      // Refresh changes and status
      const [changes, statusData] = await Promise.all([fetchFileChanges(projectId), fetchGitStatus(projectId, { extended: true })]);
      setFileChanges(changes);
      setStatus(statusData);
      setSelectedDiffTarget(null);
      setChangeDiff(null);
      setChangeDiffError(null);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToCommit", "Failed to commit"), "error");
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, addToast, projectId, t]);

  const handleStageAllAndCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    try {
      const unstaged = fileChanges.filter((f) => !f.staged).map((f) => f.file);
      if (unstaged.length > 0) {
        await stageFiles(unstaged, projectId);
      }
      const result = await createCommit(commitMessage.trim(), projectId);
      addToast(t("git.committedHash", "Committed: {{hash}}", { hash: result.hash }), "success");
      setCommitMessage("");
      const [changes, statusData] = await Promise.all([fetchFileChanges(projectId), fetchGitStatus(projectId, { extended: true })]);
      setFileChanges(changes);
      setStatus(statusData);
      setSelectedDiffTarget(null);
      setChangeDiff(null);
      setChangeDiffError(null);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToCommit", "Failed to commit"), "error");
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, fileChanges, addToast, projectId, t]);

  const handleSelectDiffFile = useCallback(async (file: string, staged: boolean) => {
    setSelectedDiffTarget({ file, staged });
    setLoadingChangeDiff(true);
    setChangeDiffError(null);
    const requestId = changeDiffRequestIdRef.current + 1;
    changeDiffRequestIdRef.current = requestId;

    try {
      const diff = await fetchGitFileDiff(file, staged, projectId);
      if (changeDiffRequestIdRef.current !== requestId) {
        return;
      }
      setChangeDiff(diff);
    } catch (err) {
      if (changeDiffRequestIdRef.current !== requestId) {
        return;
      }
      const errorMessage = getErrorMessage(err) || t("git.failedToLoadFileDiff", "Failed to load file diff");
      setChangeDiff(null);
      setChangeDiffError(errorMessage);
      addToast(errorMessage, "error");
    } finally {
      if (changeDiffRequestIdRef.current === requestId) {
        setLoadingChangeDiff(false);
      }
    }
  }, [addToast, projectId, t]);

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
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToLoadDiff", "Failed to load diff"), "error");
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
      addToast(t("git.createdBranch", "Created branch {{name}}", { name: newBranchName }), "success");
      setNewBranchName("");
      setBranchBase("");
      const branchesData = await fetchGitBranches(projectId);
      setBranches(branchesData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToCreateBranch", "Failed to create branch"), "error");
    } finally {
      setLoading(false);
    }
  }, [newBranchName, branchBase, addToast, projectId]);

  const handleCheckoutBranch = useCallback(async (name: string) => {
    setLoading(true);
    try {
      await checkoutBranch(name, projectId);
      addToast(t("git.switchedToBranch", "Switched to {{name}}", { name }), "success");
      const [statusData, branchesData] = await Promise.all([fetchGitStatus(projectId, { extended: true }), fetchGitBranches(projectId)]);
      setStatus(statusData);
      setBranches(branchesData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToCheckoutBranch", "Failed to checkout branch"), "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, projectId]);

  const handleDeleteBranch = useCallback(async (name: string) => {
    const shouldDelete = await confirmContext.confirm({
      title: t("git.deleteBranchTitle", "Delete Branch"),
      message: t("git.deleteBranchMessage", "Delete branch \"{{name}}\"?", { name }),
      danger: true,
    });
    if (!shouldDelete) return;
    setLoading(true);
    try {
      await deleteBranch(name, undefined, projectId);
      addToast(t("git.deletedBranch", "Deleted branch {{name}}", { name }), "success");
      const branchesData = await fetchGitBranches(projectId);
      setBranches(branchesData);
    } catch (err) {
      if (getErrorMessage(err).includes("not fully merged")) {
        const shouldForceDelete = await confirmContext.confirm({
          title: t("git.forceDeleteBranchTitle", "Force Delete Branch"),
          message: t("git.forceDeleteBranchMessage", "Branch has unmerged commits. Force delete?"),
          danger: true,
        });
        if (shouldForceDelete) {
          try {
            await deleteBranch(name, true, projectId);
            addToast(t("git.forceDeletedBranch", "Force deleted branch {{name}}", { name }), "success");
            const branchesData = await fetchGitBranches(projectId);
            setBranches(branchesData);
          } catch (forceErr) {
            addToast(getErrorMessage(forceErr) || t("git.failedToDeleteBranch", "Failed to delete branch"), "error");
          }
        }
      } else {
        addToast(getErrorMessage(err) || t("git.failedToDeleteBranch", "Failed to delete branch"), "error");
      }
    } finally {
      setLoading(false);
    }
  }, [addToast, projectId, confirmContext]);

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

  const resetStashDiffState = useCallback(() => {
    stashDiffRequestIdRef.current += 1;
    setExpandedStashIndex(null);
    setStashDiff(null);
    setStashDiffError(null);
    setLoadingStashDiff(false);
  }, []);

  const handleCreateStash = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setStashLoading("create");
    resetStashDiffState();
    try {
      await createStash(stashMessage.trim() || undefined, projectId);
      addToast(t("git.changesStashed", "Changes stashed"), "success");
      setStashMessage("");
      const stashesData = await fetchGitStashList(projectId);
      setStashes(stashesData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToStashChanges", "Failed to stash changes"), "error");
    } finally {
      setStashLoading(null);
    }
  }, [stashMessage, addToast, projectId, resetStashDiffState]);

  const handleApplyStash = useCallback(async (index: number, drop: boolean = false) => {
    setStashLoading(`apply-${index}`);
    resetStashDiffState();
    try {
      await applyStash(index, drop, projectId);
      addToast(drop ? t("git.stashPopped", "Stash popped") : t("git.stashApplied", "Stash applied"), "success");
      const stashesData = await fetchGitStashList(projectId);
      setStashes(stashesData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToApplyStash", "Failed to apply stash"), "error");
    } finally {
      setStashLoading(null);
    }
  }, [addToast, projectId, resetStashDiffState]);

  const handleDropStash = useCallback(async (index: number) => {
    const shouldDrop = await confirmContext.confirm({
      title: t("git.dropStashTitle", "Drop Stash"),
      message: t("git.dropStashMessage", { index }),
      danger: true,
    });
    if (!shouldDrop) return;
    setStashLoading(`drop-${index}`);
    resetStashDiffState();
    try {
      await dropStash(index, projectId);
      addToast(t("git.stashDropped", "Stash dropped"), "success");
      const stashesData = await fetchGitStashList(projectId);
      setStashes(stashesData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToDropStash", "Failed to drop stash"), "error");
    } finally {
      setStashLoading(null);
    }
  }, [addToast, projectId, confirmContext, resetStashDiffState]);

  const handleToggleStashDiff = useCallback(async (index: number) => {
    if (expandedStashIndex === index) {
      resetStashDiffState();
      return;
    }

    const requestId = stashDiffRequestIdRef.current + 1;
    stashDiffRequestIdRef.current = requestId;
    setExpandedStashIndex(index);
    setStashDiff(null);
    setStashDiffError(null);
    setLoadingStashDiff(true);
    try {
      const diff = await fetchStashDiff(index, projectId);
      if (stashDiffRequestIdRef.current !== requestId) {
        return;
      }
      setStashDiff(diff);
    } catch (err) {
      if (stashDiffRequestIdRef.current !== requestId) {
        return;
      }
      setStashDiff(null);
      setStashDiffError(getErrorMessage(err) || t("git.failedToLoadStashDiff", "Failed to load stash diff"));
    } finally {
      if (stashDiffRequestIdRef.current === requestId) {
        setLoadingStashDiff(false);
      }
    }
  }, [expandedStashIndex, projectId, resetStashDiffState]);

  // ── Remote Handlers ─────────────────────────────────────────────

  const handleFetch = useCallback(async () => {
    setRemoteLoading("fetch");
    try {
      const result = await fetchRemote(undefined, projectId);
      setLastRemoteResult(result);
      addToast(result.message || t("git.fetchCompleted", "Fetch completed"), result.fetched ? "success" : "info");
      const statusData = await fetchGitStatus(projectId, { extended: true });
      setStatus(statusData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.fetchFailed", "Fetch failed"), "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast, projectId]);

  const handlePull = useCallback(async (options?: { rebase?: boolean }) => {
    setRemoteLoading("pull");
    try {
      const result = await pullBranch(options, projectId);
      setLastRemoteResult(result);
      if (result.conflict) {
        addToast(t("git.mergeConflictDetected", "Merge conflict detected. Resolve manually."), "error");
      } else {
        const fallbackMessage = options?.rebase ? t("git.pullRebaseCompleted", "Pull --rebase completed") : t("git.pullCompleted", "Pull completed");
        addToast(result.message || fallbackMessage, "success");
      }
      const statusData = await fetchGitStatus(projectId, { extended: true });
      setStatus(statusData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.pullFailed", "Pull failed"), "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast, projectId]);

  const handlePush = useCallback(async () => {
    setRemoteLoading("push");
    try {
      const result = await pushBranch(projectId);
      setLastRemoteResult(result);
      addToast(result.message || t("git.pushCompleted", "Push completed"), "success");
      const statusData = await fetchGitStatus(projectId, { extended: true });
      setStatus(statusData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.pushFailed", "Push failed"), "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast, projectId]);

  const handleSyncWithOrigin = useCallback(async () => {
    setRemoteLoading("sync");
    try {
      const pullResult = await pullBranch({ rebase: true }, projectId);
      setLastRemoteResult(pullResult);
      if (pullResult.conflict) {
        addToast(t("git.mergeConflictDetected", "Merge conflict detected. Resolve manually."), "error");
        return;
      }

      const pushResult = await pushBranch(projectId);
      setLastRemoteResult(pushResult);
      addToast(t("git.syncedWithOrigin", "Synced with origin (pull --rebase + push)"), "success");
      const statusData = await fetchGitStatus(projectId, { extended: true });
      setStatus(statusData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.syncWithOriginFailed", "Sync with origin failed"), "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast, projectId]);

  // Fetch rootDir from config (used as worktreePath for the per-task sync
  // button surfaced from RemotesPanel below).
  useEffect(() => {
    fetchConfig(projectId).then((cfg) => setRootDir(cfg.rootDir)).catch(() => setRootDir(null));
  }, [projectId]);

  const handleSyncIntegrationTip = useCallback(async () => {
    if (!status?.integrationBranch || status.isOnIntegrationBranch === false) return;
    const worktreePath = rootDir;
    if (!worktreePath) {
      addToast(t("git.projectRootNotAvailable", "Project root path not available"), "error");
      return;
    }
    setRemoteLoading("sync-integration");
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      await api(`/git/pull${query}`, {
        method: "POST",
        body: JSON.stringify({
          worktreePath,
          integrationBranch: status.integrationBranch,
          taskId: undefined,
          // Pure-local catch-up: the merger advanced refs/heads/<integration>
          // locally; the worktree just needs to hard-reset to that ref.
          // No reason to fetch/merge from origin here — that would silently
          // pull in unrelated remote work the operator didn't ask for.
          skipOriginFetch: true,
        }),
      });
      addToast(t("git.syncedWorktreeToIntegrationTip", "Synced worktree to local integration tip"), "success");
      const statusData = await fetchGitStatus(projectId, { extended: true });
      setStatus(statusData);
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.syncFailed", "Sync failed"), "error");
    } finally {
      setRemoteLoading(null);
    }
  }, [addToast, projectId, rootDir, status?.integrationBranch, status?.isOnIntegrationBranch, t]);

  // ── Derived state ───────────────────────────────────────────────

  const stagedFiles = useMemo(() => fileChanges.filter((f) => f.staged), [fileChanges]);
  const unstagedFiles = useMemo(() => fileChanges.filter((f) => !f.staged), [fileChanges]);

  // ── Render ──────────────────────────────────────────────────────

  if (!isOpen) return null;

  // FNXC:RightDockEmbedding 2026-06-22-00:00: shared git body reused by both the embedded inline view and the modal overlay below; kept identical between presentations.
  const gitBody = (
    <>
              {/* Sidebar Navigation */}
              <nav className="gm-sidebar" role="tablist" aria-label={t("git.sidebarAriaLabel", "Git Manager Sections")}>
                {SECTIONS.map((section) => {
                  const Icon = section.icon;
                  const sectionLabel = {
                    status: t("git.sectionStatus", "Status"),
                    changes: t("git.sectionChanges", "Changes"),
                    commits: t("git.sectionCommits", "Commits"),
                    branches: t("git.sectionBranches", "Branches"),
                    worktrees: t("git.sectionWorktrees", "Worktrees"),
                    stashes: t("git.sectionStashes", "Stashes"),
                    recovery: t("git.sectionRecovery", "Recovery"),
                    remotes: t("git.sectionRemotes", "Remotes"),
                  }[section.id] ?? section.label;
                  return (
                    <button
                      key={section.id}
                      role="tab"
                      aria-selected={activeSection === section.id}
                      aria-label={sectionLabel}
                      title={sectionLabel}
                      className={`gm-nav-item${activeSection === section.id ? " active" : ""}`}
                      onClick={() => setActiveSection(section.id)}
                    >
                      <Icon size={16} />
                      <span className="gm-nav-label">{sectionLabel}</span>
                    </button>
                  );
                })}
                {/*
                FNXC:GitManager 2026-06-22-19:00:
                Refresh relocated from the (now-removed) internal gray .modal-header into the section nav strip so it is reachable on every section ("each page") in BOTH the right-dock embedded view (wrapping tab strip) and the popped-out modal. The dock tab strip and RightDockExpandModal already supply a header, so the internal title+refresh row was a duplicate header and is removed. Same fetchSectionData + loading spinner state as before.
                */}
                <button
                  type="button"
                  className="gm-nav-refresh"
                  onClick={fetchSectionData}
                  disabled={loading}
                  title={t("git.refresh", "Refresh")}
                  aria-label={t("git.refresh", "Refresh")}
                >
                  <RefreshCw size={16} className={loading ? "spin" : ""} />
                  <span className="gm-nav-label">{t("git.refresh", "Refresh")}</span>
                </button>
              </nav>

              {/* Content Area */}
              <div className="gm-content" role="tabpanel">
                {/* Loading overlay */}
                {loading && (
                  <div className="gm-loading">
                    <Loader2 size={24} className="spin" />
                    <span>{t("git.loading", "Loading...")}</span>
                  </div>
                )}

                {/* Error state */}
                {sectionError && !loading && (
                  <div className="gm-error">
                    <AlertCircle size={18} />
                    <span>{sectionError}</span>
                    <button className="btn btn-sm" onClick={fetchSectionData}>
                      {t("git.retry", "Retry")}
                    </button>
                  </div>
                )}

                {/* ── Status Panel ── */}
                {activeSection === "status" && !loading && status && (
                  <StatusPanel
                    status={status}
                    copyToClipboard={copyToClipboard}
                    onSyncWorkingTree={handleSyncIntegrationTip}
                    syncing={remoteLoading === "sync-integration"}
                  />
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
                    onSelectDiffFile={handleSelectDiffFile}
                    selectedDiffTarget={selectedDiffTarget}
                    changeDiff={changeDiff}
                    loadingChangeDiff={loadingChangeDiff}
                    changeDiffError={changeDiffError}
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
                    onToggleStashDiff={handleToggleStashDiff}
                    stashLoading={stashLoading}
                    expandedStashIndex={expandedStashIndex}
                    stashDiff={stashDiff}
                    loadingStashDiff={loadingStashDiff}
                    stashDiffError={stashDiffError}
                  />
                )}

                {/* ── Recovery Panel ── */}
                {activeSection === "recovery" && !loading && (
                  <StashRecoveryView />
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
                    onSync={handleSyncWithOrigin}
                    onSyncIntegrationTip={handleSyncIntegrationTip}
                    syncIntegrationDisabled={
                      !status?.integrationBranch ||
                      status?.isOnIntegrationBranch === false ||
                      remoteLoading !== null
                    }
                    addToast={addToast}
                    projectId={projectId}
                    copyToClipboard={copyToClipboard}
                  />
                )}
              </div>
    </>
  );

  /*
  FNXC:RightDockEmbedding 2026-06-22-00:00:
  Embedded mode renders the same git content inline (fills the right-dock container) with no fixed overlay, no resize handle, and no close button.
  Modal mode (default) keeps the exact original overlay markup byte-identical.
  */
  if (isEmbedded) {
    return (
      <div className="git-manager-embedded right-dock-embedded-view">
        <div className="gm-modal gm-modal--embedded" ref={modalRef} style={keyboardStyle}>
          <div className="gm-layout">
            {gitBody}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay open git-manager-modal-overlay" {...overlayDismissProps} role="dialog" aria-modal="true">
      <div className="modal gm-modal" ref={modalRef} style={keyboardStyle}>
        <div className="modal-header">
          <h3>
            <FolderGit2 size={18} style={{ marginRight: 8, verticalAlign: "middle" }} />
            {t("git.modalTitle", "Git Manager")}
          </h3>
          <div className="gm-header-actions">
            <button className="modal-close" onClick={handleClose} aria-label={t("git.close", "Close")}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="gm-layout">
        {gitBody}
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
  onSyncWorkingTree,
  syncing,
}: {
  status: GitStatus;
  copyToClipboard: (text: string, label?: string) => void;
  onSyncWorkingTree: () => void;
  syncing: boolean;
}) {
  const { t } = useTranslation("app");
  const [advancesHelpOpen, setAdvancesHelpOpen] = useState(false);
  const [dismissedAdvanceShas, setDismissedAdvanceShas] = useState<Set<string>>(new Set());
  const visibleAdvances = (status.recentMergeAdvances ?? []).filter((advance) => !dismissedAdvanceShas.has(advance.toSha));
  const actionableAdvances = visibleAdvances.filter((advance) => advance.resolution === "pending");
  const hasActionableAdvances = actionableAdvances.length > 0;
  const isHeadAlignedWithIntegration = status.aheadOfIntegration === 0 && status.behindIntegration === 0;
  const showSyncWorkingTree = hasActionableAdvances && !isHeadAlignedWithIntegration;
  return (
    <div className="gm-panel" data-testid="status-panel">
      <div className="gm-panel-header">
        <h4>{t("git.repositoryStatus", "Repository Status")}</h4>
      </div>
      <div className="gm-status-grid">
        <div className="gm-status-card">
          <span className="gm-status-label">{t("git.statusLabelBranch", "Branch")}</span>
          <span className="gm-status-value">
            <GitBranchIcon size={14} />
            <span>{status.branch}</span>
            {/* Only flag "not on <integration>" when we know the worktree IS
                on a branch — detached HEAD (isOnIntegrationBranch undefined)
                is a non-branch state, not "on the wrong branch." */}
            {status.integrationBranch && status.isOnIntegrationBranch === false && (
              <span className="gm-status-sub" title={t("git.notOnIntegrationBranchTitle", "Currently on a non-integration branch")}>
                {" "}{t("git.notOnIntegrationBranch", "(not on {{branch}})", { branch: status.integrationBranch })}
              </span>
            )}
          </span>
        </div>
        <div className="gm-status-card">
          <span className="gm-status-label">{t("git.statusLabelCommit", "Commit")}</span>
          <span className="gm-status-value">
            <code className="gm-hash">{status.commit}</code>
            <button
              className="gm-icon-btn"
              onClick={() => copyToClipboard(status.commit, t("git.copyCommitHashLabel", "commit hash"))}
              title={status.headSha ? t("git.copyShortHashTitleWithFull", "Copy short commit hash (use the full SHA below for git operations)") : t("git.copyShortHashTitle", "Copy short commit hash")}
            >
              <Copy size={12} />
            </button>
            {status.headSha && (
              <button
                className="gm-icon-btn"
                onClick={() => copyToClipboard(status.headSha!, t("git.copyFullCommitHashLabel", "full commit hash"))}
                title={t("git.copyFullShaTitle", "Copy full 40-char SHA")}
              >
                <Copy size={12} />
                <span style={{ fontSize: 10, marginLeft: 2 }}>{t("git.fullShaAbbrev", "full")}</span>
              </button>
            )}
          </span>
        </div>
        <div className="gm-status-card">
          <span className="gm-status-label">{t("git.statusLabelWorkingTree", "Working Tree")}</span>
          <span className={`gm-status-badge ${status.isDirty ? "dirty" : "clean"}`}>
            {status.isDirty ? (
              <>
                <AlertCircle size={12} />
                {t("git.workingTreeModified", "Modified")}
              </>
            ) : (
              <>
                <CheckCircle size={12} />
                {t("git.workingTreeClean", "Clean")}
              </>
            )}
          </span>
          {status.dirtyDetails && (status.dirtyDetails.staged + status.dirtyDetails.modified + status.dirtyDetails.untracked + status.dirtyDetails.conflicted) > 0 && (
            <span className="gm-status-sub">
              {status.dirtyDetails.staged > 0 && <span title={t("git.staged", "Staged")}>{t("git.stagedCount", "{{count}} staged", { count: status.dirtyDetails.staged })}</span>}
              {status.dirtyDetails.staged > 0 && (status.dirtyDetails.modified + status.dirtyDetails.untracked + status.dirtyDetails.conflicted) > 0 && " · "}
              {status.dirtyDetails.modified > 0 && <span title={t("git.modified", "Modified")}>{t("git.modifiedCount", "{{count}} modified", { count: status.dirtyDetails.modified })}</span>}
              {status.dirtyDetails.modified > 0 && (status.dirtyDetails.untracked + status.dirtyDetails.conflicted) > 0 && " · "}
              {status.dirtyDetails.untracked > 0 && <span title={t("git.untracked", "Untracked")}>{t("git.untrackedCount", "{{count}} untracked", { count: status.dirtyDetails.untracked })}</span>}
              {status.dirtyDetails.untracked > 0 && status.dirtyDetails.conflicted > 0 && " · "}
              {status.dirtyDetails.conflicted > 0 && (
                <span title={t("git.unresolvedMergeConflicts", "Unresolved merge conflicts")} className="gm-status-conflict">
                  {t("git.conflictedCount", "{{count}} conflicted", { count: status.dirtyDetails.conflicted })}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="gm-status-card">
          <span className="gm-status-label">{t("git.statusLabelVsOrigin", "vs origin")}</span>
          <span className="gm-status-value">
            {status.ahead > 0 && (
              <span className="gm-ahead" title={t("git.aheadOfUpstream", "{{count}} commit(s) ahead of upstream", { count: status.ahead })}>
                <ArrowUp size={12} />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span className="gm-behind" title={t("git.behindUpstream", "{{count}} commit(s) behind upstream", { count: status.behind })}>
                <ArrowDown size={12} />
                {status.behind}
              </span>
            )}
            {status.ahead === 0 && status.behind === 0 && (
              <span className="gm-in-sync">
                <CheckCircle size={12} />
                {t("git.upToDate", "Up to date")}
              </span>
            )}
          </span>
        </div>
      </div>
      {status.integrationBranch && (
        <div className="gm-status-grid">
          <div className="gm-status-card" data-testid="integration-branch-card">
            <span className="gm-status-label">{t("git.statusLabelIntegrationBranch", "Integration branch")}</span>
            <span className="gm-status-value">
              <GitBranchIcon size={14} />
              <span>{status.integrationBranch}</span>
              {status.integrationBranchSource && (
                <span className="gm-status-sub" title={t("git.resolvedFrom", "Resolved from {{source}}", { source: status.integrationBranchSource })}>
                  {" "}({status.integrationBranchSource})
                </span>
              )}
            </span>
            {status.integrationTipSha && (
              <span className="gm-status-sub">
                {t("git.tip", "tip")} <code className="gm-hash">{status.integrationTipSha.slice(0, 8)}</code>
                {status.integrationTipSource === "remote-only" && (
                  <>
                    {" "}<span title={t("git.remoteOnlyIntegrationTipTitle", "No local refs/heads/<branch>; using refs/remotes/origin/<branch> as the integration tip.")}>{t("git.remoteOnlyTrackLocally", "(remote-only — run git switch {{branch}} to track locally)", { branch: status.integrationBranch })}</span>
                  </>
                )}
              </span>
            )}
            {status.integrationTipSource === "missing" && (
              <span className="gm-status-sub gm-status-conflict" title={t("git.noRefFoundTitle", "Neither refs/heads nor refs/remotes/origin has this branch")}>
                {t("git.noRefFound", "no ref found for {{branch}}", { branch: status.integrationBranch })}
              </span>
            )}
          </div>
          {status.integrationTipSha !== undefined && (status.aheadOfIntegration !== undefined || status.behindIntegration !== undefined) && (
            <div className="gm-status-card">
              <span className="gm-status-label">{t("git.headVsIntegration", "HEAD vs {{branch}}", { branch: status.integrationBranch })}</span>
              <span className="gm-status-value">
                {(status.aheadOfIntegration ?? 0) === 0 && (status.behindIntegration ?? 0) === 0 ? (
                  <span className="gm-in-sync">
                    <CheckCircle size={12} />
                    {t("git.aligned", "Aligned")}
                  </span>
                ) : (
                  <>
                    {(status.aheadOfIntegration ?? 0) > 0 && (
                      <span className="gm-ahead" title={t("git.headAheadOfIntegration", "HEAD has {{count}} commit(s) not on {{branch}}", { count: status.aheadOfIntegration, branch: status.integrationBranch })}>
                        <ArrowUp size={12} />
                        {status.aheadOfIntegration}
                      </span>
                    )}
                    {(status.behindIntegration ?? 0) > 0 && (
                      <span className="gm-behind" title={t("git.integrationAheadOfHead", "{{branch}} has {{count}} commit(s) HEAD doesn't", { branch: status.integrationBranch, count: status.behindIntegration })}>
                        <ArrowDown size={12} />
                        {status.behindIntegration}
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
          )}
          {status.originIntegrationTipSha !== undefined && (
            <div className="gm-status-card">
              <span className="gm-status-label">{t("git.localVsOrigin", "Local {{branch}} vs origin", { branch: status.integrationBranch })}</span>
              <span className="gm-status-value">
                {status.originIntegrationTipSha === null ? (
                  <span className="gm-status-sub">{t("git.noOriginTracking", "no origin tracking")}</span>
                ) : status.integrationTipSource === "remote-only" ? (
                  // Local branch doesn't exist — comparing "local vs origin"
                  // is undefined. Show an honest state instead of a green
                  // "Synced" badge that would imply the local ref is in
                  // sync with origin when there's no local ref at all.
                  <span className="gm-status-sub" title={t("git.noLocalRefTitle", "No local refs/heads/<branch> exists; nothing to compare against origin.")}>
                    {t("git.noLocalTracking", "no local tracking")}
                  </span>
                ) : (status.aheadOfOriginIntegration ?? 0) === 0 && (status.behindOriginIntegration ?? 0) === 0 ? (
                  <span className="gm-in-sync">
                    <CheckCircle size={12} />
                    {t("git.synced", "Synced")}
                  </span>
                ) : (
                  <>
                    {(status.aheadOfOriginIntegration ?? 0) > 0 && (
                      <span className="gm-ahead" title={t("git.localAheadOfOriginIntegration", "Local {{branch}} is {{count}} commit(s) ahead of origin/{{branch}}", { branch: status.integrationBranch, count: status.aheadOfOriginIntegration })}>
                        <ArrowUp size={12} />
                        {status.aheadOfOriginIntegration}
                      </span>
                    )}
                    {(status.behindOriginIntegration ?? 0) > 0 && (
                      <span className="gm-behind" title={t("git.localBehindOriginIntegration", "Local {{branch}} is {{count}} commit(s) behind origin/{{branch}}", { branch: status.integrationBranch, count: status.behindOriginIntegration })}>
                        <ArrowDown size={12} />
                        {status.behindOriginIntegration}
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
          )}
          {status.integrationTipSource === "remote-only" && status.aheadOfIntegrationRemote !== undefined && (
            // In remote-only mode the `HEAD vs <branch>` card is suppressed
            // (no local tip to compare against). Surface a dedicated HEAD vs
            // origin/<branch> card so the operator still sees a meaningful
            // distance.
            <div className="gm-status-card">
              <span className="gm-status-label">{t("git.headVsOriginIntegration", "HEAD vs origin/{{branch}}", { branch: status.integrationBranch })}</span>
              <span className="gm-status-value">
                {(status.aheadOfIntegrationRemote ?? 0) === 0 && (status.behindIntegrationRemote ?? 0) === 0 ? (
                  <span className="gm-in-sync">
                    <CheckCircle size={12} />
                    {t("git.aligned", "Aligned")}
                  </span>
                ) : (
                  <>
                    {(status.aheadOfIntegrationRemote ?? 0) > 0 && (
                      <span className="gm-ahead" title={t("git.headAheadOfOriginIntegration", "HEAD has {{count}} commit(s) not on origin/{{branch}}", { count: status.aheadOfIntegrationRemote, branch: status.integrationBranch })}>
                        <ArrowUp size={12} />
                        {status.aheadOfIntegrationRemote}
                      </span>
                    )}
                    {(status.behindIntegrationRemote ?? 0) > 0 && (
                      <span className="gm-behind" title={t("git.originIntegrationAheadOfHead", "origin/{{branch}} has {{count}} commit(s) HEAD doesn't", { branch: status.integrationBranch, count: status.behindIntegrationRemote })}>
                        <ArrowDown size={12} />
                        {status.behindIntegrationRemote}
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
          )}
          {(status.stashCount ?? 0) > 0 && (
            <div className="gm-status-card">
              <span className="gm-status-label">{t("git.statusLabelStashes", "Stashes")}</span>
              <span className="gm-status-value">
                <Archive size={14} />
                <span>{status.stashCount}</span>
              </span>
            </div>
          )}
        </div>
      )}
      {status.indexStaleVsHead === true && (
        <div className="gm-status-warning" data-testid="index-stale-warning" role="alert">
          <AlertCircle size={14} />
          <div>
            <Trans
              i18nKey="app:git.staleIndexWarning"
              defaults="<strong>Stale index detected.</strong> HEAD has advanced (typically because Fusion's merger updated the integration-branch ref) but the index still reflects the previous tip — `git status` will report the new commits inverted as &quot;staged changes.&quot; Enable <mergeCode>mergeAdvanceAutoSync</mergeCode> in Settings to have the merger reconcile automatically, or run <resetCode>git reset --hard HEAD</resetCode> to snap forward manually."
              components={{ strong: <strong />, mergeCode: <code />, resetCode: <code /> }}
            />
          </div>
        </div>
      )}
      {visibleAdvances.length > 0 && (
        <div className="gm-status-advances" data-testid="recent-merge-advances">
          <div className="gm-status-advances-header">
            <span>
              {t("git.recentIntegrationAdvances", "Recent integration-branch advances")}
              <span className="gm-status-sub">
                {" "}({t("git.advancesNeedAction", "{{count}} need action", { count: actionableAdvances.length })})
              </span>
              <button
                type="button"
                className="gm-icon-btn"
                style={{ marginLeft: 6 }}
                aria-expanded={advancesHelpOpen}
                aria-label={advancesHelpOpen ? t("git.hideExplanation", "Hide explanation") : t("git.whatDoesThisMean", "What does this mean?")}
                onClick={() => setAdvancesHelpOpen((open) => !open)}
                title={t("git.whatDoesThisMean", "What does this mean?")}
              >
                <Info size={13} />
              </button>
            </span>
            {showSyncWorkingTree && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={onSyncWorkingTree}
                disabled={syncing}
                data-testid="sync-working-tree-btn"
                title={t("git.syncWorkingTreeTitle", "Pull the integration branch into your working tree (auto-stashes uncommitted edits and restores them)")}
              >
                {syncing ? t("git.syncing", "Syncing…") : t("git.syncWorkingTree", "Sync working tree")}
              </button>
            )}
          </div>
          {advancesHelpOpen && (
            <div className="gm-status-advances-help" data-testid="recent-merge-advances-help">
              <p>
                <Trans
                  i18nKey="app:git.advancesHelpIntro"
                  defaults="Each entry is a Fusion task whose squash commit advanced the integration branch ref (<branchCode>{{integrationBranch}}</branchCode>). The <em>auto-sync outcome</em> says whether your working tree was also fast-forwarded to that new tip."
                  values={{ integrationBranch: status.integrationBranch ?? "main" }}
                  components={{ branchCode: <code />, em: <em /> }}
                />
              </p>
              <ul className="gm-status-advances-help-list">
                <li>
                  <Trans
                    i18nKey="app:git.advancesHelpItem1"
                    defaults="<c1>clean-sync</c1> / <c2>synced-with-edits-restored</c2> — working tree is in sync; nothing to do."
                    components={{ c1: <code />, c2: <code /> }}
                  />
                </li>
                <li>
                  <Trans
                    i18nKey="app:git.advancesHelpItem2"
                    defaults="<c1>reachable</c1> / <c2>subsumed</c2> / <c3>orphaned</c3> / <c4>superseded</c4> — already handled (including history rewrites where equivalent content already landed, original SHAs disappeared, or HEAD is already aligned to the rewritten integration tip)."
                    components={{ c1: <code />, c2: <code />, c3: <code />, c4: <code /> }}
                  />
                </li>
                <li>
                  <Trans
                    i18nKey="app:git.advancesHelpItem3"
                    defaults="<c1>pending</c1> + <c2>off / not run</c2> — auto-sync is disabled in Settings; the branch ref moved but your worktree didn't follow."
                    components={{ c1: <code />, c2: <code /> }}
                  />
                </li>
                <li>
                  <Trans
                    i18nKey="app:git.advancesHelpItem4"
                    defaults="<c1>pending</c1> + <c2>stash-failed</c2> / <c3>would-conflict</c3> / similar — auto-sync tried but couldn't reconcile (usually local edits collide with the new commit)."
                    components={{ c1: <code />, c2: <code />, c3: <code /> }}
                  />
                </li>
              </ul>
              <p>
                <Trans
                  i18nKey="app:git.advancesHelpFix"
                  defaults="<strong>Fix:</strong> Fusion only shows <em>Sync working tree</em> when at least one advance is genuinely <code>pending</code> and HEAD is not aligned with the integration tip. If entries are already handled (subsumed/orphaned/reachable/superseded), no sync action is offered."
                  components={{ strong: <strong />, em: <em />, code: <code /> }}
                />
              </p>
            </div>
          )}
          <ul>
            {visibleAdvances.map((advance) => (
              <li key={`${advance.taskId}-${advance.toSha}`} className={advance.needsAction ? "gm-advance-needs-action" : "gm-advance-handled"}>
                <code className="gm-hash">{advance.toSha.slice(0, 8)}</code>
                {" "}
                <strong>{advance.taskId}</strong>
                {advance.autoSyncOutcome ? (
                  <span className="gm-status-sub">
                    {" "}{t("git.autoSyncOutcome", "auto-sync: {{outcome}}", { outcome: advance.autoSyncOutcome })}
                  </span>
                ) : (
                  <span className="gm-status-sub">
                    {" "}{t("git.autoSyncOffNotRun", "auto-sync: off / not run")}
                  </span>
                )}
                <span className="gm-status-sub">
                  {" "}· {new Date(advance.advancedAt).toLocaleTimeString()} · {advance.resolution}
                </span>
                {(advance.resolution === "orphaned" || advance.resolution === "subsumed" || advance.resolution === "superseded") && (
                  <button
                    type="button"
                    className="btn btn-xs"
                    onClick={() => {
                      setDismissedAdvanceShas((prev) => {
                        const next = new Set(prev);
                        next.add(advance.toSha);
                        return next;
                      });
                    }}
                    data-testid={`dismiss-advance-${advance.toSha}`}
                  >
                    {t("git.dismiss", "Dismiss")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
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
  onSelectDiffFile,
  selectedDiffTarget,
  changeDiff,
  loadingChangeDiff,
  changeDiffError,
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
  onSelectDiffFile: (file: string, staged: boolean) => void;
  selectedDiffTarget: { file: string; staged: boolean } | null;
  changeDiff: { stat: string; patch: string } | null;
  loadingChangeDiff: boolean;
  changeDiffError: string | null;
  commitMessage: string;
  setCommitMessage: (msg: string) => void;
  onCommit: (e: React.FormEvent) => void;
  onStageAllAndCommit: () => void;
  committing: boolean;
}) {
  const { t } = useTranslation("app");
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
            <span className="gm-dirty-badge">{t("git.workingTreeModified", "Modified")}</span>
          )}
        </div>
      )}

      <div className="gm-changes-split">
      <div className="gm-changes-lists">
      {/* Unstaged Changes */}
      <div className="gm-file-section">
        <div className="gm-file-section-header">
          <h5>{t("git.unstagedChanges", "Unstaged Changes ({{count}})", { count: unstagedFiles.length })}</h5>
          <div className="gm-file-section-actions">
            {selectedUnstaged.length > 0 && (
              <>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => onStageFiles(selectedUnstaged.map((f) => f.file))}
                  title={t("git.stageSelected", "Stage selected")}
                >
                  <Plus size={12} /> {t("git.stageCount", "Stage ({{count}})", { count: selectedUnstaged.length })}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => onDiscardChanges(selectedUnstaged.map((f) => f.file))}
                  title={t("git.discardSelected", "Discard selected")}
                >
                  <XCircle size={12} />
                </button>
              </>
            )}
            {unstagedFiles.length > 0 && (
              <button
                className="btn btn-sm"
                onClick={() => onStageFiles(unstagedFiles.map((f) => f.file))}
                title={t("git.stageAll", "Stage all")}
              >
                {t("git.stageAll", "Stage All")}
              </button>
            )}
          </div>
        </div>
        <div className="gm-file-list gm-file-list-unstaged" data-testid="gm-file-list-unstaged">
          {unstagedFiles.length === 0 ? (
            <div className="gm-empty">{t("git.noUnstagedChanges", "No unstaged changes")}</div>
          ) : (
            unstagedFiles.map((f) => {
              const isActive = selectedDiffTarget?.file === f.file && selectedDiffTarget.staged === false;
              return (
                <div
                  key={`unstaged:${f.file}`}
                  className={`gm-file-item${isActive ? " active" : ""}`}
                  onClick={() => onSelectDiffFile(f.file, false)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectDiffFile(f.file, false);
                    }
                  }}
                >
                  <label className="gm-file-checkbox" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedFiles.has(`unstaged:${f.file}`)}
                      onChange={() => toggleFileSelection(`unstaged:${f.file}`)}
                    />
                  </label>
                  <FileStatusIcon status={f.status} />
                  <span className="gm-file-name" title={f.file}><bdo dir="ltr">{f.file}</bdo></span>
                  <FileStatusBadge status={f.status} />
                  <button
                    className="gm-icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStageFiles([f.file]);
                    }}
                    title={t("git.stageFile", "Stage file")}
                  >
                    <Plus size={12} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Staged Changes */}
      <div className="gm-file-section">
        <div className="gm-file-section-header">
          <h5>{t("git.stagedChanges", "Staged Changes ({{count}})", { count: stagedFiles.length })}</h5>
          <div className="gm-file-section-actions">
            {selectedStaged.length > 0 && (
              <button
                className="btn btn-sm"
                onClick={() => onUnstageFiles(selectedStaged.map((f) => f.file))}
                title={t("git.unstageSelected", "Unstage selected")}
              >
                {t("git.unstageCount", "Unstage ({{count}})", { count: selectedStaged.length })}
              </button>
            )}
            {stagedFiles.length > 0 && (
              <button
                className="btn btn-sm"
                onClick={() => onUnstageFiles(stagedFiles.map((f) => f.file))}
                title={t("git.unstageAll", "Unstage all")}
              >
                {t("git.unstageAll", "Unstage All")}
              </button>
            )}
          </div>
        </div>
        <div className="gm-file-list gm-file-list-staged" data-testid="gm-file-list-staged">
          {stagedFiles.length === 0 ? (
            <div className="gm-empty">{t("git.noStagedChanges", "No staged changes")}</div>
          ) : (
            stagedFiles.map((f) => {
              const isActive = selectedDiffTarget?.file === f.file && selectedDiffTarget.staged === true;
              return (
                <div
                  key={`staged:${f.file}`}
                  className={`gm-file-item staged${isActive ? " active" : ""}`}
                  onClick={() => onSelectDiffFile(f.file, true)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectDiffFile(f.file, true);
                    }
                  }}
                >
                  <label className="gm-file-checkbox" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedFiles.has(`staged:${f.file}`)}
                      onChange={() => toggleFileSelection(`staged:${f.file}`)}
                    />
                  </label>
                  <FileStatusIcon status={f.status} />
                  <span className="gm-file-name" title={f.file}><bdo dir="ltr">{f.file}</bdo></span>
                  <FileStatusBadge status={f.status} />
                  <button
                    className="gm-icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnstageFiles([f.file]);
                    }}
                    title={t("git.unstageFile", "Unstage file")}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      </div>
      {/* Diff Viewer (right pane on desktop, stacked below on mobile) */}
      <div className="gm-changes-diff">
        {(selectedDiffTarget || loadingChangeDiff || changeDiff || changeDiffError) ? (
          <div className="gm-diff-section">
            {selectedDiffTarget && (
              <div className="gm-diff-target">
                <FileDiff size={14} />
                <span>{selectedDiffTarget.staged ? t("git.staged", "Staged") : t("git.unstaged", "Unstaged")} {t("git.diffColon", "diff:")} </span>
                <code>{selectedDiffTarget.file}</code>
              </div>
            )}
            {loadingChangeDiff && (
              <div className="gm-diff-loading">
                <Loader2 size={16} className="spin" />
                {t("git.loadingDiff", "Loading diff...")}
              </div>
            )}
            {changeDiffError && !loadingChangeDiff && (
              <div className="gm-diff-error">{changeDiffError}</div>
            )}
            {changeDiff && !loadingChangeDiff && (
              <div className="gm-diff-viewer">
                {changeDiff.stat && <pre className="gm-diff-stat">{changeDiff.stat}</pre>}
                <pre className="gm-diff-patch">{changeDiff.patch}</pre>
              </div>
            )}
          </div>
        ) : (
          <div className="gm-diff-empty">
            <FileDiff size={20} />
            <span>{t("git.selectFileToViewDiff", "Select a file to view its diff")}</span>
          </div>
        )}
      </div>
      </div>
      {/* /gm-changes-split */}

      {/* Commit Form */}
      <form className="gm-commit-form" onSubmit={onCommit}>
        <textarea
          className="gm-commit-input"
          placeholder={t("git.commitMessagePlaceholder", "Commit message...")}
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
            title={stagedFiles.length === 0 ? t("git.noStagedChangesToCommit", "No staged changes to commit") : t("git.commitStagedChanges", "Commit staged changes")}
          >
            {committing ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            {t("git.commit", "Commit")}
          </button>
          {unstagedFiles.length > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onStageAllAndCommit}
              disabled={committing || !commitMessage.trim()}
              title={t("git.stageAllAndCommitTitle", "Stage all and commit")}
            >
              {t("git.stageAllAndCommit", "Stage All & Commit")}
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
  const { t } = useTranslation("app");
  return (
    <div className="gm-panel" data-testid="commits-panel">
      <div className="gm-panel-header">
        <h4>{t("git.sectionCommits", "Commits")}</h4>
        <div className="gm-search-box">
          <Search size={14} />
          <input
            type="text"
            placeholder={t("git.searchCommits", "Search commits...")}
            value={commitSearch}
            onChange={(e) => setCommitSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="gm-commits-list">
        {commits.length === 0 ? (
          <div className="gm-empty">
            {commitSearch ? t("git.noMatchingCommits", "No matching commits") : t("git.noCommitsFound", "No commits found")}
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
                      <span className="gm-merge-badge">{t("git.mergeBadge", "merge")}</span>
                    )}
                  </div>
                </button>
                <div className="gm-commit-actions-row">
                  <button
                    className="gm-icon-btn"
                    onClick={() => copyToClipboard(commit.hash, t("git.copyCommitHashLabel", "commit hash"))}
                    title={t("git.copyFullHash", "Copy full hash")}
                  >
                    <Copy size={12} />
                  </button>
                </div>
                {selectedCommit === commit.hash && (
                  <div className="gm-commit-diff">
                    {loadingDiff ? (
                      <div className="gm-diff-loading">
                        <Loader2 size={16} className="spin" />
                        {t("git.loadingDiff", "Loading diff...")}
                      </div>
                    ) : commitDiff ? (
                      <>
                        {commit.body && <div className="gm-commit-message-full">{commit.body}</div>}
                        {commitDiff.stat && <pre className="gm-diff-stat">{commitDiff.stat}</pre>}
                        <pre className="gm-diff-patch">{commitDiff.patch}</pre>
                      </>
                    ) : (
                      <div className="gm-diff-error">{t("git.failedToLoadDiff", "Failed to load diff")}</div>
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
          {t("git.loadMoreCommits", "Load more commits")}
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
  const { t } = useTranslation("app");
  return (
    <div className="gm-panel" data-testid="branches-panel">
      <div className="gm-panel-header">
        <h4>{t("git.sectionBranches", "Branches")}</h4>
        <div className="gm-search-box">
          <Search size={14} />
          <input
            type="text"
            placeholder={t("git.filterBranches", "Filter branches...")}
            value={branchSearch}
            onChange={(e) => setBranchSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Create branch form */}
      <form className="gm-create-form" onSubmit={onCreateBranch}>
        <input
          type="text"
          placeholder={t("git.newBranchName", "New branch name")}
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
          <option value="">{t("git.baseHead", "Base: HEAD")}</option>
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
          {t("git.create", "Create")}
        </button>
      </form>

      {/* Branches list */}
      <div className="gm-branches-list">
        {branches.length === 0 ? (
          <div className="gm-empty">
            {branchSearch ? t("git.noMatchingBranches", "No matching branches") : t("git.noBranchesFound", "No branches found")}
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
                        title={t("git.checkout", "Checkout")}
                      >
                        <GitBranchIcon size={14} />
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={(e) => { e.stopPropagation(); onDeleteBranch(branch.name); }}
                        disabled={loading}
                        title={t("git.deleteBranch", "Delete")}
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
                      {t("git.commitsOnBranch", "Commits on {{name}}", { name: branch.name })}
                    </span>
                    <button
                      className="gm-icon-btn"
                      onClick={onCloseBranchDetails}
                      title={t("git.close", "Close")}
                      data-testid="close-branch-details"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {loadingBranchCommits ? (
                    <div className="gm-branch-details-loading">
                      <Loader2 size={16} className="spin" />
                      {t("git.loadingCommits", "Loading commits...")}
                    </div>
                  ) : branchCommits.length === 0 ? (
                    <div className="gm-empty">{t("git.noCommitsFound", "No commits found")}</div>
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
                                <span className="gm-merge-badge">{t("git.mergeBadge", "merge")}</span>
                              )}
                            </div>
                          </button>
                          {expandedBranchCommit === commit.hash && (
                            <div className="gm-commit-diff">
                              {loadingBranchCommitDiff ? (
                                <div className="gm-diff-loading">
                                  <Loader2 size={16} className="spin" />
                                  {t("git.loadingDiff", "Loading diff...")}
                                </div>
                              ) : branchCommitDiff ? (
                                <>
                                  {(commit.body || commit.message) && (
                                    <div className="gm-commit-message-full">{commit.body || commit.message}</div>
                                  )}
                                  {branchCommitDiff.stat && <pre className="gm-diff-stat">{branchCommitDiff.stat}</pre>}
                                  <pre className="gm-diff-patch">{branchCommitDiff.patch}</pre>
                                </>
                              ) : (
                                <div className="gm-diff-error">{t("git.failedToLoadDiff", "Failed to load diff")}</div>
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
  const { t } = useTranslation("app");
  return (
    <div className="gm-panel" data-testid="worktrees-panel">
      <div className="gm-panel-header">
        <h4>{t("git.sectionWorktrees", "Worktrees")}</h4>
        <div className="gm-worktree-stats">
          <span>{t("git.worktreesTotal", "{{count}} total", { count: worktrees.length })}</span>
          <span className="gm-stat-separator">•</span>
          <span>{t("git.worktreesInUse", "{{count}} in use", { count: worktrees.filter((w) => w.taskId).length })}</span>
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
                {worktree.isMain && <span className="gm-badge main">{t("git.worktreeBadgeMain", "main")}</span>}
                {worktree.isBare && <span className="gm-badge bare">{t("git.worktreeBadgeBare", "bare")}</span>}
                <span className="gm-worktree-path" title={worktree.path}>
                  {getPathBasename(worktree.path) || worktree.path}
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
  onToggleStashDiff,
  stashLoading,
  expandedStashIndex,
  stashDiff,
  loadingStashDiff,
  stashDiffError,
}: {
  stashes: GitStash[];
  stashMessage: string;
  setStashMessage: (msg: string) => void;
  onCreateStash: (e: React.FormEvent) => void;
  onApplyStash: (index: number, drop?: boolean) => void;
  onDropStash: (index: number) => void;
  onToggleStashDiff: (index: number) => void;
  stashLoading: string | null;
  expandedStashIndex: number | null;
  stashDiff: { stat: string; patch: string } | null;
  loadingStashDiff: boolean;
  stashDiffError: string | null;
}) {
  const { t } = useTranslation("app");
  return (
    <div className="gm-panel" data-testid="stashes-panel">
      <div className="gm-panel-header">
        <h4>{t("git.sectionStashes", "Stashes")}</h4>
      </div>

      {/* Create stash form */}
      <form className="gm-create-form" onSubmit={onCreateStash}>
        <input
          type="text"
          placeholder={t("git.stashMessagePlaceholder", "Stash message (optional)")}
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
          {t("git.stash", "Stash")}
        </button>
      </form>

      {/* Stash list */}
      <div className="gm-stash-list">
        {stashes.length === 0 ? (
          <div className="gm-empty">{t("git.noStashes", "No stashes")}</div>
        ) : (
          stashes.map((stash) => (
            <div key={stash.index} className="gm-stash-item">
              <div className="gm-stash-header">
                <div className="gm-stash-info">
                  <span className="gm-stash-ref">{t("git.stashRef", "stash@{{index}}", { index: `{${stash.index}}` })}</span>
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
                    className="btn btn-sm"
                    onClick={() => onToggleStashDiff(stash.index)}
                    disabled={stashLoading !== null}
                  >
                    {expandedStashIndex === stash.index ? t("git.hide", "Hide") : t("git.view", "View")}
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => onApplyStash(stash.index, false)}
                    disabled={stashLoading !== null}
                    title={t("git.applyStashKeep", "Apply stash (keep)")}
                  >
                    {stashLoading === `apply-${stash.index}` ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      t("git.apply", "Apply")
                    )}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => onApplyStash(stash.index, true)}
                    disabled={stashLoading !== null}
                    title={t("git.popStashTitle", "Pop stash (apply and drop)")}
                  >
                    {t("git.pop", "Pop")}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => onDropStash(stash.index)}
                    disabled={stashLoading !== null}
                    title={t("git.dropStash", "Drop stash")}
                  >
                    {stashLoading === `drop-${stash.index}` ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </div>
              </div>

              {expandedStashIndex === stash.index && (
                <div className="gm-stash-diff">
                  {loadingStashDiff ? (
                    <div className="gm-diff-loading">
                      <Loader2 size={14} className="spin" />
                      {t("git.loadingStashDiff", "Loading stash diff…")}
                    </div>
                  ) : stashDiffError ? (
                    <div className="gm-diff-error">{stashDiffError}</div>
                  ) : stashDiff ? (
                    <div className="gm-diff-viewer">
                      {stashDiff.stat && <pre className="gm-diff-stat">{stashDiff.stat}</pre>}
                      <pre className="gm-diff-patch">{stashDiff.patch}</pre>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Enhanced Remotes panel with two-column layout */
function RemotesPanel({
  status,
  remoteLoading,
  lastRemoteResult,
  onFetch,
  onPull,
  onPush,
  onSync,
  onSyncIntegrationTip,
  syncIntegrationDisabled,
  addToast,
  projectId,
  copyToClipboard,
}: {
  status: GitStatus | null;
  remoteLoading: string | null;
  lastRemoteResult: GitFetchResult | GitPullResult | GitPushResult | null;
  onFetch: () => void;
  onPull: (options?: { rebase?: boolean }) => void;
  onPush: () => void;
  onSync: () => void;
  onSyncIntegrationTip: () => void;
  syncIntegrationDisabled: boolean;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
  copyToClipboard: (text: string, label?: string) => void;
}) {
  const { t } = useTranslation("app");

  /** Extract hostname from remote URL */
  const getHostFromUrl = (url: string): string => {
    try {
      return new URL(url).hostname;
    } catch {
      return url.replace(/^git@/, "").split(":")[0] || url;
    }
  };

  const [remotes, setRemotes] = useState<GitRemoteDetailed[]>([]);
  const [loading, setLoading] = useState(false);
  const [remoteActionLoading, setRemoteActionLoading] = useState<string | null>(null);
  const [newRemoteName, setNewRemoteName] = useState("");
  const [newRemoteUrl, setNewRemoteUrl] = useState("");
  const [editingRemote, setEditingRemote] = useState<string | null>(null);
  const [editUrlValue, setEditUrlValue] = useState("");
  const [editNameValue, setEditNameValue] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  const pullSplitRef = useRef<HTMLDivElement | null>(null);

  // Ahead commits (local commits to push)
  const [aheadCommits, setAheadCommits] = useState<GitCommit[]>([]);
  const [loadingAhead, setLoadingAhead] = useState(false);

  // Selected remote and its recent commits
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);
  const [remoteCommits, setRemoteCommits] = useState<GitCommit[]>([]);
  const [loadingRemoteCommits, setLoadingRemoteCommits] = useState(false);
  const [remoteCommitsError, setRemoteCommitsError] = useState<string | null>(null);
  const remoteCommitsRequestIdRef = useRef(0);

  // Derived state for selected remote
  const selectedRemoteData = remotes.find((r) => r.name === selectedRemote);

  useEffect(() => {
    if (remoteLoading !== null || loading) {
      setPullMenuOpen(false);
    }
  }, [remoteLoading, loading]);

  useEffect(() => {
    if (!pullMenuOpen) {
      return;
    }

    const handleDocumentClick = (event: MouseEvent) => {
      if (!pullSplitRef.current?.contains(event.target as Node)) {
        setPullMenuOpen(false);
      }
    };

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPullMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [pullMenuOpen]);

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

  // Refresh selected remote commits after successful sync operations.
  useEffect(() => {
    if (!selectedRemote || !lastRemoteResult) return;
    loadRemoteCommits(selectedRemote);
  }, [selectedRemote, lastRemoteResult]);

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
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToLoadRemotes", "Failed to load remotes"), "error");
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
    const requestId = remoteCommitsRequestIdRef.current + 1;
    remoteCommitsRequestIdRef.current = requestId;
    setLoadingRemoteCommits(true);
    setRemoteCommitsError(null);
    try {
      const commits = await fetchRemoteCommits(remoteName, undefined, 10, projectId);
      if (remoteCommitsRequestIdRef.current !== requestId) {
        return;
      }
      setRemoteCommits(commits);
    } catch (err) {
      if (remoteCommitsRequestIdRef.current !== requestId) {
        return;
      }
      setRemoteCommitsError(getErrorMessage(err) || t("git.failedToLoadRemoteCommits", "Failed to load remote commits"));
      setRemoteCommits([]);
    } finally {
      if (remoteCommitsRequestIdRef.current === requestId) {
        setLoadingRemoteCommits(false);
      }
    }
  };

  const confirmContextRemote = useConfirm();

  const handleAddRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRemoteName.trim() || !newRemoteUrl.trim()) return;

    setRemoteActionLoading("add");
    try {
      await addGitRemote(newRemoteName.trim(), newRemoteUrl.trim(), projectId);
      addToast(t("git.remoteAdded", "Remote '{{name}}' added successfully", { name: newRemoteName }), "success");
      setNewRemoteName("");
      setNewRemoteUrl("");
      setShowAddForm(false);
      await loadRemotes();
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToAddRemote", "Failed to add remote"), "error");
    } finally {
      setRemoteActionLoading(null);
    }
  };

  const handleRemoveRemote = async (name: string) => {
    const shouldRemove = await confirmContextRemote.confirm({
      title: t("git.removeRemoteTitle", "Remove Remote"),
      message: t("git.removeRemoteMessage", "Are you sure you want to remove remote '{{name}}'?", { name }),
      danger: true,
    });
    if (!shouldRemove) return;

    setRemoteActionLoading(`remove-${name}`);
    try {
      await removeGitRemote(name, projectId);
      addToast(t("git.remoteRemoved", "Remote '{{name}}' removed", { name }), "success");
      await loadRemotes();
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToRemoveRemote", "Failed to remove remote"), "error");
    } finally {
      setRemoteActionLoading(null);
    }
  };

  const handleRenameRemote = async (oldName: string) => {
    if (!editNameValue.trim()) return;

    setRemoteActionLoading(`rename-${oldName}`);
    try {
      await renameGitRemote(oldName, editNameValue.trim(), projectId);
      addToast(t("git.remoteRenamed", "Remote renamed to '{{name}}'", { name: editNameValue.trim() }), "success");
      setEditingRemote(null);
      setEditNameValue("");
      await loadRemotes();
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToRenameRemote", "Failed to rename remote"), "error");
    } finally {
      setRemoteActionLoading(null);
    }
  };

  const handleUpdateUrl = async (name: string) => {
    if (!editUrlValue.trim()) return;

    setRemoteActionLoading(`url-${name}`);
    try {
      await updateGitRemoteUrl(name, editUrlValue.trim(), projectId);
      addToast(t("git.remoteUrlUpdated", "Remote URL updated"), "success");
      setEditingRemote(null);
      setEditUrlValue("");
      await loadRemotes();
    } catch (err) {
      addToast(getErrorMessage(err) || t("git.failedToUpdateRemoteUrl", "Failed to update remote URL"), "error");
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
      {/* Two-column layout */}
      <div className="gm-remotes-layout">
        {/* ── Left Column: Remote Selector ── */}
        <div className="gm-remote-selector" data-testid="remote-selector">
          <div className="gm-remote-selector-header">
            <span className="gm-remote-selector-title">{t("git.sectionRemotes", "Remotes")}</span>
            <button
              className="btn btn-sm"
              onClick={() => setShowAddForm(!showAddForm)}
              disabled={remoteActionLoading !== null}
              title={showAddForm ? t("git.cancel", "Cancel") : t("git.addRemote", "Add Remote")}
            >
              {showAddForm ? <X size={14} /> : <Plus size={14} />}
            </button>
          </div>

          {/* Add Remote Form - collapsible */}
          {showAddForm && (
            <form className="gm-remote-form" onSubmit={handleAddRemote}>
              <input
                type="text"
                placeholder={t("git.remoteName", "Remote name")}
                value={newRemoteName}
                onChange={(e) => setNewRemoteName(e.target.value)}
                disabled={remoteActionLoading === "add"}
                className="input gm-input"
              />
              <input
                type="text"
                placeholder={t("git.repositoryUrl", "Repository URL")}
                value={newRemoteUrl}
                onChange={(e) => setNewRemoteUrl(e.target.value)}
                disabled={remoteActionLoading === "add"}
                className="input gm-input gm-input-url"
              />
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={!newRemoteName.trim() || !newRemoteUrl.trim() || remoteActionLoading === "add"}
              >
                {remoteActionLoading === "add" ? (
                  <Loader2 size={12} className="spin" />
                ) : (
                  <Plus size={12} />
                )}
                {t("git.add", "Add")}
              </button>
            </form>
          )}

          {/* Remote list */}
          {loading ? (
            <div className="gm-loading">
              <Loader2 size={16} className="spin" />
              {t("git.loading", "Loading...")}
            </div>
          ) : remotes.length === 0 ? (
            <div className="gm-empty">{t("git.noRemotes", "No remotes")}</div>
          ) : (
            remotes.map((remote) => (
              <div
                key={remote.name}
                className={`gm-remote-selector-item${selectedRemote === remote.name ? " selected" : ""}`}
                onClick={() => setSelectedRemote(remote.name)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedRemote(remote.name);
                  }
                }}
              >
                <div className="gm-remote-selector-info">
                  <span className="gm-remote-selector-name">
                    <span className="gm-remote-selector-name-text">{remote.name}</span>
                    {remote.name === "origin" && (
                      <span className="gm-remote-default-badge">{t("git.defaultBadge", "default")}</span>
                    )}
                  </span>
                  <span className="gm-remote-selector-host" title={remote.fetchUrl}>
                    {getHostFromUrl(remote.fetchUrl)}
                  </span>
                </div>
                <button
                  className="btn btn-icon btn-sm gm-remote-remove-btn"
                  onClick={(e) => { e.stopPropagation(); handleRemoveRemote(remote.name); }}
                  disabled={remoteActionLoading !== null}
                  title={t("git.removeRemote", "Remove remote")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        {/* ── Right Column: Detail Panel ── */}
        <div className="gm-remote-detail" data-testid="remote-detail-panel">
          {selectedRemote && selectedRemoteData ? (
            <>
              {/* Sync Status Card */}
              <div className="gm-remote-sync-card" data-testid="remote-sync-card">
                <div className="gm-remote-sync-card-header">
                  <span className="gm-remote-sync-card-title">{selectedRemote}</span>
                  {status && (status.ahead > 0 || status.behind > 0) && (
                    <div className="gm-remote-status">
                      {status.ahead > 0 && (
                        <div className="gm-remote-indicator ahead">
                          <span className="status-dot status-dot--online" aria-hidden="true" />
                          <ArrowUp size={14} />
                          {t("git.commitsToPush", "{{count}} to push", { count: status.ahead })}
                        </div>
                      )}
                      {status.behind > 0 && (
                        <div className="gm-remote-indicator behind">
                          <span className="status-dot status-dot--pending" aria-hidden="true" />
                          <ArrowDown size={14} />
                          {t("git.commitsToPull", "{{count}} to pull", { count: status.behind })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
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
                    {t("git.fetch", "Fetch")}
                  </button>
                  <div className="gm-pull-split" ref={pullSplitRef}>
                    <button
                      className="btn btn-primary gm-pull-split-main"
                      onClick={() => {
                        setPullMenuOpen(false);
                        onPull({ rebase: false });
                      }}
                      disabled={remoteLoading !== null || loading}
                    >
                      {remoteLoading === "pull" ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <GitPullRequest size={14} />
                      )}
                      {t("git.pull", "Pull")}
                    </button>
                    <button
                      className="btn btn-primary btn-icon gm-pull-split-toggle"
                      onClick={() => setPullMenuOpen((open) => !open)}
                      disabled={remoteLoading !== null || loading}
                      aria-label={t("git.pullOptions", "Pull options")}
                      aria-haspopup="menu"
                      aria-expanded={pullMenuOpen}
                    >
                      <ChevronDown size={14} />
                    </button>
                    {pullMenuOpen ? (
                      <div className="gm-pull-menu" role="menu" aria-label={t("git.pullOptionsMenu", "Pull options menu")}>
                        <button
                          className="gm-pull-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setPullMenuOpen(false);
                            onPull({ rebase: false });
                          }}
                        >
                          {t("git.pull", "Pull")}
                        </button>
                        <button
                          className="gm-pull-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setPullMenuOpen(false);
                            onPull({ rebase: true });
                          }}
                        >
                          {t("git.pullRebase", "Pull --rebase")}
                        </button>
                      </div>
                    ) : null}
                  </div>
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
                    {t("git.push", "Push")}
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={onSync}
                    disabled={remoteLoading !== null || loading}
                    title={t("git.syncOriginTitle", "Pull --rebase from origin, then push current branch")}
                    data-testid="remotes-sync-origin-btn"
                  >
                    {remoteLoading === "sync" ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <GitMerge size={14} />
                    )}
                    {t("git.sync", "Sync")}
                  </button>
                  {status?.integrationBranch && (
                    <button
                      className="btn gm-sync-integration-btn"
                      onClick={onSyncIntegrationTip}
                      disabled={syncIntegrationDisabled}
                      title={
                        status.isOnIntegrationBranch === false
                          ? t("git.notOnIntegrationBranchBtn", "Not on integration branch ({{branch}})", { branch: status.integrationBranch })
                          : t("git.syncLocalTipTitle", "Sync working tree to local integration tip (same as banner Pull)")
                      }
                      data-testid="remotes-sync-integration-tip-btn"
                    >
                      {remoteLoading === "sync-integration" ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <GitMerge size={14} />
                      )}
                      {t("git.syncLocalTip", "Sync local tip")}
                    </button>
                  )}
                </div>
              </div>

              {/* Remote Detail Card */}
              <div className="gm-remote-detail-card" data-testid="remote-detail-card">
                <div className="gm-remote-detail-urls">
                  {/* Fetch URL */}
                  <div className="gm-remote-detail-url-row">
                    <span className="gm-url-label">{t("git.fetchLabel", "Fetch:")}</span>
                    {editingRemote === `url-${selectedRemote}` ? (
                      <div className="gm-remote-edit">
                        <input
                          type="text"
                          value={editUrlValue}
                          onChange={(e) => setEditUrlValue(e.target.value)}
                          className="input gm-input"
                          autoFocus
                        />
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => handleUpdateUrl(selectedRemote)}
                          disabled={remoteActionLoading === `url-${selectedRemote}`}
                        >
                          {remoteActionLoading === `url-${selectedRemote}` ? (
                            <Loader2 size={12} className="spin" />
                          ) : (
                            <Check size={12} />
                          )}
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => { setEditingRemote(null); setEditUrlValue(""); }}
                          title={t("git.cancel", "Cancel")}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="gm-url-value" title={selectedRemoteData.fetchUrl}>
                          <bdo dir="ltr">{selectedRemoteData.fetchUrl}</bdo>
                        </span>
                        <div className="gm-remote-inline-actions">
                          <button
                            className="btn btn-icon btn-sm"
                            onClick={() => copyToClipboard(selectedRemoteData.fetchUrl, t("git.fetchUrlLabel", "fetch URL"))}
                            title={t("git.copyFetchUrl", "Copy fetch URL")}
                          >
                            <Copy size={14} />
                          </button>
                          <button
                            className="btn btn-icon btn-sm"
                            onClick={() => startEditingUrl(selectedRemoteData)}
                            disabled={remoteActionLoading !== null}
                            title={t("git.editRemoteUrl", "Edit remote URL")}
                          >
                            <Pencil size={14} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Push URL */}
                  {selectedRemoteData.pushUrl && selectedRemoteData.pushUrl !== selectedRemoteData.fetchUrl && (
                    <div className="gm-remote-detail-url-row">
                      <span className="gm-url-label">{t("git.pushLabel", "Push:")}</span>
                      <span className="gm-url-value" title={selectedRemoteData.pushUrl}>
                        <bdo dir="ltr">{selectedRemoteData.pushUrl}</bdo>
                      </span>
                      <div className="gm-remote-inline-actions">
                        <button
                          className="btn btn-icon btn-sm"
                          onClick={() => copyToClipboard(selectedRemoteData.pushUrl!, t("git.pushUrlLabel", "push URL"))}
                          title={t("git.copyPushUrl", "Copy push URL")}
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Name editing */}
                <div className="gm-remote-detail-name-row">
                  {editingRemote === `name-${selectedRemote}` ? (
                    <div className="gm-remote-edit">
                      <input
                        type="text"
                        value={editNameValue}
                        onChange={(e) => setEditNameValue(e.target.value)}
                        className="input gm-input"
                        autoFocus
                      />
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => handleRenameRemote(selectedRemote)}
                        disabled={remoteActionLoading === `rename-${selectedRemote}`}
                      >
                        {remoteActionLoading === `rename-${selectedRemote}` ? (
                          <Loader2 size={12} className="spin" />
                        ) : (
                          <Check size={12} />
                        )}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => { setEditingRemote(null); setEditNameValue(""); }}
                        title={t("git.cancel", "Cancel")}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn btn-icon btn-sm"
                      onClick={() => startEditingName(selectedRemoteData)}
                      disabled={remoteActionLoading !== null}
                      title={t("git.editRemoteName", "Edit remote name")}
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                </div>
              </div>

              {/* Commits to Push Section */}
              {status && status.ahead > 0 && (
                <div className="gm-remote-section" data-testid="commits-to-push">
                  <div className="gm-section-subheader">
                    <h5>
                      <ArrowUp size={14} />
                      {t("git.commitsToPushHeader", "Commits to Push ({{count}})", { count: status.ahead })}
                    </h5>
                  </div>
                  {loadingAhead ? (
                    <div className="gm-loading">
                      <Loader2 size={14} className="spin" />
                      {t("git.loading", "Loading...")}
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
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleCompactCommitClick(commit.hash, "ahead");
                              }
                            }}
                            title={t("git.clickToViewDiff", "Click to view diff")}
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
                                  {t("git.loadingDiff", "Loading diff...")}
                                </div>
                              ) : aheadCommitDiff ? (
                                <>
                                  {(commit.body || commit.message) && (
                                    <div className="gm-commit-message-full">{commit.body || commit.message}</div>
                                  )}
                                  {aheadCommitDiff.stat && <pre className="gm-diff-stat">{aheadCommitDiff.stat}</pre>}
                                  <pre className="gm-diff-patch">{aheadCommitDiff.patch}</pre>
                                </>
                              ) : (
                                <div className="gm-diff-error">{t("git.failedToLoadDiff", "Failed to load diff")}</div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="gm-empty">
                      {t("git.noAheadCommitsFound", "No ahead commits found (may need to fetch first)")}
                    </div>
                  )}
                </div>
              )}

              {/* Recent Remote Commits Section */}
              <div className="gm-remote-section" data-testid="remote-commits-section">
                <div className="gm-section-subheader">
                  <h5>
                    <Radio size={14} />
                    {t("git.recentCommitsOnRemote", "Recent commits on {{remote}}", { remote: selectedRemote })}
                  </h5>
                </div>
                {loadingRemoteCommits ? (
                  <div className="gm-loading">
                    <Loader2 size={14} className="spin" />
                    {t("git.loadingCommits", "Loading commits...")}
                  </div>
                ) : remoteCommitsError ? (
                  <div className="gm-error">
                    <AlertCircle size={14} />
                    {remoteCommitsError}
                  </div>
                ) : remoteCommits.length === 0 ? (
                  <div className="gm-empty">
                    {t("git.noCommitsOnRemote", "No commits found on {{remote}}. Try fetching first.", { remote: selectedRemote })}
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
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleCompactCommitClick(commit.hash, "remote");
                            }
                          }}
                          title={t("git.clickToViewDiff", "Click to view diff")}
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
                                {t("git.loadingDiff", "Loading diff...")}
                              </div>
                            ) : remoteCommitDiff ? (
                              <>
                                {(commit.body || commit.message) && (
                                  <div className="gm-commit-message-full">{commit.body || commit.message}</div>
                                )}
                                {remoteCommitDiff.stat && <pre className="gm-diff-stat">{remoteCommitDiff.stat}</pre>}
                                <pre className="gm-diff-patch">{remoteCommitDiff.patch}</pre>
                              </>
                            ) : (
                              <div className="gm-diff-error">{t("git.failedToLoadDiff", "Failed to load diff")}</div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="gm-empty">
              {t("git.selectRemoteToViewDetails", "Select a remote to view details")}
            </div>
          )}

          {lastRemoteResult && (
            <div className="gm-remote-result">
              {lastRemoteResult.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
