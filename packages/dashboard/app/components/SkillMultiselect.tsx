import "./SkillMultiselect.css";
import { useState, useEffect } from "react";
import { fetchDiscoveredSkills } from "../api";
import type { DiscoveredSkill } from "../api";

export interface SkillMultiselectProps {
  /** Currently selected skill IDs */
  value: string[];
  /** Called when the selection changes */
  onChange: (skills: string[]) => void;
  /** Project context for API calls */
  projectId?: string;
  /** Disable the control */
  disabled?: boolean;
  /** HTML id for accessibility */
  id?: string;
  /** Label text shown above the component */
  label?: string;
}

/**
 * Reusable skill multiselect component.
 * Shows selected skills as removable chips and a dropdown to add more skills.
 */
export function SkillMultiselect({
  value,
  onChange,
  projectId,
  disabled = false,
  id,
  label = "Skills",
}: SkillMultiselectProps) {
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    fetchDiscoveredSkills(projectId)
      .then((discovered) => {
        if (!cancelled) {
          setSkills(discovered);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkills([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleAddSkill = (skillId: string) => {
    if (!value.includes(skillId)) {
      onChange([...value, skillId]);
    }
  };

  const handleRemoveSkill = (skillId: string) => {
    onChange(value.filter((id) => id !== skillId));
  };

  // Get skill names for display
  const getSkillName = (skillId: string): string => {
    const skill = skills.find((s) => s.id === skillId);
    return skill?.name ?? skillId;
  };

  // Skills available to add (not yet selected)
  const availableSkills = skills.filter((s) => !value.includes(s.id));

  return (
    <div className="skill-multiselect" data-testid="skill-multiselect">
      {label && (
        <label
          htmlFor={id ? `${id}-select` : undefined}
          className="skill-multiselect-label"
        >
          {label}
        </label>
      )}

      {/* Selected skill chips */}
      {value.length > 0 && (
        <div className="skill-multiselect-chips" data-testid="skill-chips">
          {value.map((skillId) => (
            <span key={skillId} className="skill-chip" data-testid={`skill-chip-${skillId}`}>
              <span className="skill-chip-name">{getSkillName(skillId)}</span>
              <button
                type="button"
                className="skill-chip-remove"
                onClick={() => handleRemoveSkill(skillId)}
                disabled={disabled}
                aria-label={`Remove ${getSkillName(skillId)}`}
                data-testid={`remove-skill-${skillId}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Dropdown to add skills */}
      <div className="skill-multiselect-add">
        {isLoading ? (
          <span className="skill-multiselect-loading" data-testid="skills-loading">
            Loading skills…
          </span>
        ) : availableSkills.length === 0 ? (
          <span className="skill-multiselect-empty" data-testid="skills-empty">
            {value.length === 0 ? "No skills discovered" : "All skills selected"}
          </span>
        ) : (
          <select
            id={id ? `${id}-select` : undefined}
            className="select skill-multiselect-dropdown"
            value=""
            onChange={(e) => {
              if (e.target.value) {
                handleAddSkill(e.target.value);
                // Reset to placeholder
                e.target.value = "";
              }
            }}
            disabled={disabled}
            data-testid="skill-dropdown"
          >
            <option value="">Add a skill…</option>
            {availableSkills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
