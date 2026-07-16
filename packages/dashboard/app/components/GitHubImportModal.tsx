import "./GitHubImportModal.css";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_LOCALE, getErrorMessage, isLocale, type Locale, type Task } from "@fusion/core";
import {
  apiFetchGitHubIssues,
  apiImportGitHubIssue,
  apiFetchGitHubPulls,
  apiFetchGitHubPullDetail,
  apiFetchGitHubIssueDetail,
  apiCloseGitHubIssue,
  apiImportGitHubPull,
  apiFetchGitLabProjectIssues,
  apiFetchGitLabGroupIssues,
  apiFetchGitLabMergeRequests,
  apiImportGitLabProjectIssue,
  apiImportGitLabGroupIssue,
  apiImportGitLabMergeRequest,
  fetchSettings,
  fetchGitRemotes,
  type GitHubIssue,
  type GitHubPull,
  type GitHubPullDetail,
  type GitHubIssueDetail,
  type GitHubCommentDetail,
  type GitRemote,
  type GitLabImportItem,
} from "../api";
import { Loader2, RefreshCw, GitPullRequest, CircleDot, ChevronUp, ChevronDown, Bot, User, Filter } from "lucide-react";
import { GithubIcon } from "./GithubIcon";
import { MailboxMessageContent } from "./MailboxMessageContent";
import {
  useGitHubImportTranslation,
  useGitHubImportAutoTranslate,
} from "./GitHubImportTranslateControls";
import type { TFunction } from "i18next";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss";
import { useEmbeddedPresentation, type ModalPresentation } from "../hooks/useEmbeddedPresentation";
import { getGitHubImportState, saveGitHubImportState } from "../hooks/modalPersistence";
import { FloatingWindow } from "./FloatingWindow";

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

type TabType = "issues" | "pulls";
type ImportProvider = "github" | "gitlab";
type GitLabResourceTab = "project_issue" | "group_issue" | "merge_request";

/*
FNXC:GitHubImport 2026-06-23-03:30:
Comment-thread filter modes: DEFAULT is "all" so both human AND bot comments show. "human"/"bot" narrow the thread.
*/
type CommentFilter = "all" | "human" | "bot";

/**
 * FNXC:GitHubImport 2026-06-23-03:30:
 * Format a comment's createdAt ISO into a readable timestamp (e.g. "Jun 23, 2026, 3:15 PM") via toLocaleString.
 * Returns "" for missing/invalid timestamps so the UI can omit the label rather than render "Invalid Date".
 */
function formatCommentTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/*
FNXC:GitHubImport 2026-06-23-03:30:
Shared comment-thread renderer for BOTH the PR (.github-import-pr-comments) and Issue (.github-import-issue-comments) preview sections.
Adds, per comment: avatar (img with generic User/Bot lucide fallback on load error), author name, a readable createdAt timestamp (title = full ISO), and a human/bot badge (data-comment-author-type).
Across the thread: a top filter (All/Human/Bot, default All shows both) and prev/next chevrons that scroll to + briefly highlight the active comment (tracked via a current index that clamps to the filtered list).
The body still renders via MailboxMessageContent. Test ids: github-import-comment (per comment), github-import-comments-filter, github-import-comment-prev/-next.
*/
function CommentsThread({
  comments,
  loading,
  error,
  sectionClassName,
  sectionTestId,
  loadingTestId,
  errorTestId,
  emptyTestId,
  bodyTestId,
  t,
}: {
  comments: GitHubCommentDetail[];
  loading: boolean;
  error: string | null;
  sectionClassName: string;
  sectionTestId: string;
  loadingTestId: string;
  errorTestId: string;
  emptyTestId: string;
  bodyTestId: string;
  t: TFunction<"app">;
}) {
  const [filter, setFilter] = useState<CommentFilter>("all");
  // Index into the FILTERED list for prev/next navigation; clamped whenever the filtered list changes.
  const [activeIndex, setActiveIndex] = useState(0);
  const commentRefs = useRef<Array<HTMLLIElement | null>>([]);
  // Avatar URLs that failed to load fall back to a generic lucide icon.
  const [brokenAvatars, setBrokenAvatars] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (filter === "human") return comments.filter((c) => !c.authorIsBot);
    if (filter === "bot") return comments.filter((c) => c.authorIsBot);
    return comments;
  }, [comments, filter]);

  // Keep the active index within the filtered range as filter/data changes.
  useEffect(() => {
    setActiveIndex((current) => (filtered.length === 0 ? 0 : Math.min(current, filtered.length - 1)));
  }, [filtered.length]);

  const scrollToIndex = useCallback((index: number) => {
    const el = commentRefs.current[index];
    if (!el) return;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    // Brief highlight: add then remove a class so the destination comment flashes.
    el.classList.add("github-import-pr-comment--active");
    window.setTimeout(() => el.classList.remove("github-import-pr-comment--active"), 1200);
  }, []);

  const goPrev = useCallback(() => {
    setActiveIndex((current) => {
      const next = Math.max(0, current - 1);
      scrollToIndex(next);
      return next;
    });
  }, [scrollToIndex]);

  const goNext = useCallback(() => {
    setActiveIndex((current) => {
      const next = Math.min(filtered.length - 1, current + 1);
      scrollToIndex(next);
      return next;
    });
  }, [scrollToIndex, filtered.length]);

  const renderFilter = (
    <div className="github-import-comments-filter" data-testid="github-import-comments-filter" role="group" aria-label={t("git.filterCommentsAriaLabel", "Filter comments by author type")}>
      {(["all", "human", "bot"] as CommentFilter[]).map((mode) => (
        <button
          key={mode}
          type="button"
          className={`github-import-comments-filter__chip ${filter === mode ? "active" : ""}`}
          aria-pressed={filter === mode}
          data-filter={mode}
          onClick={() => setFilter(mode)}
        >
          {mode === "all"
            ? t("git.commentFilterAll", "All")
            : mode === "human"
              ? t("git.commentFilterHuman", "Human")
              : t("git.commentFilterBot", "Bot")}
        </button>
      ))}
    </div>
  );

  return (
    <div className={sectionClassName} data-testid={sectionTestId}>
      <div className="github-import-pr-comments__header">
        <h5 className="preview-section-heading">{t("git.commentsHeading", "Comments")}</h5>
        {/* Prev/next chevrons jump to the previous/next comment in the (filtered) thread. */}
        {filtered.length > 1 && (
          <div className="github-import-comments-nav" role="group" aria-label={t("git.commentNavAriaLabel", "Navigate comments")}>
            <button
              type="button"
              className="github-import-comments-nav__btn"
              data-testid="github-import-comment-prev"
              onClick={goPrev}
              disabled={activeIndex <= 0}
              aria-label={t("git.commentPrevAriaLabel", "Previous comment")}
              title={t("git.commentPrevAriaLabel", "Previous comment")}
            >
              <ChevronUp size={14} aria-hidden="true" />
            </button>
            <span className="github-import-comments-nav__pos" aria-live="polite">
              {t("git.commentNavPosition", "{{current}} / {{total}}", { current: activeIndex + 1, total: filtered.length })}
            </span>
            <button
              type="button"
              className="github-import-comments-nav__btn"
              data-testid="github-import-comment-next"
              onClick={goNext}
              disabled={activeIndex >= filtered.length - 1}
              aria-label={t("git.commentNextAriaLabel", "Next comment")}
              title={t("git.commentNextAriaLabel", "Next comment")}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {/* Filter is always visible (above the thread) so the user can narrow Human/Bot at any time; default All shows both. */}
      {!loading && !error && comments.length > 0 && renderFilter}
      {loading ? (
        <div className="preview-detail-loading" data-testid={loadingTestId}>
          <Loader2 size={14} className="spin" aria-hidden="true" />
          <span>{t("git.loadingComments", "Loading comments…")}</span>
        </div>
      ) : error ? (
        <div className="preview-detail-error" data-testid={errorTestId}>{error}</div>
      ) : filtered.length > 0 ? (
        <ul className="github-import-pr-comments__list">
          {filtered.map((comment, idx) => {
            const authorType = comment.authorIsBot ? "bot" : "human";
            const timestamp = formatCommentTimestamp(comment.createdAt);
            const avatarKey = `${comment.author}-${idx}`;
            const showAvatarImg = comment.authorAvatarUrl && !brokenAvatars.has(avatarKey);
            return (
              <li
                key={idx}
                ref={(el) => { commentRefs.current[idx] = el; }}
                className="github-import-pr-comment github-import-comment"
                data-testid="github-import-comment"
                data-comment-author-type={authorType}
              >
                <div className="github-import-pr-comment__meta">
                  <span className="github-import-comment__avatar" aria-hidden="true">
                    {showAvatarImg ? (
                      <img
                        src={comment.authorAvatarUrl}
                        alt={t("git.commentAvatarAlt", "{{author}} avatar", { author: comment.author })}
                        className="github-import-comment__avatar-img"
                        onError={() => setBrokenAvatars((prev) => new Set(prev).add(avatarKey))}
                      />
                    ) : comment.authorIsBot ? (
                      <Bot size={16} aria-hidden="true" />
                    ) : (
                      <User size={16} aria-hidden="true" />
                    )}
                  </span>
                  <span className="github-import-pr-comment__author">{comment.author}</span>
                  <span className={`github-import-comment__type-badge github-import-comment__type-badge--${authorType}`}>
                    {comment.authorIsBot ? <Bot size={11} aria-hidden="true" /> : <User size={11} aria-hidden="true" />}
                    <span>{comment.authorIsBot ? t("git.commentBot", "Bot") : t("git.commentHuman", "Human")}</span>
                  </span>
                  {timestamp && (
                    <time className="github-import-comment__time" dateTime={comment.createdAt} title={comment.createdAt}>
                      {timestamp}
                    </time>
                  )}
                </div>
                <MailboxMessageContent
                  className="github-import-pr-comment__body preview-body--markdown"
                  content={comment.body || t("git.noCommentBody", "(empty comment)")}
                  testId={bodyTestId}
                />
              </li>
            );
          })}
        </ul>
      ) : comments.length > 0 ? (
        /* All comments filtered out by the current Human/Bot filter. */
        <div className="preview-detail-empty" data-testid={emptyTestId}>{t("git.noCommentsForFilter", "No comments match the filter")}</div>
      ) : (
        <div className="preview-detail-empty" data-testid={emptyTestId}>{t("git.noComments", "No comments")}</div>
      )}
    </div>
  );
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
  const { t, i18n } = useTranslation("app");
  /*
  FNXC:GitHubImportTranslate 2026-07-14-12:00:
  Translation target is the active dashboard locale (i18n.resolvedLanguage). When content is another language, the preview offers Translate / Show original / Dismiss.
  */
  const dashboardLocale: Locale = isLocale(i18n.resolvedLanguage ?? i18n.language)
    ? (i18n.resolvedLanguage ?? i18n.language) as Locale
    : DEFAULT_LOCALE;

  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Auto-translate is off by default, so the panel reads the project setting before translating anything. `importTranslateTargetLocale` overrides the dashboard locale when the operator wants issues in a language other than the one the UI is rendered in; unset means "follow the dashboard language".
  The server re-checks the same setting, so a stale value here can never cause an unwanted model call — this fetch drives the UI only.
  */
  const [autoTranslateEnabled, setAutoTranslateEnabled] = useState(false);
  const [translateLocaleSetting, setTranslateLocaleSetting] = useState<Locale | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetchSettings(projectId)
      .then((settings) => {
        if (cancelled) return;
        setAutoTranslateEnabled(settings.githubImportAutoTranslate === true);
        setTranslateLocaleSetting(
          isLocale(settings.importTranslateTargetLocale)
            ? settings.importTranslateTargetLocale
            : null,
        );
      })
      .catch(() => {
        // Settings unavailable: stay on the safe default (no auto-translation).
        if (!cancelled) setAutoTranslateEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId]);

  const translateTargetLocale: Locale = translateLocaleSetting ?? dashboardLocale;
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [labels, setLabels] = useState("");
  /*
  FNXC:GitHubImport 2026-07-15-23:20:
  The labels filter collapses into a popover so the control row stays one line and the issue list
  keeps the vertical space. `filterOpen` drives the popover; the trigger summarises the active
  filter so a collapsed filter is never invisible state.
  */
  const [filterOpen, setFilterOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);

  /*
  FNXC:GitHubImport 2026-07-15-23:20:
  Dismiss the filter popover on outside pointerdown or Escape. Bound only while open so the modal
  does not carry idle global listeners. Escape stops propagation: the popover is the innermost
  dismissible layer, and without this the modal itself would close on the same key.
  */
  useEffect(() => {
    if (!filterOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setFilterOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [filterOpen]);
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<ImportProvider>("github");
  const [gitlabResource, setGitlabResource] = useState<GitLabResourceTab>("project_issue");
  const [gitlabProject, setGitlabProject] = useState("");
  const [gitlabGroup, setGitlabGroup] = useState("");
  const [gitlabItems, setGitlabItems] = useState<GitLabImportItem[]>([]);
  const [selectedGitlabKey, setSelectedGitlabKey] = useState<string | null>(null);
  const [gitlabEnabled, setGitlabEnabled] = useState(true);
  const [gitlabSettingsLoaded, setGitlabSettingsLoaded] = useState(false);

  // Tab state
  const [activeTab, setActiveTab] = useState<TabType>("issues");

  // Issues state
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(null);

  // Pulls state
  const [pulls, setPulls] = useState<GitHubPull[]>([]);
  const [selectedPullNumber, setSelectedPullNumber] = useState<number | null>(null);

  /*
  FNXC:GitHubImport 2026-06-23-01:00:
  The PR preview pane shows the full comment thread + per-check status for the SELECTED PR only.
  `gh pr list` returns just comment COUNT + no per-check detail, so the full thread/checks are fetched ON SELECTION via apiFetchGitHubPullDetail — never for the whole list (too expensive).
  Detail is cached by PR number in a ref so re-selecting a PR does not refetch; the body renders immediately while checks/comments stream in (loading/error tracked separately, never blocking the body).
  */
  const pullDetailCacheRef = useRef<Map<number, GitHubPullDetail>>(new Map());
  const [pullDetail, setPullDetail] = useState<GitHubPullDetail | null>(null);
  const [pullDetailLoading, setPullDetailLoading] = useState(false);
  const [pullDetailError, setPullDetailError] = useState<string | null>(null);
  // Guards against a stale in-flight detail response overwriting a newer selection.
  const pullDetailRequestRef = useRef(0);

  /*
  FNXC:GitHubImport 2026-06-23-03:15:
  The issue preview pane mirrors the PR preview: the SELECTED issue's full comment thread is fetched ON SELECTION (issues have no checks rollup, so comments only).
  Cached by issue number in a ref so re-selecting does not refetch; the body renders immediately while comments stream in (loading/error tracked separately, never blocking the body).
  */
  const issueDetailCacheRef = useRef<Map<number, GitHubIssueDetail>>(new Map());
  const [issueDetail, setIssueDetail] = useState<GitHubIssueDetail | null>(null);
  const [issueDetailLoading, setIssueDetailLoading] = useState(false);
  const [issueDetailError, setIssueDetailError] = useState<string | null>(null);
  // Guards against a stale in-flight issue-detail response overwriting a newer selection.
  const issueDetailRequestRef = useRef(0);

  /*
  FNXC:GitHubImport 2026-06-23-03:15:
  Close-issue UX: clicking "Close issue" calls apiCloseGitHubIssue, then reflects the closed state locally (closedIssueNumbers set) WITHOUT dismissing the view.
  A transient inline toast confirms success/failure (the modal has no toast prop). Only OPEN issues show the button; closing disables it and flips the local state badge to closed.
  */
  const [closedIssueNumbers, setClosedIssueNumbers] = useState<Set<number>>(new Set());
  const [closingIssue, setClosingIssue] = useState(false);
  const [closeToast, setCloseToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const closeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [isIssuesEmptyState, setIsIssuesEmptyState] = useState(false);
  const [isPullsEmptyState, setIsPullsEmptyState] = useState(false);
  const [importing, setImporting] = useState(false);

  // Git remotes state
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [loadingRemotes, setLoadingRemotes] = useState(false);
  const [selectedRemoteName, setSelectedRemoteName] = useState<string>("");
  const mountedRef = useRef(false);
  const remoteLoadRequestIdRef = useRef(0);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalResizePersist(modalRef, isOpen && resizePersistEnabled, "fusion:github-modal-size");
  const overlayDismissProps = useOverlayDismiss(onClose);

  // Track which owner/repo we've already auto-loaded to prevent duplicate loads
  const autoLoadedRef = useRef<{ owner: string; repo: string; labels: string; tab: TabType } | null>(null);

  /*
  FNXC:GitHubImport 2026-07-07-00:00:
  Restored selections (issue/pull/GitLab) must not be applied until the reloaded list actually contains them, otherwise a
  stale selection would either render a dead preview or (worse) silently point at the wrong item. `handleLoad`/
  `handleLoadPulls`/`handleLoadGitLab` all clear the selection at the START of a fetch (existing behavior for user-triggered
  reloads), so the hydrated-on-mount selection is parked here and only re-applied once the corresponding fetch resolves AND
  the item is still present in the reloaded list; otherwise it is silently dropped (graceful degrade, no stuck/empty preview).
  */
  const pendingRestoreSelectionRef = useRef<{ issueNumber: number | null; pullNumber: number | null; gitlabKey: string | null }>({
    issueNumber: null,
    pullNumber: null,
    gitlabKey: null,
  });
  // Set true during mount hydration when the persisted provider is GitLab with enough input to load; consumed by a
  // one-shot effect below once gitlabProject/gitlabGroup state actually reflects the hydrated values.
  const needsGitlabAutoLoadRef = useRef(false);
  // Gates the persist-on-change effect until the mount hydration effect has applied its (possibly restored) values to
  // state, so the FIRST commit's still-default state is never written over a real persisted value.
  const [readyToPersistImportState, setReadyToPersistImportState] = useState(false);
  const [hideImported, setHideImported] = useState(false);

  /*
  FNXC:GitHubImport 2026-07-15-16:30:
  The Hide imported control is a view-only filter over already-imported candidates. Persist it per project with the other
  cheap Import Tasks preferences so navigation preserves the operator's decluttering choice without retaining fetched lists.
  */

  /*
  FNXC:GitHubImport 2026-07-15-15:30:
  A just-imported source must immediately display as imported without waiting for the parent `tasks` prop round-trip.
  Keep local optimistic URLs unioned with, never replacing, the tasks-derived URLs; reset and import-source effects clear
  the local set when its source context is no longer valid.
  */
  const [optimisticImportedUrls, setOptimisticImportedUrls] = useState<Set<string>>(new Set());

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
    const gitlabMatch = task.description.match(/Source: (https?:\/\/[^\s]+\/-(?:\/issues|\/merge_requests)\/\d+)/);
    if (gitlabMatch) {
      importedUrls.add(gitlabMatch[1]);
    }
  }

  const isUrlImported = useCallback((url?: string | null) => {
    if (!url) return false;
    return importedUrls.has(url) || optimisticImportedUrls.has(url);
  }, [importedUrls, optimisticImportedUrls]);

  /*
  FNXC:GitHubImport 2026-07-07-00:00:
  Retain-state-on-exit-and-return (FN-7657): the embedded Import Tasks view fully unmounts on navigation away and remounts
  fresh on return, so this "reset on open" effect must HYDRATE persisted per-project state instead of hard-resetting it when
  a prior value exists, and fall back to the exact previous reset/default-remote-auto-detect behavior when nothing is
  persisted (first-time opens keep their existing UX unchanged). Only the cheap, restorable fields are hydrated here
  (provider/tab/labels/remote/owner/repo/GitLab inputs/selection) — fetched issue/pull/GitLab lists, loading flags, and
  detail caches are ALWAYS reset and re-derived via the existing auto-load, never persisted.

  Decision: the modal presentation (`AppModals.tsx`, mobile overflow path) shares this same effect/state and therefore
  ALSO restores persisted state on open rather than starting fresh — keeping the two presentations coherent, since both
  read/write the same per-project storage key and a user may open either one first. Modal open/close otherwise behaves
  exactly as before (Cancel/close still unmount-discards in-memory-only state such as the fetched lists/loading flags).
  */
  useEffect(() => {
    if (isOpen) {
      setReadyToPersistImportState(false);
      const persisted = getGitHubImportState(projectId);

      /*
      FNXC:GitHubImport 2026-07-07-00:00:
      owner/repo/selectedRemoteName are intentionally NOT hydrated synchronously here (unlike the other fields) — doing so
      would populate them before the remote-detection fetch below resolves, which flips the auto-load effect on
      immediately (synchronously, within the same mount commit) instead of after the async remote fetch as before. That
      earlier timing can disable the tab buttons (loading=true) before a user's next interaction lands. They are applied
      instead inside the fetchGitRemotes().then() below, preserving the original async timing while still taking
      precedence over the default-remote auto-detect once remotes are known.
      */
      setOwner("");
      setRepo("");
      setLabels(persisted?.labels ?? "");
      setHideImported(persisted?.hideImported ?? false);
      setProvider(persisted?.provider ?? "github");
      setGitlabResource(persisted?.gitlabResource ?? "project_issue");
      setGitlabProject(persisted?.gitlabProject ?? "");
      setGitlabGroup(persisted?.gitlabGroup ?? "");
      setGitlabItems([]);
      setSelectedGitlabKey(null);
      setOptimisticImportedUrls(new Set());
      setIssues([]);
      setSelectedIssueNumber(null);
      setPulls([]);
      setSelectedPullNumber(null);
      setActiveTab(persisted?.activeTab ?? "issues");
      setError(null);
      setIsIssuesEmptyState(false);
      setIsPullsEmptyState(false);
      setImporting(false);
      setRemotes([]);
      setLoadingRemotes(true);
      setSelectedRemoteName("");
      autoLoadedRef.current = null;

      // Stash the restored selections; they are re-applied once the corresponding reload resolves and confirms the item
      // is still present (see handleLoad/handleLoadPulls/handleLoadGitLab), never applied blindly.
      pendingRestoreSelectionRef.current = {
        issueNumber: persisted?.selectedIssueNumber ?? null,
        pullNumber: persisted?.selectedPullNumber ?? null,
        gitlabKey: persisted?.selectedGitlabKey ?? null,
      };
      needsGitlabAutoLoadRef.current =
        persisted?.provider === "gitlab" &&
        (persisted.gitlabResource === "group_issue" ? Boolean(persisted.gitlabGroup) : Boolean(persisted.gitlabProject));

      // Applying the hydrated (possibly-empty) values above completes the synchronous portion of hydration; flipping this
      // now lets the persist-on-change effect start writing from the NEXT render, which already reflects these values —
      // never the pre-hydration defaults from this render's initial mount.
      setReadyToPersistImportState(true);

      mountedRef.current = true;
      const remoteLoadRequestId = remoteLoadRequestIdRef.current + 1;
      remoteLoadRequestIdRef.current = remoteLoadRequestId;
      let cancelled = false;

      /*
      FNXC:GitHubImport 2026-06-22-09:08:
      Import from GitHub must detect remotes for the active project, not the dashboard process fallback.
      The remotes API returns an empty list without projectId in multi-project mode, which incorrectly shows "No GitHub remotes detected" for configured repositories.

      FNXC:GitHubImport 2026-06-22-09:22:
      Project changes can happen while the modal stays open, so remote discovery must ignore stale responses from earlier projectId requests.
      A mounted-only guard is insufficient because the next effect marks the component mounted again before the older request resolves.
      */
      fetchGitRemotes(projectId)
        .then((fetchedRemotes) => {
          if (cancelled || !mountedRef.current || remoteLoadRequestId !== remoteLoadRequestIdRef.current) return;

          setRemotes(fetchedRemotes);
          setLoadingRemotes(false);

          // Hydrated remote/owner/repo take precedence when the named remote still exists in the freshly detected list.
          const hydratedRemoteName = persisted?.selectedRemoteName;
          const hydratedRemote = hydratedRemoteName
            ? fetchedRemotes.find((remote) => remote.name === hydratedRemoteName)
            : undefined;

          if (hydratedRemote) {
            setOwner(hydratedRemote.owner);
            setRepo(hydratedRemote.repo);
            setSelectedRemoteName(hydratedRemote.name);
          } else if (persisted?.owner && persisted?.repo) {
            // Persisted owner/repo survive even without a matching named remote (e.g. remote renamed/removed).
            setOwner(persisted.owner);
            setRepo(persisted.repo);
            setSelectedRemoteName(persisted.selectedRemoteName ?? "");
          } else {
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
          }
        })
        .catch(() => {
          if (!cancelled && mountedRef.current && remoteLoadRequestId === remoteLoadRequestIdRef.current) {
            setLoadingRemotes(false);
          }
        });

      return () => {
        cancelled = true;
        mountedRef.current = false;
      };
    }
  }, [isOpen, projectId]);

  /*
  FNXC:GitHubImport 2026-07-15-15:30:
  Optimistic URLs are meaningful only for their current import source. Changing provider, GitHub owner/repo, or a GitLab
  project/group/resource re-scopes the list, so discard them; omit activeTab so same-source Issues/Pull Requests switches
  retain an optimistic mark.
  */
  useEffect(() => {
    setOptimisticImportedUrls(new Set());
  }, [provider, owner, repo, gitlabProject, gitlabGroup, gitlabResource]);

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
      // FNXC:GitHubImport 2026-07-07-00:00: Re-apply a hydrated-on-mount selection only if it survived the reload; otherwise drop it silently (already null from the reset above).
      const restoreIssueNumber = pendingRestoreSelectionRef.current.issueNumber;
      if (restoreIssueNumber !== null) {
        pendingRestoreSelectionRef.current.issueNumber = null;
        if (fetchedIssues.some((issue) => issue.number === restoreIssueNumber)) {
          setSelectedIssueNumber(restoreIssueNumber);
        }
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
      // FNXC:GitHubImport 2026-07-07-00:00: Re-apply a hydrated-on-mount selection only if it survived the reload; otherwise drop it silently (already null from the reset above).
      const restorePullNumber = pendingRestoreSelectionRef.current.pullNumber;
      if (restorePullNumber !== null) {
        pendingRestoreSelectionRef.current.pullNumber = null;
        if (fetchedPulls.some((pull) => pull.number === restorePullNumber)) {
          setSelectedPullNumber(restorePullNumber);
        }
      }
    } catch (err) {
      setError(getErrorMessage(err) || t("git.failedToFetchPulls", "Failed to fetch pull requests"));
    } finally {
      setLoading(false);
    }
  }, [owner, repo]);


  useEffect(() => {
    let cancelled = false;
    if (!isOpen) return () => { cancelled = true; };
    setGitlabSettingsLoaded(false);
    fetchSettings(projectId, { forceFresh: true })
      .then((settings) => {
        if (cancelled) return;
        const resolvedGitlabEnabled = settings.gitlabEnabled !== false;
        setGitlabEnabled(resolvedGitlabEnabled);
        setGitlabSettingsLoaded(true);
        if (!resolvedGitlabEnabled) {
          setProvider("github");
          setGitlabItems([]);
          setSelectedGitlabKey(null);
          pendingRestoreSelectionRef.current.gitlabKey = null;
          needsGitlabAutoLoadRef.current = false;
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitlabEnabled(true);
          setGitlabSettingsLoaded(true);
        }
      });
    return () => { cancelled = true; };
  }, [isOpen, projectId]);

  const selectedGitlabItem = gitlabItems.find((item) => `${item.resourceKind}:${item.projectId ?? item.projectPath ?? ""}:${item.iid}` === selectedGitlabKey) ?? null;

  const handleLoadGitLab = useCallback(async () => {
    if (!gitlabEnabled) {
      setError(t("git.gitlabDisabled", "GitLab integration is disabled in Settings. Enable it to fetch or import GitLab resources; saved configuration is preserved."));
      return;
    }
    const project = gitlabProject.trim();
    const group = gitlabGroup.trim();
    if ((gitlabResource === "project_issue" || gitlabResource === "merge_request") && !project) {
      setError(t("git.gitlabProjectRequired", "GitLab project path or ID is required"));
      return;
    }
    if (gitlabResource === "group_issue" && !group) {
      setError(t("git.gitlabGroupRequired", "GitLab group path or ID is required"));
      return;
    }
    setLoading(true);
    setError(null);
    setGitlabItems([]);
    setSelectedGitlabKey(null);
    try {
      const labelArray = labels.split(",").map((label) => label.trim()).filter(Boolean);
      const fetched = gitlabResource === "project_issue"
        ? await apiFetchGitLabProjectIssues(project, 30, labelArray.length > 0 ? labelArray : undefined)
        : gitlabResource === "group_issue"
          ? await apiFetchGitLabGroupIssues(group, 30, labelArray.length > 0 ? labelArray : undefined)
          : await apiFetchGitLabMergeRequests(project, 30, labelArray.length > 0 ? labelArray : undefined);
      setGitlabItems(fetched);
      if (fetched.length === 0) setIsIssuesEmptyState(true);
      // FNXC:GitHubImport 2026-07-07-00:00: Re-apply a hydrated-on-mount GitLab selection only if it survived the reload; otherwise drop it silently (already null from the reset above).
      const restoreGitlabKey = pendingRestoreSelectionRef.current.gitlabKey;
      if (restoreGitlabKey !== null) {
        pendingRestoreSelectionRef.current.gitlabKey = null;
        if (fetched.some((item) => `${item.resourceKind}:${item.projectId ?? item.projectPath ?? ""}:${item.iid}` === restoreGitlabKey)) {
          setSelectedGitlabKey(restoreGitlabKey);
        }
      }
    } catch (err) {
      setError(getErrorMessage(err) || t("git.failedToFetchGitlab", "Failed to fetch GitLab resources"));
    } finally {
      setLoading(false);
    }
  }, [gitlabEnabled, gitlabProject, gitlabGroup, gitlabResource, labels, t]);

  const handleImportGitLab = useCallback(async () => {
    if (!selectedGitlabItem || !gitlabEnabled) return;
    setImporting(true);
    setError(null);
    try {
      const task = gitlabResource === "project_issue"
        ? await apiImportGitLabProjectIssue(gitlabProject.trim(), selectedGitlabItem.iid, projectId)
        : gitlabResource === "group_issue"
          ? await apiImportGitLabGroupIssue(selectedGitlabItem, gitlabGroup.trim(), projectId)
          : await apiImportGitLabMergeRequest(gitlabProject.trim(), selectedGitlabItem.iid, projectId);
      onImport(task);
      if (selectedGitlabItem.webUrl) {
        setOptimisticImportedUrls((previous) => new Set(previous).add(selectedGitlabItem.webUrl));
      }
      setSelectedGitlabKey(null);
    } catch (err) {
      setError(getErrorMessage(err) || t("git.failedToImportGitlab", "Failed to import GitLab resource"));
    } finally {
      setImporting(false);
    }
  }, [selectedGitlabItem, gitlabEnabled, gitlabResource, gitlabProject, gitlabGroup, projectId, onImport, t]);

  /*
  FNXC:GitHubImport 2026-07-07-00:00:
  Mirrors the GitHub auto-load effect below for GitLab: on mount hydration with a persisted GitLab provider + enough input
  (project for project_issue/merge_request, group for group_issue), trigger exactly one auto-load so the restored
  selection has a list to be validated/re-applied against (see handleLoadGitLab). One-shot via the ref flag so manual
  reloads/tab switches never re-trigger this.

  FNXC:GitLabImportVisibility 2026-07-15-00:00:
  FN-7971 changed disabled GitLab from visible-but-disabled to hidden. Wait for effective settings before replaying a persisted GitLab auto-load so `gitlabEnabled === false` can coerce the provider back to GitHub without firing a GitLab request.
  */
  useEffect(() => {
    if (!needsGitlabAutoLoadRef.current) return;
    if (!gitlabSettingsLoaded || !gitlabEnabled) return;
    if (provider !== "gitlab") return;
    const ready = gitlabResource === "group_issue" ? Boolean(gitlabGroup.trim()) : Boolean(gitlabProject.trim());
    if (!ready) return;
    needsGitlabAutoLoadRef.current = false;
    handleLoadGitLab();
  }, [provider, gitlabSettingsLoaded, gitlabEnabled, gitlabResource, gitlabProject, gitlabGroup, handleLoadGitLab]);

  /*
  FNXC:GitHubImport 2026-07-07-00:00:
  Persist the cheap/restorable import-state fields per-project whenever any of them change, so leaving and returning to
  the embedded view resumes the user's prior context. Gated on readyToPersistImportState so the FIRST commit after mount
  (still holding pre-hydration defaults) never overwrites a real persisted value; the mount-hydration effect above flips
  this flag only after applying the (possibly restored) values to state.
  */
  useEffect(() => {
    if (!readyToPersistImportState) return;
    saveGitHubImportState(
      {
        provider,
        activeTab,
        labels,
        selectedRemoteName,
        owner,
        repo,
        gitlabResource,
        gitlabProject,
        gitlabGroup,
        selectedIssueNumber,
        selectedPullNumber,
        selectedGitlabKey,
        hideImported,
      },
      projectId,
    );
  }, [
    readyToPersistImportState,
    provider,
    activeTab,
    labels,
    selectedRemoteName,
    owner,
    repo,
    gitlabResource,
    gitlabProject,
    gitlabGroup,
    selectedIssueNumber,
    selectedPullNumber,
    selectedGitlabKey,
    hideImported,
    projectId,
  ]);

  // Auto-load data when owner and repo are set and valid
  useEffect(() => {
    if (provider !== "github") return;
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
  }, [provider, owner, repo, labels, activeTab, isOpen, loading, importing, handleLoad, handleLoadPulls]);

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

  const handleIssueSelect = useCallback((issueNumber: number) => {
    setSelectedIssueNumber(issueNumber);
  }, []);

  const handlePullSelect = useCallback((pullNumber: number) => {
    setSelectedPullNumber(pullNumber);
  }, []);

  /**
   * FNXC:GitHubImport 2026-07-02-00:00:
   * Successful GitHub issue import/close actions must return users to the main issue list instead of leaving a completed issue's preview, action buttons, or selected radio active.
   * Failures intentionally do not call this helper so the selected preview remains available for retry with the existing error affordance.
   */
  const returnToIssueListAfterSuccess = useCallback(() => {
    setSelectedIssueNumber(null);
  }, []);

  const handleImport = useCallback(async () => {
    if (activeTab === "issues") {
      if (selectedIssueNumber === null) return;
      const importedIssueUrl = issues.find((issue) => issue.number === selectedIssueNumber)?.html_url;

      setImporting(true);
      setError(null);

      try {
        /*
        FNXC:GitHubImportTranslate 2026-07-15-14:10:
        Forward the panel's ACTIVE target locale so the imported task carries the translation shown in the preview. The server also falls back to the global `language` setting; this covers the case it cannot know — a browser-detected locale while global `language` is unset (PR #2141 review, P1).
        */
        const task = await apiImportGitHubIssue(
          owner.trim(),
          repo.trim(),
          selectedIssueNumber,
          projectId,
          translateTargetLocale,
        );
        onImport(task);
        if (importedIssueUrl) {
          setOptimisticImportedUrls((previous) => new Set(previous).add(importedIssueUrl));
        }
        returnToIssueListAfterSuccess();
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
      const importedPullUrl = pulls.find((pull) => pull.number === selectedPullNumber)?.html_url;

      setImporting(true);
      setError(null);

      try {
        const task = await apiImportGitHubPull(owner.trim(), repo.trim(), selectedPullNumber, projectId);
        onImport(task);
        if (importedPullUrl) {
          setOptimisticImportedUrls((previous) => new Set(previous).add(importedPullUrl));
        }
        setSelectedPullNumber(null);
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
  }, [activeTab, selectedIssueNumber, selectedPullNumber, issues, pulls, owner, repo, projectId, onImport, returnToIssueListAfterSuccess]);

  /*
  FNXC:GitHubImport 2026-06-23-01:00:
  Fetch the selected PR's detail (comments + checks) on selection. Serves from the per-number cache on re-select; otherwise fetches and caches.
  Body render is never blocked on this — the body shows immediately and checks/comments populate when this resolves.
  */
  useEffect(() => {
    if (activeTab !== "pulls" || selectedPullNumber === null || !owner.trim() || !repo.trim()) {
      setPullDetail(null);
      setPullDetailLoading(false);
      setPullDetailError(null);
      return;
    }

    const cached = pullDetailCacheRef.current.get(selectedPullNumber);
    if (cached) {
      setPullDetail(cached);
      setPullDetailLoading(false);
      setPullDetailError(null);
      return;
    }

    const requestId = ++pullDetailRequestRef.current;
    setPullDetail(null);
    setPullDetailLoading(true);
    setPullDetailError(null);

    apiFetchGitHubPullDetail(`${owner.trim()}/${repo.trim()}`, selectedPullNumber)
      .then((detail) => {
        pullDetailCacheRef.current.set(selectedPullNumber, detail);
        if (pullDetailRequestRef.current !== requestId) return;
        setPullDetail(detail);
        setPullDetailLoading(false);
      })
      .catch((err: unknown) => {
        if (pullDetailRequestRef.current !== requestId) return;
        setPullDetailError(getErrorMessage(err));
        setPullDetailLoading(false);
      });
  }, [activeTab, selectedPullNumber, owner, repo]);

  /*
  FNXC:GitHubImport 2026-06-23-03:15:
  Fetch the selected issue's comments on selection. Serves from the per-number cache on re-select; otherwise fetches and caches.
  Body render is never blocked on this — the body shows immediately and comments populate when this resolves. Mirrors the PR detail effect.
  */
  useEffect(() => {
    if (activeTab !== "issues" || selectedIssueNumber === null || !owner.trim() || !repo.trim()) {
      setIssueDetail(null);
      setIssueDetailLoading(false);
      setIssueDetailError(null);
      return;
    }

    const cached = issueDetailCacheRef.current.get(selectedIssueNumber);
    if (cached) {
      setIssueDetail(cached);
      setIssueDetailLoading(false);
      setIssueDetailError(null);
      return;
    }

    const requestId = ++issueDetailRequestRef.current;
    setIssueDetail(null);
    setIssueDetailLoading(true);
    setIssueDetailError(null);

    apiFetchGitHubIssueDetail(`${owner.trim()}/${repo.trim()}`, selectedIssueNumber)
      .then((detail) => {
        issueDetailCacheRef.current.set(selectedIssueNumber, detail);
        if (issueDetailRequestRef.current !== requestId) return;
        setIssueDetail(detail);
        setIssueDetailLoading(false);
      })
      .catch((err: unknown) => {
        if (issueDetailRequestRef.current !== requestId) return;
        setIssueDetailError(getErrorMessage(err));
        setIssueDetailLoading(false);
      });
  }, [activeTab, selectedIssueNumber, owner, repo]);

  // FNXC:GitHubImport 2026-06-23-03:15: Clear the transient close toast timer on unmount.
  useEffect(() => () => {
    if (closeToastTimerRef.current) clearTimeout(closeToastTimerRef.current);
  }, []);

  /*
  FNXC:GitHubImport 2026-07-15-17:10:
  Closing an issue keeps its FloatingWindow open through the success toast so the confirmation is visible and the locally closed state can replace the Close action. The full-width list remains behind the draggable/resizable detail window.
  */
  const handleCloseIssue = useCallback(async () => {
    if (selectedIssueNumber === null || !owner.trim() || !repo.trim()) return;
    const issueNumber = selectedIssueNumber;
    setClosingIssue(true);
    if (closeToastTimerRef.current) clearTimeout(closeToastTimerRef.current);
    setCloseToast(null);
    try {
      await apiCloseGitHubIssue(`${owner.trim()}/${repo.trim()}`, issueNumber);
      setClosedIssueNumbers((prev) => {
        const next = new Set(prev);
        next.add(issueNumber);
        return next;
      });
      setCloseToast({ type: "success", message: t("git.issueClosedToast", "Issue #{{number}} closed", { number: issueNumber }) });
    } catch (err: unknown) {
      setCloseToast({ type: "error", message: getErrorMessage(err) });
    } finally {
      setClosingIssue(false);
      closeToastTimerRef.current = setTimeout(() => setCloseToast(null), 4000);
    }
  }, [selectedIssueNumber, owner, repo, t]);

  const selectedIssue = issues.find((i) => i.number === selectedIssueNumber);
  const selectedPull = pulls.find((p) => p.number === selectedPullNumber);
  /*
  FNXC:GitHubImport 2026-06-23-03:15:
  An issue counts as closed if the upstream state is closed OR we closed it locally this session. Only OPEN issues show the Close button.
  */
  const selectedIssueClosed =
    !!selectedIssue && (selectedIssue.state === "closed" || closedIssueNumbers.has(selectedIssue.number));

  /*
  FNXC:GitHubImportTranslate 2026-07-14-12:00:
  One translation hook covers GitHub issues, GitHub PRs, and GitLab selections. selectionKey isolates cache/dismiss state so switching items does not show the wrong translation.
  */
  const translateSelection = useMemo(() => {
    if (provider === "gitlab" && selectedGitlabItem) {
      return {
        key: `gitlab:${selectedGitlabKey ?? ""}`,
        title: selectedGitlabItem.title ?? "",
        body: selectedGitlabItem.description ?? "",
      };
    }
    if (provider === "github" && activeTab === "issues" && selectedIssue) {
      return {
        key: `issue:${selectedIssue.number}`,
        title: selectedIssue.title ?? "",
        body: selectedIssue.body ?? "",
      };
    }
    if (provider === "github" && activeTab === "pulls" && selectedPull) {
      return {
        key: `pull:${selectedPull.number}`,
        title: selectedPull.title ?? "",
        body: selectedPull.body ?? "",
      };
    }
    return { key: null as string | null, title: "", body: "" };
  }, [provider, selectedGitlabItem, selectedGitlabKey, activeTab, selectedIssue, selectedPull]);

  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Requirement (2026-07-15): when auto-translate is on, translate foreign-language issues BEFORE showing them — so the list titles, not just the preview, read in the operator's language.
  The 50-most-recent-open cap and the setting itself are enforced server-side; this only supplies the visible issue set and consumes the result.
  */
  const autoTranslate = useGitHubImportAutoTranslate({
    enabled: autoTranslateEnabled && provider === "github" && activeTab === "issues",
    owner: owner.trim(),
    repo: repo.trim(),
    items: issues,
    targetLocale: translateTargetLocale,
    projectId,
  });

  const selectedAutoTranslation =
    provider === "github" && activeTab === "issues" && selectedIssue
      ? autoTranslate.translations.get(selectedIssue.number) ?? null
      : null;

  const importTranslation = useGitHubImportTranslation({
    selectionKey: translateSelection.key,
    title: translateSelection.title,
    body: translateSelection.body,
    dashboardLocale: translateTargetLocale,
    projectId,
    autoTranslation: selectedAutoTranslation,
    autoTranslateEnabled,
  });

  useEffect(() => {
    if (!hideImported) return;
    if (selectedIssue && isUrlImported(selectedIssue.html_url)) setSelectedIssueNumber(null);
    if (selectedPull && isUrlImported(selectedPull.html_url)) setSelectedPullNumber(null);
    if (selectedGitlabItem && isUrlImported(selectedGitlabItem.webUrl)) setSelectedGitlabKey(null);
  }, [hideImported, selectedIssue, selectedPull, selectedGitlabItem, isUrlImported]);

  if (!isOpen) return null;

  // Determine state flags
  const hasRemotes = remotes.length > 0;
  const singleRemote = remotes.length === 1;

  // Tab-specific counts
  const importedIssueCount = issues.filter((issue) => isUrlImported(issue.html_url)).length;
  const importedPullCount = pulls.filter((pull) => isUrlImported(pull.html_url)).length;
  /*
  FNXC:GitHubImport 2026-07-15-16:30:
  Hide imported removes imported rows from every provider's render set, while toggle-off preserves the original arrays and
  imported counts always use the full fetched sets. Use `isUrlImported` so optimistic imports also disappear immediately.
  */
  const visibleIssues = hideImported ? issues.filter((issue) => !isUrlImported(issue.html_url)) : issues;
  const visiblePulls = hideImported ? pulls.filter((pull) => !isUrlImported(pull.html_url)) : pulls;
  const visibleGitlabItems = hideImported ? gitlabItems.filter((item) => !isUrlImported(item.webUrl)) : gitlabItems;
  const allIssuesHidden = hideImported && issues.length > 0 && visibleIssues.length === 0;
  const allPullsHidden = hideImported && pulls.length > 0 && visiblePulls.length === 0;
  const allGitlabItemsHidden = hideImported && gitlabItems.length > 0 && visibleGitlabItems.length === 0;

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
          {/*
          FNXC:GitHubImport 2026-07-15-23:20:
          Mobile operator report: the import screen spent most of its vertical budget on chrome —
          provider row, tab row, and a boxed origin+filter+Load stack — leaving only a few issues
          visible. Provider, type tabs, origin, filter, and Load now share ONE control row so the
          issue list gets the reclaimed space. The row wraps on narrow widths rather than clipping.
          Origin stays VISIBLE as a compact chip (operator decision) — it is load-bearing context for
          what you are about to import, so it must not hide inside the filter popover.
          */}
          <div className="github-import-controls" data-testid="github-import-controls">
          <div className="github-import-provider" role="group" aria-label={t("git.providerAriaLabel", "Import provider")}>
            <button type="button" className={`github-import-tab ${provider === "github" ? "active" : ""}`} aria-pressed={provider === "github"} onClick={() => setProvider("github")} disabled={loading || importing}>GitHub</button>
            {gitlabEnabled ? <button type="button" className={`github-import-tab ${provider === "gitlab" ? "active" : ""}`} aria-pressed={provider === "gitlab"} onClick={() => setProvider("gitlab")} disabled={loading || importing}>GitLab</button> : null}
          </div>
          {provider === "github" && (<>
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
                /*
                FNXC:GitHubImport 2026-07-15-23:20:
                The always-open filter input cost a full row for a control most imports never touch.
                It is now a popover. The trigger doubles as the filter's readout — it shows the active
                labels instead of the word "Filter" — so collapsing never hides applied state, and it
                carries an `is-active` class for a visual cue.
                */
                <div className="github-import-filter-menu" ref={filterMenuRef}>
                  <button
                    type="button"
                    className={`btn github-import-filter-trigger ${labels.trim() ? "is-active" : ""}`}
                    data-testid="github-import-filter-trigger"
                    aria-haspopup="dialog"
                    aria-expanded={filterOpen}
                    onClick={() => setFilterOpen((open) => !open)}
                    disabled={loading || importing || !hasRemotes}
                    title={t("git.filterByLabelsLabel", "Filter by labels")}
                  >
                    <Filter size={14} aria-hidden="true" />
                    <span className="github-import-filter-trigger__text">
                      {labels.trim() || t("git.filter", "Filter")}
                    </span>
                    <ChevronDown size={12} aria-hidden="true" />
                  </button>
                  {filterOpen && (
                    <div className="github-import-filter-panel" data-testid="github-import-filter-panel" role="dialog" aria-label={t("git.filterByLabelsLabel", "Filter by labels")}>
                      <label htmlFor="gh-labels" className="github-import-filter-panel__label">{t("git.filterByLabelsLabel", "Filter by labels")}</label>
                      <input
                        id="gh-labels"
                        type="text"
                        autoFocus
                        placeholder={t("git.filterByLabelsPlaceholder", "Filter: bug,enhancement…")}
                        value={labels}
                        onChange={(e) => setLabels(e.target.value)}
                        onKeyDown={(e) => {
                          // Enter applies the filter AND dismisses — the reload is the confirmation.
                          if (e.key === "Enter") { setFilterOpen(false); handleLoad(); }
                        }}
                        disabled={loading || importing || !hasRemotes}
                        aria-label={t("git.filterIssuesByLabels", "Filter issues by labels")}
                      />
                    </div>
                  )}
                </div>
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
                {/*
                FNXC:GitHubImport 2026-07-15-23:20:
                Load is icon-only. The full-width labelled button owned a whole row of vertical space
                for an action whose meaning the refresh glyph already carries; the label survives as
                the accessible name + tooltip (both set above), so nothing is lost for screen readers.
                */}
                {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              </button>
            </div>
          </div>
          </>)}
          </div>
          {provider === "github" ? (
          <>

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

          {/*
          FNXC:GitHubImport 2026-07-15-16:00:
          Import candidates stay in one full-width list. Selecting an item opens its complete detail in FloatingWindow, which
          supplies desktop drag/resize behavior and the scoped mobile full-screen sheet without bespoke split-pane geometry.
          */}
          <section className="github-import-list-pane" data-testid="github-import-list-pane" aria-labelledby="github-import-results-heading">
              <div className="github-import-pane-header">
                <h4 id="github-import-results-heading">
                  {activeTab === "issues" ? t("git.tabIssues", "Issues") : t("git.tabPullRequests", "Pull Requests")}
                </h4>
                {activeTab === "issues" && issues.length > 0 && (
                  <div className="github-import-results-meta" aria-live="polite">
                    <span>{t("git.issueCount", { count: issues.length, defaultValue_one: "{{count}} issue", defaultValue_other: "{{count}} issues" })}</span>
                    <span>{t("git.importedCount", "{{count}} imported", { count: importedIssueCount })}</span>
                    <label className="github-import-hide-imported">
                      <input type="checkbox" checked={hideImported} onChange={(event) => setHideImported(event.target.checked)} data-testid="github-import-hide-imported-toggle" />
                      {t("git.hideImported", "Hide imported")}
                    </label>
                  </div>
                )}
                {activeTab === "pulls" && pulls.length > 0 && (
                  <div className="github-import-results-meta" aria-live="polite">
                    <span>{t("git.pullCount", { count: pulls.length, defaultValue_one: "{{count}} pull request", defaultValue_other: "{{count}} pull requests" })}</span>
                    <span>{t("git.importedCount", "{{count}} imported", { count: importedPullCount })}</span>
                    <label className="github-import-hide-imported">
                      <input type="checkbox" checked={hideImported} onChange={(event) => setHideImported(event.target.checked)} data-testid="github-import-hide-imported-toggle" />
                      {t("git.hideImported", "Hide imported")}
                    </label>
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

                {activeTab === "issues" && allIssuesHidden && (
                  <div className="github-import-state github-import-state--empty" data-testid="github-import-all-imported-empty" role="status">
                    <div><strong>{t("git.allImportedHidden", "All loaded items are already imported")}</strong></div>
                  </div>
                )}

                {/* Issues list */}
                {activeTab === "issues" && visibleIssues.length > 0 && (
                  <div className="issues-list" aria-live="polite">
                    {visibleIssues.map((issue) => {
                      const isImported = isUrlImported(issue.html_url);
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
                              {/*
                              FNXC:GitHubImportTranslate 2026-07-15-09:30:
                              The LIST title shows the translation when auto-translate produced one — the requirement is that foreign issues are translated "before showing to the user", and the list is the first thing shown. `title` keeps the original so the untranslated text stays recoverable on hover.
                              */}
                              <span
                                className="issue-title"
                                title={autoTranslate.translations.has(issue.number) ? issue.title : undefined}
                                data-translated={autoTranslate.translations.has(issue.number) ? "true" : undefined}
                              >
                                {autoTranslate.translations.get(issue.number)?.title ?? issue.title}
                              </span>
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

                {activeTab === "pulls" && allPullsHidden && (
                  <div className="github-import-state github-import-state--empty" data-testid="github-import-all-imported-empty" role="status">
                    <div><strong>{t("git.allImportedHidden", "All loaded items are already imported")}</strong></div>
                  </div>
                )}

                {/* Pulls list */}
                {activeTab === "pulls" && visiblePulls.length > 0 && (
                  <div className="issues-list" aria-live="polite">
                    {visiblePulls.map((pull) => {
                      const isImported = isUrlImported(pull.html_url);
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

            {(selectedIssue || selectedPull) && (
            <FloatingWindow
              windowKey="github-import-detail"
              /*
              FNXC:GitHubImport 2026-07-15-18:40:
              Window title tracks importTranslation.display.title, so a translated issue/PR reads in the dashboard locale in the title bar exactly as it already does in the preview card below — previously the bar kept the raw upstream title while the card showed the translation, so one item displayed two different titles at once. display.title falls back to the original when nothing is translated.
              Gating mirrors translateSelection (activeTab AND selection) rather than checking selectedIssue first: display.title follows the active tab, so an issue-first check would pair the issue's number with the pull's translated title whenever both tabs hold a selection.
              */
              title={
                activeTab === "issues" && selectedIssue
                  ? `#${selectedIssue.number} — ${importTranslation.display.title}`
                  : activeTab === "pulls" && selectedPull
                    ? `#${selectedPull.number} — ${importTranslation.display.title}`
                    : t("git.importFromGitHub", "Import from GitHub")
              }
              onClose={() => { setSelectedIssueNumber(null); setSelectedPullNumber(null); }}
              defaultSize={{ width: 760, height: 680 }}
              minSize={{ width: 420, height: 360 }}
              persistGeometryKey="floating-window:github-import-detail"
              className="floating-window--github-import-detail"
            >
              <div className="github-import-detail-panel">
              {/*
              FNXC:GitHubImport 2026-07-15-23:20:
              Import and Close issue moved OUT of this header to a bottom action bar (see
              `github-import-detail-actions`). Operator report: actions above the content they act on
              read as navigation and are awkward to reach on a phone; a dialog's commit actions belong
              at the bottom, which also matches the modal's own Cancel bar. The header is now purely a
              heading.
              */}
              <div className="github-import-pane-header">
                <h4 id="github-import-preview-heading">{t("git.previewHeading", "Preview")}</h4>
              </div>
              {/*
              FNXC:GitHubImport 2026-06-23-03:15:
              Transient inline toast confirms issue-close success/failure (the modal has no toast prop). Auto-dismisses; never blocks the preview.
              */}
              {closeToast && (
                <div
                  className={`github-import-close-toast github-import-close-toast--${closeToast.type}`}
                  role="status"
                  data-testid="github-import-issue-close-toast"
                >
                  {closeToast.message}
                </div>
              )}

              <div className="github-import-pane-content">
                {/* Issue preview */}
                {/*
                FNXC:GitHubImport 2026-06-22-18:30:
                Full-issue preview: complete title, full body rendered as markdown, and key metadata (number, state, author, labels, URL). No body truncation/clamping.
                */}
                {activeTab === "issues" && selectedIssue ? (
                  <div className="issue-preview" data-testid="github-import-preview-card">
                    <div className="preview-meta">{t("git.previewIssueMeta", "Issue #{{number}}", { number: selectedIssue.number })}</div>
                    <div className="preview-title">{importTranslation.display.title}</div>
                    <div className="preview-metadata">
                      {/* FNXC:GitHubImport 2026-06-23-03:15: Badge reflects the local close (closedIssueNumbers) so closing the issue flips it to "closed" without a refetch. */}
                      {(() => {
                        const displayState = selectedIssueClosed ? "closed" : (selectedIssue.state ?? "open");
                        return (
                          <span className={`preview-state-badge preview-state-badge--${displayState}`}>{displayState}</span>
                        );
                      })()}
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
                    {/*
                    FNXC:GitHubImportTranslate 2026-07-14-12:00:
                    Translate banner appears only when detected content language differs from the dashboard locale. Displayed title/body swap between original and AI translation without changing what gets imported.
                    */}
                    {importTranslation.controls}
                    {importTranslation.display.body ? (
                      <MailboxMessageContent
                        className="preview-body preview-body--markdown"
                        content={importTranslation.display.body}
                        testId="github-import-preview-body"
                      />
                    ) : (
                      <div className="preview-body" data-testid="github-import-preview-body">
                        {t("git.noDescription", "(no description)")}
                      </div>
                    )}
                    {/*
                    FNXC:GitHubImport 2026-06-23-03:15:
                    Comments render BELOW the issue body inside the already-scrollable preview pane. They stream in after the per-issue detail fetch resolves and never block the body above.
                    Mirrors the PR comments markup/classes; markdown via MailboxMessageContent with an empty state.
                    */}
                    <CommentsThread
                      comments={issueDetail?.comments ?? []}
                      loading={issueDetailLoading}
                      error={issueDetailError}
                      sectionClassName="github-import-pr-comments github-import-issue-comments"
                      sectionTestId="github-import-issue-comments"
                      loadingTestId="github-import-issue-comments-loading"
                      errorTestId="github-import-issue-comments-error"
                      emptyTestId="github-import-issue-comments-empty"
                      bodyTestId="github-import-issue-comment-body"
                      t={t}
                    />
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
                    <div className="preview-title">{importTranslation.display.title}</div>
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
                    {/* FNXC:GitHubImportTranslate 2026-07-14-12:00: Same opt-in translate banner as the issue preview (title + body only; comments stay original). */}
                    {importTranslation.controls}
                    {importTranslation.display.body ? (
                      <MailboxMessageContent
                        className="preview-body preview-body--markdown"
                        content={importTranslation.display.body}
                        testId="github-import-preview-body"
                      />
                    ) : (
                      <div className="preview-body" data-testid="github-import-preview-body">
                        {t("git.noDescription", "(no description)")}
                      </div>
                    )}
                    {/*
                    FNXC:GitHubImport 2026-06-23-01:00:
                    Checks + Comments render BELOW the PR body inside the already-scrollable preview pane. They stream in after the per-PR detail fetch resolves and never block the body above.
                    Check status maps to a theme-token pill class (success/failure/pending/neutral); the rollup conclusion is preferred over the in-progress status for color.
                    */}
                    <div className="github-import-pr-checks" data-testid="github-import-pr-checks">
                      <h5 className="preview-section-heading">{t("git.checksHeading", "Checks")}</h5>
                      {pullDetailLoading ? (
                        <div className="preview-detail-loading" data-testid="github-import-pr-checks-loading">
                          <Loader2 size={14} className="spin" aria-hidden="true" />
                          <span>{t("git.loadingChecks", "Loading checks…")}</span>
                        </div>
                      ) : pullDetailError ? (
                        <div className="preview-detail-error" data-testid="github-import-pr-checks-error">{pullDetailError}</div>
                      ) : pullDetail && pullDetail.checks.length > 0 ? (
                        <ul className="github-import-pr-checks__list">
                          {pullDetail.checks.map((check, idx) => {
                            const indicator = check.conclusion ?? check.status;
                            const variant =
                              indicator === "success"
                                ? "success"
                                : indicator === "failure" || indicator === "error" || indicator === "cancelled" || indicator === "timed_out"
                                  ? "failure"
                                  : indicator === "neutral" || indicator === "skipped"
                                    ? "neutral"
                                    : "pending";
                            return (
                              <li key={`${check.name}-${idx}`} className="github-import-pr-check-row">
                                <span className={`github-import-pr-check-pill github-import-pr-check-pill--${variant}`}>{indicator || "pending"}</span>
                                {check.detailsUrl ? (
                                  <a className="github-import-pr-check-name" href={check.detailsUrl} target="_blank" rel="noopener noreferrer">{check.name}</a>
                                ) : (
                                  <span className="github-import-pr-check-name">{check.name}</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <div className="preview-detail-empty" data-testid="github-import-pr-checks-empty">{t("git.noChecks", "No checks")}</div>
                      )}
                    </div>
                    <CommentsThread
                      comments={pullDetail?.comments ?? []}
                      loading={pullDetailLoading}
                      error={pullDetailError}
                      sectionClassName="github-import-pr-comments"
                      sectionTestId="github-import-pr-comments"
                      loadingTestId="github-import-pr-comments-loading"
                      errorTestId="github-import-pr-comments-error"
                      emptyTestId="github-import-pr-comments-empty"
                      bodyTestId="github-import-pr-comment-body"
                      t={t}
                    />
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
              {/*
              FNXC:GitHubImport 2026-07-15-23:20:
              Bottom action bar for the detail preview — the ONLY place an import is committed now
              (the list's footer Import was removed, so you can no longer import an issue whose body
              you never opened). Import stays last/right as the primary action; Close issue sits to
              its LEFT and still acts on the selected OPEN issue: hidden on the PR tab and for
              already-closed issues, disabled while a close is in flight, and closing reflects
              locally (the badge flips) without dismissing the preview.
              */}
              <div className="github-import-detail-actions" data-testid="github-import-detail-actions">
                {activeTab === "issues" && selectedIssue && !selectedIssueClosed && (
                  <button
                    className="btn github-import-issue-close"
                    data-testid="github-import-issue-close"
                    onClick={handleCloseIssue}
                    disabled={closingIssue}
                    title={t("git.closeIssueTitle", "Close issue #{{number}}", { number: selectedIssue.number })}
                  >
                    {closingIssue ? <Loader2 size={14} className="spin" /> : t("git.closeIssue", "Close issue")}
                  </button>
                )}
                <button
                  className="btn btn-primary github-import-action"
                  data-testid="github-import-action-top"
                  onClick={handleImport}
                  disabled={
                    (activeTab === "issues" ? selectedIssueNumber === null || isUrlImported(selectedIssue?.html_url) : selectedPullNumber === null || isUrlImported(selectedPull?.html_url)) || importing
                  }
                >
                  {importing ? <Loader2 size={14} className="spin" /> : t("git.import", "Import")}
                </button>
              </div>
              </div>
            </FloatingWindow>
            )}
          </>
          ) : (
            <div className="github-import-gitlab" data-testid="gitlab-import-panel">
              <div className="github-import-tabs" role="tablist" aria-label={t("git.gitlabResourceAriaLabel", "GitLab resource type")}>
                {(["project_issue", "group_issue", "merge_request"] as GitLabResourceTab[]).map((resource) => (
                  <button key={resource} type="button" role="tab" aria-selected={gitlabResource === resource} className={`github-import-tab ${gitlabResource === resource ? "active" : ""}`} onClick={() => { setGitlabResource(resource); setGitlabItems([]); setSelectedGitlabKey(null); }} disabled={loading || importing || !gitlabEnabled}>
                    {resource === "project_issue" ? t("git.gitlabProjectIssues", "Project issues") : resource === "group_issue" ? t("git.gitlabGroupIssues", "Group issues") : t("git.gitlabMergeRequests", "Merge requests")}
                  </button>
                ))}
              </div>
              <div className="github-import-toolbar" role="toolbar" aria-label={t("git.gitlabToolbarAriaLabel", "GitLab import controls")}>
                {gitlabResource !== "group_issue" ? (
                  <input className="input" value={gitlabProject} onChange={(event) => setGitlabProject(event.target.value)} placeholder={t("git.gitlabProjectPlaceholder", "group/subgroup/project or numeric ID")} aria-label={t("git.gitlabProjectLabel", "GitLab project path or ID")} disabled={loading || importing || !gitlabEnabled} />
                ) : (
                  <input className="input" value={gitlabGroup} onChange={(event) => setGitlabGroup(event.target.value)} placeholder={t("git.gitlabGroupPlaceholder", "group/subgroup or numeric ID")} aria-label={t("git.gitlabGroupLabel", "GitLab group path or ID")} disabled={loading || importing || !gitlabEnabled} />
                )}
                <input className="input" value={labels} onChange={(event) => setLabels(event.target.value)} placeholder={t("git.filterByLabelsPlaceholder", "Filter: bug,enhancement…")} aria-label={t("git.filterGitLabByLabels", "Filter GitLab resources by labels")} disabled={loading || importing || !gitlabEnabled} />
                <button type="button" className="btn btn-primary" onClick={handleLoadGitLab} disabled={!gitlabEnabled || loading || importing || (gitlabResource === "group_issue" ? !gitlabGroup.trim() : !gitlabProject.trim())}>
                  {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                  {t("git.load", "Load")}
                </button>
                {gitlabItems.length > 0 && (
                  <label className="github-import-hide-imported">
                    <input type="checkbox" checked={hideImported} onChange={(event) => setHideImported(event.target.checked)} data-testid="github-import-hide-imported-toggle" />
                    {t("git.hideImported", "Hide imported")}
                  </label>
                )}
              </div>
              {!gitlabEnabled && <div className="github-import-state github-import-state--idle" data-testid="gitlab-import-disabled"><strong>{t("git.gitlabDisabledHeading", "GitLab integration disabled")}</strong><span>{t("git.gitlabDisabledHint", "Enable GitLab integration in Settings to fetch or import GitLab resources. Saved GitLab URLs and tokens remain configured.")}</span></div>}
              {error && <div className="github-import-state github-import-state--error" data-testid="gitlab-import-error"><strong>{t("git.gitlabError", "GitLab import unavailable")}</strong><span>{error}</span></div>}
              {gitlabItems.length === 0 && !loading && !error ? <div className="github-import-state github-import-state--idle" data-testid="gitlab-import-empty"><strong>{t("git.gitlabNoResources", "No GitLab resources loaded")}</strong><span>{t("git.gitlabLoadHint", "Enter a project or group and load resources from the configured GitLab instance.")}</span></div> : null}
              <div className="github-import-gitlab__workspace">
                {allGitlabItemsHidden ? (
                  <div className="github-import-state github-import-state--empty" data-testid="github-import-all-imported-empty" role="status">
                    <div><strong>{t("git.allImportedHidden", "All loaded items are already imported")}</strong></div>
                  </div>
                ) : visibleGitlabItems.length > 0 ? (
                <div className="issues-list" aria-live="polite">
                  {visibleGitlabItems.map((item) => {
                    const key = `${item.resourceKind}:${item.projectId ?? item.projectPath ?? ""}:${item.iid}`;
                    const imported = isUrlImported(item.webUrl);
                    return (
                      <button key={key} type="button" className={`issue-item ${selectedGitlabKey === key ? "selected" : ""} ${imported ? "imported" : ""}`} onClick={() => { if (!imported) setSelectedGitlabKey(key); }} disabled={imported}>
                        <div className="issue-title">{item.resourceKind === "merge_request" ? "!" : "#"}{item.iid} {item.title}</div>
                        <div className="issue-meta"><span>{item.projectPath ?? item.projectId}</span><span>{item.state}</span>{imported && <span>{t("git.alreadyImported", "Imported")}</span>}</div>
                      </button>
                    );
                  })}
                </div>
                ) : null}
                {selectedGitlabItem && (
                  <FloatingWindow
                    windowKey="github-import-detail"
                    /* FNXC:GitHubImport 2026-07-15-18:40: Mirrors the GitHub detail window — the title bar shows the same translated title as the card below rather than the raw upstream one. */
                    title={`${selectedGitlabItem.resourceKind === "merge_request" ? "!" : "#"}${selectedGitlabItem.iid} — ${importTranslation.display.title}`}
                    onClose={() => setSelectedGitlabKey(null)}
                    defaultSize={{ width: 760, height: 680 }}
                    minSize={{ width: 420, height: 360 }}
                    persistGeometryKey="floating-window:github-import-detail"
                    className="floating-window--github-import-detail"
                  >
                    <div className="github-import-detail-panel">
                      <div className="issue-preview" data-testid="gitlab-import-preview-card">
                        <h4>{selectedGitlabItem.resourceKind === "merge_request" ? "!" : "#"}{selectedGitlabItem.iid} {importTranslation.display.title}</h4>
                        <div className="preview-meta-row"><span className={`preview-state-badge preview-state-badge--${selectedGitlabItem.state}`}>{selectedGitlabItem.state}</span><a href={selectedGitlabItem.webUrl} target="_blank" rel="noopener noreferrer">{t("git.openSource", "Open source")}</a></div>
                        {importTranslation.controls}
                        <MailboxMessageContent className="preview-body preview-body--markdown" content={importTranslation.display.body?.trim() || t("git.noDescription", "(no description)")} testId="gitlab-import-preview-body" />
                        <button type="button" className="btn btn-primary" onClick={handleImportGitLab} disabled={!gitlabEnabled || importing || isUrlImported(selectedGitlabItem.webUrl)}>{importing ? <Loader2 size={14} className="spin" /> : t("git.import", "Import")}</button>
                      </div>
                    </div>
                  </FloatingWindow>
                )}
                </div>
              </div>
          )}
        </div>

        {/*
        FNXC:GitHubImport 2026-06-23-02:00 (revised 2026-07-15-23:20):
        The bottom bar exists ONLY for the non-embedded modal, which needs a Cancel to dismiss the
        dialog; the embedded sidebar has nothing to cancel, so it has no bar at all.

        Import no longer lives here. There were two ways to import — this footer (acting on the
        radio selection) and the preview pane — which split the action across two places and let you
        import an issue whose body you had never opened. Import is now ONLY in the detail preview's
        bottom action bar, so the list is purely for choosing what to look at. Cancel stays.
        */}
        {!isEmbedded && (
          <div className="modal-actions github-import-modal__actions">
            <button className="btn" onClick={onClose} disabled={importing}>
              {t("common.cancel", "Cancel")}
            </button>
          </div>
        )}
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
