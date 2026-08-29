/**
 * FNXC:WorkflowOptionalSteps 2026-06-21-00:00:
 * Users selecting optional workflow steps at task creation need one consistent
 * multi-select control across every creation surface, with full keyboard + screen-
 * reader support, so the quick-add card and the full New Task modal behave identically.
 *
 * WorkflowOptionalStepsDropdown — a controlled multi-select for a workflow's
 * optional steps, shared by the quick-add card (U5) and the full New Task modal
 * (U4) so both creation surfaces present the same interaction.
 *
 * Controlled: the parent owns the enabled set (`enabledIds`) and seeds it from
 * each step's `defaultOn`; this component owns only open/close UI state. The panel
 * renders through a portal so it is not clipped by a modal's overflow boundary.
 *
 * Empty state (committed): renders nothing when there are no optional steps —
 * matching the quick-add card's prior no-chip-block behavior and the modal's
 * empty-state choice, so both surfaces look identical.
 *
 * FNXC:TaskCreationButtons 2026-06-25-00:00:
 * The optional-steps trigger must reuse shared `.btn .btn-sm` styling so it has
 * the same padding, background, border, radius, and interaction affordances as
 * the quick-add and New Task action buttons on every creation surface.
 *
 * Accessibility: trigger has aria-haspopup/aria-expanded; the panel is a
 * role="listbox" labelled by the trigger; each option is a role="option" with
 * aria-checked. Escape closes and refocuses the trigger; arrow keys move the
 * active option; outside-click closes.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { ResolvedWorkflowOptionalStep } from "@fusion/core";
import { phaseBadge } from "./workflow-phase-badge";
import "./WorkflowOptionalStepsDropdown.css";

interface WorkflowOptionalStepsDropdownProps {
  steps: ResolvedWorkflowOptionalStep[];
  enabledIds: string[];
  onToggle: (templateId: string) => void;
  disabled?: boolean;
  /** Test/styling hook applied to the trigger. */
  triggerTestId?: string;
}

interface PanelPosition {
  top: number;
  left: number;
  width: number;
}

export function WorkflowOptionalStepsDropdown({
  steps,
  enabledIds,
  onToggle,
  disabled = false,
  triggerTestId = "wf-optional-steps-dropdown-trigger",
}: WorkflowOptionalStepsDropdownProps) {
  const { t } = useTranslation("app");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const labelId = useId();

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  }, []);

  // Reposition on open and keep anchored during scroll/resize.
  useEffect(() => {
    if (!isOpen) return;
    reposition();
    const handle = () => reposition();
    window.addEventListener("resize", handle);
    window.addEventListener("scroll", handle, true);
    return () => {
      window.removeEventListener("resize", handle);
      window.removeEventListener("scroll", handle, true);
    };
  }, [isOpen, reposition]);

  // Outside-click closes (capture so it fires before the trigger's own handler).
  useEffect(() => {
    if (!isOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [isOpen]);

  const close = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Focus the active option when the panel opens or the active index changes —
  // driven by an effect (not an inline ref callback) so a re-render from toggling
  // a step does not steal focus back to the active option on every commit.
  useEffect(() => {
    if (isOpen && position) optionRefs.current[activeIndex]?.focus();
  }, [isOpen, position, activeIndex]);

  // Empty state: render nothing (committed behavior, shared with the modal).
  if (steps.length === 0) return null;

  const selectedCount = steps.filter((s) => enabledIds.includes(s.templateId)).length;
  const triggerLabel =
    selectedCount === 0
      ? t("workflowOptionalSteps.triggerNone", "Steps: none")
      : t("workflowOptionalSteps.triggerCount", "Steps: {{count}} selected", { count: selectedCount });

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    // ArrowUp also opens (ARIA listbox authoring guidance), landing on the last option.
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setIsOpen(true);
      setActiveIndex(e.key === "ArrowUp" ? steps.length - 1 : 0);
    }
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, steps.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const step = steps[activeIndex];
      if (step) onToggle(step.templateId);
    }
  };

  return (
    <div className="wf-optional-steps-dropdown">
      <button
        ref={triggerRef}
        type="button"
        id={labelId}
        className="btn btn-sm wf-optional-steps-dropdown-trigger"
        data-testid={triggerTestId}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
        onClick={() => {
          setIsOpen((o) => !o);
          setActiveIndex(0);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={12} aria-hidden />
      </button>

      {isOpen &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            className="wf-optional-steps-dropdown-panel"
            role="listbox"
            aria-multiselectable="true"
            aria-label={t("workflowOptionalSteps.title", "Optional steps")}
            data-testid="wf-optional-steps-dropdown-panel"
            style={{ top: position.top, left: position.left, minWidth: position.width }}
            onKeyDown={onPanelKeyDown}
          >
            {steps.map((step, i) => {
              const checked = enabledIds.includes(step.templateId);
              return (
                <div
                  key={step.templateId}
                  role="option"
                  aria-checked={checked}
                  tabIndex={i === activeIndex ? 0 : -1}
                  ref={(el) => {
                    optionRefs.current[i] = el;
                  }}
                  className={`wf-optional-steps-dropdown-option${i === activeIndex ? " is-active" : ""}`}
                  data-testid={`wf-optional-steps-dropdown-option-${step.templateId}`}
                  onClick={() => onToggle(step.templateId)}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    tabIndex={-1}
                    readOnly
                    aria-hidden
                  />
                  <div className="wf-optional-steps-dropdown-option-body">
                    <span className="wf-optional-steps-dropdown-option-name">
                      {step.name}
                      {phaseBadge(step.phase, step.templateId, "wf-optional-steps-dropdown-phase", t)}
                    </span>
                    {step.description && (
                      <span className="wf-optional-steps-dropdown-option-desc">{step.description}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

export default WorkflowOptionalStepsDropdown;
