import "./WorkflowSwitcher.css";

import { ChevronDown, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { BoardWorkflowDefinition } from "../api";
import { WorkflowIcon } from "./WorkflowIcon";
import type { WorkflowStatusCounts } from "./workflowStatusCounts";

export interface WorkflowSwitcherAggregateOption {
  id: string;
  name: string;
}

export interface WorkflowSwitcherProps {
  workflows: BoardWorkflowDefinition[];
  value: string;
  onChange: (id: string) => void;
  counts: Map<string, WorkflowStatusCounts>;
  /** Optional dashboard-only aggregate view. It is rendered before real workflows and is never editable. */
  aggregateOption?: WorkflowSwitcherAggregateOption;
  /** Fired each time the dropdown transitions from closed to open so consumers can refresh count data. */
  onOpen?: () => void;
  label?: string;
  onEditWorkflow?: (workflowId: string) => void;
  onCreateWorkflow?: () => void;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const ZERO_COUNTS: WorkflowStatusCounts = { todo: 0, inProgress: 0, done: 0, merging: 0 };
const DEFAULT_MENU_HORIZONTAL_PADDING = 16;
const DEFAULT_MENU_MIN_WIDTH = 240;

/**
 * FNXC:WorkflowSwitcher 2026-06-21-18:34:
 * The open listbox must expose full workflow names for comparison while the collapsed trigger remains intentionally narrow and ellipsized.
 * Size the menu from measured name content plus option decorations, then clamp to the viewport so the trigger width can prevent shrinking but cannot force long names to stay truncated.
 * OPTION_DECORATIONS_WIDTH budgets the option row padding/gaps, three count badges plus separators, an optional btn-icon edit affordance, and scrollbar allowance from the existing token-sized CSS.
 */
export const OPTION_DECORATIONS_WIDTH = 200;

export interface ComputeMenuWidthInput {
  longestNameWidth: number;
  triggerWidth: number;
  viewportWidth: number;
  horizontalPadding?: number;
  minWidth?: number;
}

export function computeMenuWidth({
  longestNameWidth,
  triggerWidth,
  viewportWidth,
  horizontalPadding = DEFAULT_MENU_HORIZONTAL_PADDING,
  minWidth = DEFAULT_MENU_MIN_WIDTH,
}: ComputeMenuWidthInput): number {
  const contentWidth = Math.max(0, longestNameWidth) + OPTION_DECORATIONS_WIDTH;
  const desired = Math.max(triggerWidth, contentWidth, minWidth);
  return Math.min(desired, viewportWidth - horizontalPadding * 2);
}

function getCounts(counts: Map<string, WorkflowStatusCounts>, workflowId: string): WorkflowStatusCounts {
  return counts.get(workflowId) ?? ZERO_COUNTS;
}

function getWorkflowIconValue(workflow: WorkflowSwitcherAggregateOption | BoardWorkflowDefinition): string | undefined {
  return "icon" in workflow ? workflow.icon : undefined;
}

/**
 * FNXC:WorkflowSwitcher 2026-06-20-00:09:
 * The board/list workflow switcher must be a fully rendered themed dropdown rather than a native select so each workflow option can include compact inline Todo, In Progress, and Done counts.
 * The component owns only presentation and accessible dropdown behavior; all status-bucket semantics stay in computeWorkflowStatusCounts so Board and ListView cannot drift.
 *
 * FNXC:WorkflowSwitcher 2026-06-20-00:31:
 * Counts are contextual detail, so the collapsed trigger must stay visually and accessibly scoped to the active workflow name plus chevron.
 * Render Todo, In Progress, and Done counts only while the dropdown is expanded; option rows keep their count text because the listbox is the comparison surface.
 *
 * FNXC:WorkflowSwitcher 2026-06-20-15:34:
 * Workflow edit and creation affordances moved into the shared dropdown so Board and ListView cannot leave separate toolbar icon shells behind.
 * Each option row owns a sibling edit button, and New workflow remains visible in a non-scrolling footer while long workflow lists scroll.
 *
 * FNXC:WorkflowSwitcher 2026-06-21-00:00:
 * Opening the dropdown must refresh workflow count data because task-to-workflow assignments do not emit board-workflows invalidation events.
 * Fire onOpen only on closed-to-open transitions so consumers can refetch without close-time calls or render loops.
 */
export function WorkflowSwitcher({ workflows, value, onChange, counts, aggregateOption, onOpen, label: labelProp, onEditWorkflow, onCreateWorkflow }: WorkflowSwitcherProps) {
  const { t } = useTranslation("app");
  const label = labelProp ?? t("workflowSwitcher.label", "Workflow");
  const todoLabel = t("workflowSwitcher.todo", "Todo");
  const inProgressLabel = t("workflowSwitcher.inProgress", "In Progress");
  const doneLabel = t("workflowSwitcher.done", "Done");
  const mergingLabel = t("workflowSwitcher.merging", "Merging");
  const editWorkflowLabel = t("workflowSwitcher.editWorkflow", "Edit workflow");
  const newWorkflowLabel = t("workflowSwitcher.newWorkflow", "New workflow");
  const listboxId = useId();

  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const measurementCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const onOpenRef = useRef(onOpen);

  const switcherOptions = useMemo(() => {
    /*
    FNXC:WorkflowSwitcher 2026-06-29-16:00:
    The Board can expose a dashboard-only "All workflows" filter before real workflows, but that sentinel is not a backend workflow id and must never receive workflow edit affordances.
    Keep the aggregate option in this presentation layer so real workflow sorting, counts, create/edit actions, and durable selection semantics remain owned by the existing Board/useBoardWorkflows path.
    */
    return aggregateOption ? [aggregateOption, ...workflows] : workflows;
  }, [aggregateOption, workflows]);
  const selectedIndex = useMemo(() => Math.max(0, switcherOptions.findIndex((workflow) => workflow.id === value)), [value, switcherOptions]);
  const selectedWorkflow = switcherOptions[selectedIndex] ?? switcherOptions[0] ?? null;
  const selectedCounts = selectedWorkflow ? getCounts(counts, selectedWorkflow.id) : ZERO_COUNTS;

  const measureLongestOptionNameWidth = useCallback((names: string[]) => {
    const trigger = triggerRef.current;
    if (!trigger) return 0;
    const canvas = measurementCanvasRef.current ?? document.createElement("canvas");
    measurementCanvasRef.current = canvas;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    context.font = getComputedStyle(trigger).font;
    return names.reduce((longestWidth, name) => Math.max(longestWidth, context.measureText(name).width), 0);
  }, []);

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const offsetTop = window.visualViewport?.offsetTop ?? 0;
    const offsetLeft = window.visualViewport?.offsetLeft ?? 0;
    const horizontalPadding = DEFAULT_MENU_HORIZONTAL_PADDING;
    const verticalPadding = 16;
    const gap = 4;
    const preferredHeight = Math.min(viewportHeight * 0.6, 320);
    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;
    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;
    const availableHeight = Math.max((openUpward ? spaceAbove : spaceBelow) - verticalPadding - gap, 160);
    const maxHeight = Math.max(Math.min(availableHeight, preferredHeight), 160);
    const longestNameWidth = measureLongestOptionNameWidth(switcherOptions.map((workflow) => workflow.name));
    const width = computeMenuWidth({ longestNameWidth, triggerWidth: rect.width, viewportWidth, horizontalPadding });
    const left = Math.min(Math.max(triggerLeft, horizontalPadding), viewportWidth - horizontalPadding - width) + offsetLeft;
    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - maxHeight - gap + offsetTop)
      : Math.min(triggerBottom + gap + offsetTop, viewportHeight + offsetTop - verticalPadding - maxHeight);

    setDropdownPosition({ top, left, width, maxHeight });
  }, [measureLongestOptionNameWidth, switcherOptions]);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setHighlightedIndex(selectedIndex);
    updateDropdownPosition();
  }, [isOpen, selectedIndex, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handleReposition = () => updateDropdownPosition();
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", handleReposition);
    visualViewport?.addEventListener("scroll", handleReposition);
    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      visualViewport?.removeEventListener("resize", handleReposition);
      visualViewport?.removeEventListener("scroll", handleReposition);
    };
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const highlightedElement = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
    if (highlightedElement && typeof highlightedElement.scrollIntoView === "function") {
      highlightedElement.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, isOpen]);

  const openDropdown = useCallback(() => {
    if (isOpen) return;
    onOpenRef.current?.();
    setIsOpen(true);
  }, [isOpen]);

  const toggleDropdown = useCallback(() => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    onOpenRef.current?.();
    setIsOpen(true);
  }, [isOpen]);

  const selectWorkflow = useCallback((workflowId: string) => {
    onChange(workflowId);
    setIsOpen(false);
    triggerRef.current?.focus();
  }, [onChange]);

  const handleEditWorkflow = useCallback((workflowId: string) => {
    if (!onEditWorkflow) return;
    setIsOpen(false);
    onEditWorkflow(workflowId);
  }, [onEditWorkflow]);

  const handleCreateWorkflow = useCallback(() => {
    if (!onCreateWorkflow) return;
    setIsOpen(false);
    onCreateWorkflow();
  }, [onCreateWorkflow]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) {
          openDropdown();
        } else {
          setHighlightedIndex((current) => (switcherOptions.length ? (current + 1) % switcherOptions.length : 0));
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!isOpen) {
          openDropdown();
        } else {
          setHighlightedIndex((current) => (switcherOptions.length ? (current - 1 + switcherOptions.length) % switcherOptions.length : 0));
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (isOpen) {
          const workflow = switcherOptions[highlightedIndex];
          if (workflow) selectWorkflow(workflow.id);
        } else {
          openDropdown();
        }
        break;
      case "Escape":
        event.preventDefault();
        setIsOpen(false);
        break;
      case "Tab":
        setIsOpen(false);
        break;
    }
  }, [highlightedIndex, isOpen, openDropdown, selectWorkflow, switcherOptions]);

  if (!selectedWorkflow) return null;

  const renderCountBadges = (workflowCounts: WorkflowStatusCounts, variant: "trigger" | "option") => (
    <span className={`workflow-switcher-counts workflow-switcher-counts--${variant}`} aria-hidden="true">
      {workflowCounts.merging > 0 ? (
        <span
          className="workflow-switcher-merging-indicator"
          title={t("workflowSwitcher.mergingTitle", "{{count}} merging", { count: workflowCounts.merging })}
        />
      ) : null}
      <span className="workflow-switcher-count workflow-switcher-count--todo" title={`${todoLabel}: ${workflowCounts.todo}`}>{workflowCounts.todo}</span>
      <span className="workflow-switcher-count-separator">·</span>
      <span className="workflow-switcher-count workflow-switcher-count--in-progress" title={`${inProgressLabel}: ${workflowCounts.inProgress}`}>{workflowCounts.inProgress}</span>
      <span className="workflow-switcher-count-separator">·</span>
      <span className="workflow-switcher-count workflow-switcher-count--done" title={`${doneLabel}: ${workflowCounts.done}`}>{workflowCounts.done}</span>
    </span>
  );

  const renderAccessibleCounts = (workflowCounts: WorkflowStatusCounts) => (
    <span className="visually-hidden">
      {t("workflowSwitcher.countsAria", "{{todoLabel}}: {{todo}}, {{inProgressLabel}}: {{inProgress}}, {{doneLabel}}: {{done}}{{mergingSuffix}}", {
        todoLabel,
        todo: workflowCounts.todo,
        inProgressLabel,
        inProgress: workflowCounts.inProgress,
        doneLabel,
        done: workflowCounts.done,
        mergingSuffix: workflowCounts.merging > 0 ? `, ${mergingLabel}: ${workflowCounts.merging}` : "",
      })}
    </span>
  );

  const dropdown = isOpen && portalRoot && dropdownPosition
    ? createPortal(
      <div
        ref={dropdownRef}
        id={listboxId}
        className="workflow-switcher-menu"
        role="listbox"
        aria-label={label}
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          width: dropdownPosition.width,
          maxHeight: dropdownPosition.maxHeight,
        }}
      >
        <div ref={listRef} className="workflow-switcher-options">
          {switcherOptions.map((workflow, index) => {
            const workflowCounts = getCounts(counts, workflow.id);
            const isSelected = workflow.id === selectedWorkflow.id;
            const isHighlighted = index === highlightedIndex;
            const isAggregateOption = aggregateOption?.id === workflow.id;
            return (
              <div
                key={workflow.id}
                className={`workflow-switcher-option-row${isSelected ? " workflow-switcher-option-row--selected" : ""}${isHighlighted ? " workflow-switcher-option-row--highlighted" : ""}`}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-index={index}
                  data-testid={`workflow-switcher-option-${workflow.id}`}
                  className="workflow-switcher-option"
                  onClick={() => selectWorkflow(workflow.id)}
                >
                  <span className="workflow-switcher-option-label">
                    <WorkflowIcon workflowId={workflow.id} icon={getWorkflowIconValue(workflow)} decorative />
                    <span className="workflow-switcher-option-name">{workflow.name}</span>
                  </span>
                  {renderCountBadges(workflowCounts, "option")}
                  {renderAccessibleCounts(workflowCounts)}
                </button>
                {onEditWorkflow && !isAggregateOption ? (
                  <button
                    type="button"
                    className="btn btn-icon btn-sm workflow-switcher-edit"
                    data-testid={`workflow-switcher-edit-${workflow.id}`}
                    aria-label={editWorkflowLabel}
                    title={editWorkflowLabel}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleEditWorkflow(workflow.id);
                    }}
                  >
                    <Pencil aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {onCreateWorkflow ? (
          <div className="workflow-switcher-footer">
            <button
              type="button"
              className="btn workflow-switcher-create"
              data-testid="workflow-switcher-create"
              onClick={handleCreateWorkflow}
            >
              <Plus aria-hidden="true" />
              <span>{newWorkflowLabel}</span>
            </button>
          </div>
        ) : null}
      </div>,
      portalRoot,
    )
    : null;

  return (
    <div ref={containerRef} className="workflow-switcher">
      <span className="workflow-switcher-label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="btn workflow-switcher-trigger"
        data-testid="workflow-switcher"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-label={t("workflowSwitcher.triggerAria", "Select workflow. Current workflow: {{name}}", { name: selectedWorkflow.name })}
        onClick={toggleDropdown}
        onKeyDown={handleKeyDown}
      >
        <span className="workflow-switcher-trigger-main">
          <span className="workflow-switcher-current-label">
            <WorkflowIcon workflowId={selectedWorkflow.id} icon={getWorkflowIconValue(selectedWorkflow)} decorative />
            <span className="workflow-switcher-current-name">{selectedWorkflow.name}</span>
          </span>
          {isOpen ? renderCountBadges(selectedCounts, "trigger") : null}
          {isOpen ? renderAccessibleCounts(selectedCounts) : null}
        </span>
        <ChevronDown size={14} className="workflow-switcher-chevron" aria-hidden="true" />
      </button>
      {dropdown}
    </div>
  );
}
