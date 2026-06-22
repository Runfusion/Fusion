import "./SkillsView.css";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Zap, RefreshCw, X, ChevronRight, ChevronDown, AlertCircle, Loader2 } from "lucide-react";
import { ViewHeader } from "./ViewHeader";
import {
  fetchDiscoveredSkills,
  toggleExecutionSkill,
  installSkill,
  fetchSkillsCatalog,
  fetchSkillContent,
} from "../api";
import type { DiscoveredSkill, CatalogEntry, SkillContent } from "@fusion/dashboard";
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


  return (
    <div className="skills-view" data-testid="skills-view">
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
                          {skill.name}
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

                    {/* Skill Content Detail Panel */}
                    {isSelected && (
                      <div className="skills-view-detail" data-testid="skill-detail">
                        <div className="skills-view-detail-header">
                          <span className="skills-view-detail-title">{skill.name}</span>
                          <button
                            className="btn btn-sm skills-view-detail-close"
                            onClick={() => {
                              setSelectedSkillId(null);
                              setSkillContent(null);
                              setContentError(null);
                            }}
                            aria-label={t("skills.closeDetail", "Close skill detail")}
                          >
                            <X size={14} />
                            {t("common.close", "Close")}
                          </button>
                        </div>

                        {isLoadingContent ? (
                          <div className="skills-view-detail-loading">
                            <Loader2 size={16} className="spin" />
                            {t("skills.loadingContent", "Loading skill content...")}
                          </div>
                        ) : contentError ? (
                          <div className="skills-view-detail-error">
                            <AlertCircle size={14} />
                            <span>{contentError}</span>
                            <button
                              className="btn btn-sm"
                              onClick={() => handleRetrySkillContent(skill.id)}
                            >
                              {t("common.retry", "Retry")}
                            </button>
                          </div>
                        ) : skillContent ? (
                          <>
                            <pre className="skills-view-detail-content">
                              {skillContent.skillMd || t("skills.noSkillMd", "(No SKILL.md found)")}
                            </pre>
                            {skillContent.files.length > 0 && (
                              <div className="skills-view-detail-files">
                                <span className="skills-view-detail-files-label">{t("skills.filesLabel", "Files")}:</span>
                                {skillContent.files.map((file) => (
                                  <span key={file.relativePath} className="badge badge--sm">
                                    {file.name}
                                    {file.type === "directory" && "/"}
                                  </span>
                                ))}
                              </div>
                            )}
                          </>
                        ) : null}
                      </div>
                    )}
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
  );
}
