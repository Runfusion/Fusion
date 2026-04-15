import { useCallback, useEffect, useRef, useState } from "react";
import { Wrench, RefreshCw, X } from "lucide-react";
import {
  fetchDiscoveredSkills,
  toggleExecutionSkill,
  fetchSkillsCatalog,
} from "../api";
import type { DiscoveredSkill, CatalogEntry } from "@fusion/dashboard";
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

  // Debounce timer for catalog search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState("");

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
    }, 300);
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


  return (
    <div className="skills-view" data-testid="skills-view">
      {/* Header */}
      <div className="skills-view-header">
        <div className="skills-view-title">
          <h2>
            <Wrench size={20} />
            Skills
          </h2>
          <span className="skills-view-count">{discoveredSkills.length} discovered</span>
        </div>

        <div className="skills-view-actions">
          <button
            className="btn-icon skills-view-close"
            onClick={onClose}
            aria-label="Close skills view"
          >
            <X size={16} />
          </button>
          <button
            className="btn btn-sm"
            onClick={() => void loadDiscoveredSkills()}
            disabled={isLoadingDiscovered}
          >
            <RefreshCw size={14} className={isLoadingDiscovered ? "spin" : ""} />
            Refresh
          </button>
        </div>
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
        ) : (
          <div className="skills-view-list">
            {discoveredSkills.map((skill) => (
              <div key={skill.id} className="skills-view-item">
                <div className="skills-view-item-info">
                  <span className="skills-view-item-name">{skill.name}</span>
                  <span className="skills-view-item-path">{skill.relativePath}</span>
                  <span className="skills-view-item-source">{skill.metadata.source}</span>
                </div>
                <label className="skills-view-item-toggle">
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
            ))}
          </div>
        )}
      </section>

      {/* Catalog Section */}
      <section className="skills-view-section" aria-labelledby="catalog-title">
        <h3 id="catalog-title" className="skills-view-section-title">
          Skills Catalog
        </h3>

        {/* Search */}
        <div className="skills-view-search">
          <input
            type="text"
            className="form-input"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            aria-label="Search skills catalog"
          />
        </div>

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
  );
}
