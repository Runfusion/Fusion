import "./SkillMultiselect.css";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchDiscoveredSkills } from "../api";
import type { DiscoveredSkill } from "../api";
import { classifyAgentSkill, formatAgentSkillBadgeLabel } from "../utils/agentSkills";
import { LoadingSpinner } from "./LoadingSpinner";

export interface SkillMultiselectProps {
  value: string[];
  onChange: (skills: string[]) => void;
  projectId?: string;
  disabled?: boolean;
  id?: string;
  label?: string;
  ariaDescribedBy?: string;
}

/**
 * FNXC:AgentSkillsUI 2026-08-16-04:27:
 * Issue #1422 requires selecting several forced-reading skills in one pass. FN-9114 makes
 * project-enabled skills automatic, so this list states both automatic availability and forced
 * selection instead of implying that every stored skill is delivered.
 *
 * FNXC:AgentSettingsTheming 2026-08-16-04:27:
 * Loading, error, empty, no-matches, populated, all-selected, and disabled classes are stable
 * theming states for Agent Settings. Preserve them while keeping list selection deduplicated.
 */
export function SkillMultiselect({ value, onChange, projectId, disabled = false, id, label = "Skills", ariaDescribedBy }: SkillMultiselectProps) {
  const { t } = useTranslation("app");
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [filter, setFilter] = useState("");
  const [requestVersion, setRequestVersion] = useState(0);
  const selectedIds = useMemo(() => [...new Set(value)], [value]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setHasError(false);
    fetchDiscoveredSkills(projectId)
      .then((discovered) => { if (!cancelled) setSkills(discovered); })
      .catch(() => { if (!cancelled) setHasError(true); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, requestVersion]);

  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const visibleSkills = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.relativePath}`.toLowerCase().includes(needle));
  }, [filter, skills]);

  const updateSelection = (skillId: string, checked: boolean) => {
    const next = checked ? [...selectedIds, skillId] : selectedIds.filter((entry) => entry !== skillId);
    onChange([...new Set(next)]);
  };

  return (
    <div className="skill-multiselect" data-testid="skill-multiselect">
      {label && <span className="skill-multiselect-label">{label}</span>}
      {selectedIds.length > 0 && (
        <div className="skill-multiselect-chips" data-testid="skill-chips">
          {selectedIds.map((skillId) => {
            const classification = classifyAgentSkill(skillId, hasError ? null : skills, { forced: true });
            return <span key={skillId} className="skill-chip" data-testid={`skill-chip-${skillId}`}>
              <span className="skill-chip-name">{skillById.get(skillId)?.name ?? formatAgentSkillBadgeLabel(skillId)}</span>
              <span className="skill-state-marker" data-skill-state={classification.state}>{t(classification.labelKey, classification.defaultLabel)}</span>
              <button type="button" className="skill-chip-remove" onClick={() => updateSelection(skillId, false)} disabled={disabled} aria-label={t("skills.removeSkill", "Remove {{name}}", { name: formatAgentSkillBadgeLabel(skillId) })} data-testid={`remove-skill-${skillId}`}>×</button>
            </span>;
          })}
        </div>
      )}
      {isLoading ? <span className="skill-multiselect-loading" data-testid="skills-loading"><LoadingSpinner label={t("skills.loading", "Loading skills…")} /></span>
        : hasError ? <div className="skill-multiselect-error" data-testid="skills-error" role="alert">{t("skills.loadError", "Skills could not be loaded.")} <button className="btn btn-sm" type="button" disabled={disabled} onClick={() => setRequestVersion((version) => version + 1)}>{t("common.retry", "Retry")}</button></div>
          : skills.length === 0 ? <span className="skill-multiselect-empty" data-testid="skills-empty">{t("skills.noSkillsDiscovered", "No skills discovered")}</span>
            : <>
              <input id={id} className="input skill-multiselect-filter" type="search" value={filter} disabled={disabled} onChange={(event) => setFilter(event.target.value)} placeholder={t("skills.filter", "Filter skills")} aria-label={t("skills.filter", "Filter skills")} aria-describedby={ariaDescribedBy} data-testid="skill-filter" />
              {visibleSkills.length === 0 ? <span className="skill-multiselect-no-matches" data-testid="skills-no-matches">{t("skills.noMatches", "No matching skills")}</span>
                : <div className="skill-multiselect-list" role="list">{visibleSkills.map((skill) => {
                  const checked = selectedIds.includes(skill.id);
                  const classification = classifyAgentSkill(skill.id, skills, { forced: checked });
                  return <label className="skill-multiselect-option" key={skill.id} data-testid={`skill-option-${skill.id}`}>
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => updateSelection(skill.id, event.target.checked)} />
                    <span className="skill-multiselect-option__content"><span>{skill.name}</span><span className="skill-multiselect-option__path">{skill.relativePath}</span></span>
                    <span className="skill-state-marker" data-skill-state={classification.state} title={t(classification.titleKey, classification.defaultTitle)}>{t(classification.labelKey, classification.defaultLabel)}</span>
                    {checked && <span className="skill-state-marker skill-state-marker--forced">{t("skills.forced", "Forced")}</span>}
                  </label>;
                })}</div>}
              {selectedIds.length === skills.length && <span className="skill-multiselect-all-selected">{t("skills.allSkillsSelected", "All skills selected")}</span>}
            </>}
    </div>
  );
}
