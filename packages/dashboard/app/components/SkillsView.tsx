import "./SkillsView.css";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Wrench, RefreshCw, X, ChevronRight, ChevronDown, AlertCircle, Loader2 } from "lucide-react";
import {
  fetchDiscoveredSkills,
  toggleExecutionSkill,
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
  const [discoveredSkills, setDiscoveredSkills] = useState<DiscoveredSkillDisplay[]>([]);
  const [isLoadingDiscovered, setIsLoadingDiscovered] = useState(true);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogEntries, setCatalogEntries] = useState<CatalogEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

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
      const message = err instanceof Error ? err.message : "Failed to load discovered skills";
      addToast(message, "error");
    } finally {
      setIsLoadingDiscovered(false);
    }
  }, [projectId, addToast]);

  // Fetch catalog
  const loadCatalog = useCallback(async (query: string) => {
    setIsLoadingCatalog(true);
    setCatalogError(null);
    try {
      const result = await fetchSkillsCatalog(query, 20, projectId);
      setCatalogEntries(result.entries);
    } catch (err) {
      // Check for upstream error with code (502 etc.)
      const error = err as { error?: string; code?: string };
      if (error.error && error.code) {
        setCatalogError("Catalog is temporarily unavailable. Please try again later.");
      } else {
        const message = err instanceof Error ? err.message : "Failed to load catalog";
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

      addToast(`Skill ${newEnabled ? "enabled" : "disabled"}`, "success");
    } catch (err) {
      // Revert optimistic update
      setDiscoveredSkills((prev) =>
        prev.map((s) => (s.id === skillId ? { ...s, toggling: false } : s))
      );

      const message = err instanceof Error ? err.message : "Failed to toggle skill";
      addToast(`Failed to toggle skill: ${message}`, "error");
    }
  }, [projectId, addToast]);

  const loadSkillContent = useCallback(async (skillId: string) => {
    setIsLoadingContent(true);
    setContentError(null);
    setSkillContent(null);

    try {
      const content = await fetchSkillContent(skillId, projectId);
      setSkillContent(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load skill content";
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
      {/* Header */}
      <div className="skills-view-header">
        <div className="skills-view-title">
          <h2>
            <Wrench size={20} />
            Skills
          </h2>
          <span className="skills-view-count" aria-label={`${discoveredSkills.length} discovered skills`}>{discoveredSkills.length} discovered</span>
        </div>

        <div className="skills-view-actions">
          <button
            className="btn-icon skills-view-close touch-target"
            onClick={onClose}
            aria-label="Close skills view"
          >
            <X size={16} />
          </button>
          <button
            className="btn btn-sm touch-target"
            onClick={() => void loadDiscoveredSkills()}
            disabled={isLoadingDiscovered}
          >
            <RefreshCw size={14} className={isLoadingDiscovered ? "spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Scrollable content area */}
      <div className="skills-view-content">
        {/* Search — at top for both sections */}
        <div className="skills-view-search">
          <input
            type="text"
            className="form-input"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            aria-label="Search skills"
          />
        </div>

        {/* Discovered Skills Section */}
        <section className="skills-view-section" aria-labelledby="discovered-skills-title">
          <h3 id="discovered-skills-title" className="skills-view-section-title">
            Discovered Skills
          </h3>

          {isLoadingDiscovered ? (
            <div className="skills-view-loading">
              <span className="spinner" />
              Loading discovered skills...
            </div>
          ) : discoveredSkills.length === 0 ? (
            <div className="skills-view-empty">
              <p>No skills discovered in this project.</p>
            </div>
          ) : filteredDiscoveredSkills.length === 0 ? (
            <div className="skills-view-empty">
              <p>No discovered skills match your search.</p>
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
                      aria-label={`View details for ${skill.name}`}
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
                          aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
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
                            aria-label="Close skill detail"
                          >
                            <X size={14} />
                            Close
                          </button>
                        </div>

                        {isLoadingContent ? (
                          <div className="skills-view-detail-loading">
                            <Loader2 size={16} className="spin" />
                            Loading skill content...
                          </div>
                        ) : contentError ? (
                          <div className="skills-view-detail-error">
                            <AlertCircle size={14} />
                            <span>{contentError}</span>
                            <button
                              className="btn btn-sm"
                              onClick={() => handleRetrySkillContent(skill.id)}
                            >
                              Retry
                            </button>
                          </div>
                        ) : skillContent ? (
                          <>
                            <pre className="skills-view-detail-content">
                              {skillContent.skillMd || "(No SKILL.md found)"}
                            </pre>
                            {skillContent.files.length > 0 && (
                              <div className="skills-view-detail-files">
                                <span className="skills-view-detail-files-label">Files:</span>
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
            Skills Catalog
          </h3>

          {/* Catalog Content */}
          {catalogError ? (
            <div className="skills-view-error">
              <p>{catalogError}</p>
              <button
                className="btn btn-sm"
                onClick={() => void loadCatalog(debouncedQuery)}
              >
                Try Again
              </button>
            </div>
          ) : isLoadingCatalog ? (
            <div className="skills-view-loading">
              <span className="spinner" />
              Loading catalog...
            </div>
          ) : catalogEntries.length === 0 ? (
            <div className="skills-view-empty">
              {searchQuery ? (
                <p>No skills match your search.</p>
              ) : (
                <p>No skills available in the catalog.</p>
              )}
            </div>
          ) : (
            <div className="skills-view-grid">
              {catalogEntries.map((entry) => (
                <div key={entry.id} className="skills-view-card">
                  <h4 className="skills-view-card-title">{entry.name}</h4>
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
                      {entry.installs.toLocaleString()} installs
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
