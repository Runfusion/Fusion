import "./SkillsView.css";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Zap, RefreshCw, X, ChevronRight, ChevronDown, AlertCircle, Loader2, ArrowLeft } from "lucide-react";
import { ViewHeader } from "./ViewHeader";
import { MailboxMessageContent } from "./MailboxMessageContent";
import {
  fetchDiscoveredSkills,
  toggleExecutionSkill,
  installSkill,
  fetchSkillsCatalog,
  fetchSkillContent,
  fetchSkillFileContent,
} from "../api";
import type { DiscoveredSkill, CatalogEntry, SkillContent, SkillFileContent } from "@fusion/dashboard";

/*
FNXC:Skills 2026-06-23-04:15:
Treat these extensions as markdown so the file viewer renders them via MailboxMessageContent (GitHub-flavored markdown + sanitized HTML + mermaid). Everything else renders as plain <pre> text (or a non-previewable notice when the server flags isText:false). SKILL.md itself always renders as markdown regardless of this set.
*/
const MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

function isMarkdownFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return MARKDOWN_FILE_EXTENSIONS.has(lower.slice(dot));
}
import type { ToastType } from "../hooks/useToast";

interface SkillsViewProps {
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onClose: () => void;
}

export interface DiscoveredSkillDisplay extends DiscoveredSkill {
  toggling?: boolean;
}

export function SkillsView({ projectId, addToast, onClose }: SkillsViewProps) {
  const { t } = useTranslation("app");
  const [discoveredSkills, setDiscoveredSkills] = useState<DiscoveredSkillDisplay[]>([]);
  const [isLoadingDiscovered, setIsLoadingDiscovered] = useState(true);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogEntries, setCatalogEntries] = useState<CatalogEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [installingCatalogEntryId, setInstallingCatalogEntryId] = useState<string | null>(null);

  // Skill content viewing state
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState<SkillContent | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  /*
  FNXC:Skills 2026-06-23-04:15:
  File-viewer state for the detail pane. `viewedFilePath` is the skill-dir-relative path of the file currently shown (null = the SKILL.md markdown view). When non-null the detail body renders the file's content with a "← Back to SKILL.md" affordance instead of the SKILL.md body. The files area stays reachable so the user can switch between files.
  */
  const [viewedFilePath, setViewedFilePath] = useState<string | null>(null);
  const [viewedFile, setViewedFile] = useState<SkillFileContent | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Debounce timer for catalog search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Client-side filtering for discovered skills
  const filteredDiscoveredSkills = searchQuery.trim()
    ? discoveredSkills.filter(
        (s) =>
          s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.relativePath.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : discoveredSkills;

  // Fetch discovered skills
  const loadDiscoveredSkills = useCallback(async () => {
    setIsLoadingDiscovered(true);
    try {
      const skills = await fetchDiscoveredSkills(projectId);
      setDiscoveredSkills(skills);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("skills.loadDiscoveredError", "Failed to load discovered skills");
      addToast(message, "error");
    } finally {
      setIsLoadingDiscovered(false);
    }
  }, [projectId, addToast]);

  // Fetch catalog
  const loadCatalog = useCallback(async (query: string) => {
    const isCatalogUnavailableError = (error: unknown): boolean => {
      if (!error || typeof error !== "object") {
        return false;
      }

      const withStatus = error as { status?: unknown; details?: unknown };
      if (typeof withStatus.status === "number" && withStatus.status >= 500) {
        return true;
      }

      if (withStatus.details && typeof withStatus.details === "object") {
        const details = withStatus.details as { code?: unknown };
        if (typeof details.code === "string" && details.code.startsWith("upstream_")) {
          return true;
        }
      }

      const legacy = error as { error?: unknown; code?: unknown };
      return typeof legacy.error === "string" && typeof legacy.code === "string";
    };

    setIsLoadingCatalog(true);
    setCatalogError(null);
    try {
      const result = await fetchSkillsCatalog(query, 20, projectId);
      setCatalogEntries(result.entries);
    } catch (err) {
      if (isCatalogUnavailableError(err)) {
        setCatalogError(t("skills.catalogUnavailable", "Catalog is temporarily unavailable. Please try again later."));
      } else {
        const message = err instanceof Error ? err.message : t("skills.loadCatalogError", "Failed to load catalog");
        setCatalogError(message);
      }
    } finally {
      setIsLoadingCatalog(false);
    }
  }, [projectId]);

  // Initial load
  useEffect(() => {
    void loadDiscoveredSkills();
    void loadCatalog("");
  }, [loadDiscoveredSkills, loadCatalog]);

  // Handle search input with debounce
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(value);
      debounceRef.current = null;
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  // Fetch catalog when debounced query changes
  useEffect(() => {
    void loadCatalog(debouncedQuery);
  }, [debouncedQuery, loadCatalog]);

  // Handle toggle skill
  const handleToggleSkill = useCallback(async (skillId: string, currentEnabled: boolean) => {
    const newEnabled = !currentEnabled;

    // Optimistic update
    setDiscoveredSkills((prev) =>
      prev.map((s) => (s.id === skillId ? { ...s, toggling: true } : s))
    );

    try {
      await toggleExecutionSkill(skillId, newEnabled, projectId);

      // Update local state with new enabled value
      setDiscoveredSkills((prev) =>
        prev.map((s) => (s.id === skillId ? { ...s, enabled: newEnabled, toggling: false } : s))
      );

      addToast(t(`skills.${newEnabled ? "enabled" : "disabled"}`, newEnabled ? "Skill enabled" : "Skill disabled"), "success");
    } catch (err) {
      // Revert optimistic update
      setDiscoveredSkills((prev) =>
        prev.map((s) => (s.id === skillId ? { ...s, toggling: false } : s))
      );

      const message = err instanceof Error ? err.message : t("skills.toggleError", "Failed to toggle skill");
      addToast(t("skills.toggleFailed", "Failed to toggle skill: {{message}}", { message }), "error");
    }
  }, [projectId, addToast]);

  const handleInstallCatalogSkill = useCallback(async (entry: CatalogEntry) => {
    const source = entry.repo?.trim();
    if (!source || installingCatalogEntryId === entry.id) {
      return;
    }

    setInstallingCatalogEntryId(entry.id);
    try {
      await installSkill(source, entry.slug || entry.name, projectId);
      addToast(t("skills.installSuccess", "Installed {{name}}", { name: entry.name }), "success");
      await loadDiscoveredSkills();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("skills.installError", "Failed to install skill");
      addToast(t("skills.installFailed", "Failed to install {{name}}: {{message}}", { name: entry.name, message }), "error");
    } finally {
      setInstallingCatalogEntryId((current) => (current === entry.id ? null : current));
    }
  }, [addToast, installingCatalogEntryId, loadDiscoveredSkills, projectId]);

  const loadSkillContent = useCallback(async (skillId: string) => {
    setIsLoadingContent(true);
    setContentError(null);
    setSkillContent(null);
    // FNXC:Skills 2026-06-23-04:15: switching skills always returns to the SKILL.md view (clear any open file).
    setViewedFilePath(null);
    setViewedFile(null);
    setFileError(null);

    try {
      const content = await fetchSkillContent(skillId, projectId);
      setSkillContent(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("skills.loadContentError", "Failed to load skill content");
      setContentError(message);
    } finally {
      setIsLoadingContent(false);
    }
  }, [projectId]);

  // Handle click on discovered skill to view content
  const handleSkillClick = useCallback((skillId: string, event?: MouseEvent<HTMLElement>) => {
    if (event) {
      const target = event.target as Element;
      if (target.closest(".skills-view-item-toggle")) {
        return;
      }
    }

    if (selectedSkillId === skillId) {
      setSelectedSkillId(null);
      setSkillContent(null);
      setContentError(null);
      // FNXC:Skills 2026-06-23-04:15: collapsing the selected skill also drops any open file view.
      setViewedFilePath(null);
      setViewedFile(null);
      setFileError(null);
      return;
    }

    setSelectedSkillId(skillId);
    void loadSkillContent(skillId);
  }, [selectedSkillId, loadSkillContent]);

  const handleRetrySkillContent = useCallback((skillId: string) => {
    if (selectedSkillId !== skillId) {
      setSelectedSkillId(skillId);
    }
    void loadSkillContent(skillId);
  }, [loadSkillContent, selectedSkillId]);

  /*
  FNXC:Skills 2026-06-23-04:15:
  Load a single referenced file into the detail pane. Sets viewedFilePath immediately so the pane swaps to the file viewer (with the back affordance) while the body fetches. Markdown files render via MailboxMessageContent; other text files render as <pre>; binary/oversized files (isText:false) show a non-previewable notice.
  */
  const loadSkillFile = useCallback(async (skillId: string, relativePath: string) => {
    setViewedFilePath(relativePath);
    setViewedFile(null);
    setFileError(null);
    setIsLoadingFile(true);
    try {
      const file = await fetchSkillFileContent(skillId, relativePath, projectId);
      setViewedFile(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("skills.loadFileError", "Failed to load file");
      setFileError(message);
    } finally {
      setIsLoadingFile(false);
    }
  }, [projectId]);

  // FNXC:Skills 2026-06-23-04:15: BACK affordance from a file view -> the SKILL.md markdown view (keeps the skill selected).
  const backToSkillMd = useCallback(() => {
    setViewedFilePath(null);
    setViewedFile(null);
    setFileError(null);
    setIsLoadingFile(false);
  }, []);

  /*
  FNXC:Skills 2026-06-23-01:45:
  Master/detail clear. Returns the list from the narrow single-panel detail view (the BACK affordance) and also backs the detail-pane Close button. Mirrors DockFilesView's handleBack: drop the selection + cached content so the right pane shows its empty-state (wide) or the list reappears (narrow).
  */
  const clearSelection = useCallback(() => {
    setSelectedSkillId(null);
    setSkillContent(null);
    setContentError(null);
    // FNXC:Skills 2026-06-23-04:15: leaving the detail pane also drops any open file view.
    setViewedFilePath(null);
    setViewedFile(null);
    setFileError(null);
  }, []);

  // FNXC:Skills 2026-06-23-01:45: the detail pane renders the SELECTED skill's row data (name/path) alongside its fetched content. Resolve it once from the loaded list so the pane header stays correct even when the search filter would otherwise hide the row.
  const selectedSkill = useMemo(
    () => discoveredSkills.find((s) => s.id === selectedSkillId) ?? null,
    [discoveredSkills, selectedSkillId],
  );

  /*
  FNXC:Skills 2026-06-23-01:45:
  Responsive master/detail, modeled exactly on DockFilesView (RightDockFiles). The root `.skills-view` is a query container (container-type: inline-size, container-name: skills-view). BOTH panes — `.skills-view__list` (left) and `.skills-view__detail` (right) — are ALWAYS rendered in the DOM; CSS decides what is visible per container width.
  - WIDE (@container min-width: 640px): two-pane side-by-side. List pinned LEFT (clamped width, scrolls), detail flex:1 on the RIGHT (scrolls), empty-state until a skill is selected. Both always visible, so the BACK button is hidden (the list never disappears). Selecting a skill updates the right pane in place.
  - NARROW (default, e.g. embedded sidebar dock + mobile): single-panel master→detail stack. The list fills the root; selecting a skill (root [data-selected="true"]) reveals the detail pane ON TOP and hides the list. The BACK button (data-testid="skills-detail-back") returns to the list.
  `data-selected` on the root lets the container query distinguish "no skill selected" (narrow: detail hidden, list shows) from "skill selected" (narrow: detail covers the stack). When wide both panes are always visible regardless of this flag — same deterministic fallback path DockFilesView documents if the @container proves unreliable, except SkillsView always lives in a full-width main panel so the query fires reliably here.
  */
  /*
  FNXC:Skills 2026-06-23-04:15:
  Compact files strip rendered under BOTH the SKILL.md view and any open file view, so the user can switch between referenced files without leaving the detail pane. Renders ALL of skillContent.files (no cap/truncation). Files are clickable (data-testid="skill-file-item") and load into the viewer; directories are non-clickable (they have no previewable content). The active file is marked --active. The strip uses the compact `.skills-view-detail-files` styling (smaller padding/row height/font) so it no longer dominates the pane.
  */
  const renderFilesStrip = () => {
    if (!skillContent || skillContent.files.length === 0) {
      return null;
    }
    return (
      <div className="skills-view-detail-files" data-testid="skill-files">
        <span className="skills-view-detail-files-label">{t("skills.filesLabel", "Files")}:</span>
        {skillContent.files.map((file) => {
          if (file.type === "directory") {
            return (
              <span key={file.relativePath} className="badge badge--sm skills-view-detail-file--dir">
                {file.name}/
              </span>
            );
          }
          const isActive = viewedFilePath === file.relativePath;
          return (
            <button
              key={file.relativePath}
              type="button"
              data-testid="skill-file-item"
              className={`badge badge--sm skills-view-detail-file${isActive ? " skills-view-detail-file--active" : ""}`}
              onClick={() => selectedSkillId && void loadSkillFile(selectedSkillId, file.relativePath)}
              aria-pressed={isActive}
              aria-label={t("skills.viewFile", "View {{name}}", { name: file.name })}
            >
              {file.name}
            </button>
          );
        })}
      </div>
    );
  };

  /*
  FNXC:Skills 2026-06-23-04:15:
  Detail body branches: empty-state -> loading -> error -> [file viewer | SKILL.md]. The SKILL.md body now renders as MARKDOWN via MailboxMessageContent (GFM + sanitized HTML + mermaid) instead of a raw <pre>. The compact files strip renders below either content view so files stay reachable.
  */
  const renderDetailBody = () => {
    if (!selectedSkillId) {
      return (
        <div className="skills-view-detail-placeholder" data-testid="skills-detail-empty">
          {t("skills.selectASkill", "Select a skill to view its details")}
        </div>
      );
    }
    if (isLoadingContent) {
      return (
        <div className="skills-view-detail-loading">
          <Loader2 size={16} className="spin" />
          {t("skills.loadingContent", "Loading skill content...")}
        </div>
      );
    }
    if (contentError) {
      return (
        <div className="skills-view-detail-error">
          <AlertCircle size={14} />
          <span>{contentError}</span>
          <button
            className="btn btn-sm"
            onClick={() => handleRetrySkillContent(selectedSkillId)}
          >
            {t("common.retry", "Retry")}
          </button>
        </div>
      );
    }
    if (!skillContent) {
      return null;
    }

    // FNXC:Skills 2026-06-23-04:15: file view — a referenced file is open. Back affordance returns to the SKILL.md markdown view.
    if (viewedFilePath !== null) {
      return (
        <div className="skills-view-file-viewer" data-testid="skill-file-viewer">
          <div className="skills-view-file-viewer-bar">
            <button
              type="button"
              className="btn btn-sm skills-view-file-back"
              onClick={backToSkillMd}
              data-testid="skill-file-back"
              aria-label={t("skills.backToSkillMd", "Back to SKILL.md")}
            >
              <ArrowLeft size={14} />
              {t("skills.backToSkillMd", "Back to SKILL.md")}
            </button>
            <span className="skills-view-file-viewer-name">{viewedFilePath}</span>
          </div>
          {isLoadingFile ? (
            <div className="skills-view-detail-loading">
              <Loader2 size={16} className="spin" />
              {t("skills.loadingFile", "Loading file...")}
            </div>
          ) : fileError ? (
            <div className="skills-view-detail-error">
              <AlertCircle size={14} />
              <span>{fileError}</span>
              <button
                className="btn btn-sm"
                onClick={() => selectedSkillId && void loadSkillFile(selectedSkillId, viewedFilePath)}
              >
                {t("common.retry", "Retry")}
              </button>
            </div>
          ) : viewedFile && !viewedFile.isText ? (
            <div className="skills-view-detail-empty">
              {t("skills.fileNotPreviewable", "This file cannot be previewed.")}
            </div>
          ) : viewedFile ? (
            isMarkdownFile(viewedFile.relativePath) ? (
              <MailboxMessageContent
                content={viewedFile.content || t("skills.emptyFile", "(Empty file)")}
                className="skills-view-detail-markdown"
                testId="skills-view-detail-markdown"
              />
            ) : (
              <pre className="skills-view-detail-content">
                {viewedFile.content || t("skills.emptyFile", "(Empty file)")}
              </pre>
            )
          ) : null}
          {renderFilesStrip()}
        </div>
      );
    }

    // FNXC:Skills 2026-06-23-04:15: SKILL.md view — rendered as markdown via the shared MailboxMessageContent.
    return (
      <>
        <MailboxMessageContent
          content={skillContent.skillMd || t("skills.noSkillMd", "(No SKILL.md found)")}
          className="skills-view-detail-markdown"
          testId="skills-view-detail-markdown"
        />
        {renderFilesStrip()}
      </>
    );
  };

  return (
    <div
      className="skills-view"
      data-testid="skills-view"
      data-selected={selectedSkillId ? "true" : "false"}
    >
      {/*
      FNXC:Navigation 2026-06-22-01:10:
      Skills adopts the shared ViewHeader (Command Center-modeled) for a consistent main-content title row. Icon matches the left-sidebar nav (Zap). The discovered-count badge plus Close and Refresh controls move into the header actions cluster so they keep working.
      */}
      <ViewHeader
        icon={Zap}
        title={t("skills.title", "Skills")}
        actions={
          <>
            <span className="skills-view-count" aria-label={t("skills.discoveredCount", "{{count}} discovered skills", { count: discoveredSkills.length })}>{discoveredSkills.length} {t("skills.discovered", "discovered")}</span>
            <button
              className="btn-icon skills-view-close touch-target"
              onClick={onClose}
              aria-label={t("skills.closeView", "Close skills view")}
            >
              <X size={16} />
            </button>
            {/* FNXC:Skills 2026-06-22-17:35: Refresh uses plain btn btn-sm (no touch-target min-height) so it matches the Mailbox Compose button height (also btn btn-sm). */}
            <button
              className="btn btn-sm"
              onClick={() => void loadDiscoveredSkills()}
              disabled={isLoadingDiscovered}
            >
              <RefreshCw size={14} className={isLoadingDiscovered ? "spin" : ""} />
              {t("common.refresh", "Refresh")}
            </button>
          </>
        }
      />

      {/*
      FNXC:Skills 2026-06-23-01:45:
      Master/detail body. Holds the two always-rendered panes. CSS (container query on the `.skills-view` root) lays them out side-by-side when wide and stacks them (list, then detail-on-top) when narrow.
      */}
      <div className="skills-view-body">
        {/* FNXC:Skills 2026-06-23-01:45: LEFT pane = master list (search + discovered + catalog). Always in the DOM; CSS hides it only in the narrow stack once a skill is selected. */}
        <div className="skills-view__list" data-testid="skills-list">
      {/* Scrollable content area */}
      <div className="skills-view-content">
        {/* Search — at top for both sections */}
        <div className="skills-view-search">
          <input
            type="text"
            className="form-input"
            placeholder={t("skills.searchPlaceholder", "Search skills...")}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            aria-label={t("skills.searchLabel", "Search skills")}
          />
        </div>

        {/* Discovered Skills Section */}
        <section className="skills-view-section" aria-labelledby="discovered-skills-title">
          <h3 id="discovered-skills-title" className="skills-view-section-title">
            {t("skills.discoveredSection", "Discovered Skills")}
          </h3>

          {isLoadingDiscovered ? (
            <div className="skills-view-loading">
              <span className="spinner" />
              {t("skills.loadingDiscovered", "Loading discovered skills...")}
            </div>
          ) : discoveredSkills.length === 0 ? (
            <div className="skills-view-empty">
              <p>{t("skills.noDiscovered", "No skills discovered in this project.")}</p>
            </div>
          ) : filteredDiscoveredSkills.length === 0 ? (
            <div className="skills-view-empty">
              <p>{t("skills.noMatchingDiscovered", "No discovered skills match your search.")}</p>
            </div>
          ) : (
            <div className="skills-view-list">
              {filteredDiscoveredSkills.map((skill) => {
                const isSelected = selectedSkillId === skill.id;
                return (
                  <div key={skill.id}>
                    <div
                      className={`skills-view-item${isSelected ? " skills-view-item--selected" : ""}`}
                      onClick={(event) => handleSkillClick(skill.id, event)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleSkillClick(skill.id);
                        }
                      }}
                      aria-expanded={isSelected}
                      aria-label={t("skills.viewDetails", "View details for {{name}}", { name: skill.name })}
                    >
                      <div className="skills-view-item-info">
                        <span className="skills-view-item-name">
                          {isSelected ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <span className="skills-view-item-name-text">{skill.name}</span>
                        </span>
                        <span className="skills-view-item-path">{skill.relativePath}</span>
                        <span className="skills-view-item-source">{skill.metadata.source}</span>
                      </div>
                      <label
                        className="skills-view-item-toggle"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          disabled={skill.toggling}
                          onChange={() => void handleToggleSkill(skill.id, skill.enabled)}
                          aria-label={t(`skills.${skill.enabled ? "disable" : "enable"}Skill`, skill.enabled ? "Disable {{name}}" : "Enable {{name}}", { name: skill.name })}
                        />
                        <span className="skills-view-toggle-slider" />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Catalog Section */}
        <section className="skills-view-section" aria-labelledby="catalog-title">
          <h3 id="catalog-title" className="skills-view-section-title">
            {t("skills.catalogSection", "Skills Catalog")}
          </h3>

          {/* Catalog Content */}
          {catalogError ? (
            <div className="skills-view-error">
              <p>{catalogError}</p>
              <button
                className="btn btn-sm"
                onClick={() => void loadCatalog(debouncedQuery)}
              >
                {t("common.tryAgain", "Try Again")}
              </button>
            </div>
          ) : isLoadingCatalog ? (
            <div className="skills-view-loading">
              <span className="spinner" />
              {t("skills.loadingCatalog", "Loading catalog...")}
            </div>
          ) : catalogEntries.length === 0 ? (
            <div className="skills-view-empty">
              {searchQuery ? (
                <p>{t("skills.noMatchingSearch", "No skills match your search.")}</p>
              ) : (
                <p>{t("skills.noCatalogAvailable", "No skills available in the catalog.")}</p>
              )}
            </div>
          ) : (
            <div className="skills-view-grid">
              {catalogEntries.map((entry) => {
                const source = entry.repo?.trim();
                const canInstall = Boolean(source);
                const isInstalling = installingCatalogEntryId === entry.id;

                return (
                  <div key={entry.id} className="skills-view-card">
                    <div className="skills-view-card-header">
                      <h4 className="skills-view-card-title">{entry.name}</h4>
                      {canInstall ? (
                        <button
                          type="button"
                          className="btn btn-sm skills-view-card-install"
                          onClick={() => void handleInstallCatalogSkill(entry)}
                          disabled={isInstalling}
                          aria-label={t("skills.installSkill", "Install {{name}}", { name: entry.name })}
                        >
                          {isInstalling ? <Loader2 size={14} className="spin" /> : null}
                          {isInstalling ? t("skills.installing", "Installing…") : t("skills.install", "Install")}
                        </button>
                      ) : null}
                    </div>
                    {entry.description && (
                      <p className="skills-view-card-description">{entry.description}</p>
                    )}
                    {entry.tags && entry.tags.length > 0 && (
                      <div className="skills-view-card-tags">
                        {entry.tags.map((tag) => (
                          <span key={tag} className="badge badge--sm">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {entry.installs !== undefined && (
                      <span className="skills-view-card-installs">
                        {t("skills.installsCount", "{{value}} installs", { value: entry.installs.toLocaleString() })}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
        </div>

        {/*
        FNXC:Skills 2026-06-23-01:45:
        RIGHT pane = detail. Always in the DOM; CSS shows it side-by-side when wide (empty-state until a skill is selected), or as the single-panel stack overlay when narrow + a skill is selected. Preserves the original detail content: SKILL.md body, file badges, load/error/retry states.
        */}
        <div className="skills-view__detail" data-testid="skill-detail">
          <div className="skills-view-detail-header">
            {/* FNXC:Skills 2026-06-23-01:45: BACK only matters in the narrow stack (returns to the list); CSS hides it when wide since the list is always visible. Mirrors DockFilesView's back affordance. */}
            <button
              type="button"
              className="btn btn-sm btn-icon skills-view-detail-back"
              onClick={clearSelection}
              aria-label={t("skills.backToList", "Back to skills")}
              title={t("skills.backToList", "Back to skills")}
              data-testid="skills-detail-back"
            >
              <ArrowLeft size={14} />
            </button>
            <span className="skills-view-detail-title">
              {selectedSkill?.name ?? t("skills.detailTitle", "Skill")}
            </span>
            {/* FNXC:Skills 2026-06-23-01:45: Close clears the selection. In the wide two-pane layout it returns the detail to its empty-state; in the narrow stack it returns to the list (same effect as BACK). */}
            <button
              className="btn btn-sm skills-view-detail-close"
              onClick={clearSelection}
              disabled={!selectedSkillId}
              aria-label={t("skills.closeDetail", "Close skill detail")}
            >
              <X size={14} />
              {t("common.close", "Close")}
            </button>
          </div>
          <div className="skills-view-detail-body">
            {renderDetailBody()}
          </div>
        </div>
      </div>
    </div>
  );
}
