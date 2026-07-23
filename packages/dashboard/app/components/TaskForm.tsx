import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, type GlobalSettings, type Task, type TaskPriority, type Settings, type WorkflowDefinition, type ResolvedWorkflowOptionalStep } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { fetchModels, fetchSettings, fetchWorkflows, fetchWorkflowOptionalSteps, refineText, getRefineErrorMessage, updateGlobalSettings, fetchGlobalSettings, fetchGitBranches, type RefinementType, type ModelInfo, type NodeInfo } from "../api";
import { WorkflowOptionalStepsDropdown } from "./WorkflowOptionalStepsDropdown";
import { applyPresetToSelection, getRecommendedPresetForSize } from "../utils/modelPresets";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { NodeHealthDot } from "./NodeHealthDot";
import { LoadingSpinner } from "./LoadingSpinner";
import { Sparkles, ChevronUp, ChevronDown, Maximize2, Minimize2, Paperclip, Zap, Brain, Server } from "lucide-react";
import { REPO_OVERRIDE_RE, resolveEffectiveGithubRepoDefault } from "./githubTracking";
import { getPriorityColorVar, getPriorityIcon, getPriorityLabel } from "../utils/priorityIndicator";
import { ProviderIcon } from "./ProviderIcon";
import { WorkflowIcon } from "./WorkflowIcon";
import { PendingAttachmentPreviews } from "./PendingAttachmentPreviews";

function getNodeStatusLabel(status: NodeInfo["status"], t: (key: string, defaultValue: string) => string): string {
  if (status === "online") return t("taskForm.nodeStatusOnline", "Online");
  if (status === "connecting") return t("taskForm.nodeStatusConnecting", "Connecting");
  if (status === "error") return t("taskForm.nodeStatusError", "Error");
  return t("taskForm.nodeStatusOffline", "Offline");
}

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const COMMON_INTEGRATION_BRANCHES = ["main", "master", "trunk", "develop"];
const CUSTOM_BRANCH_OPTION = "__fusion-custom__";
const DEFAULT_BRANCH_OPTION = "";

function sortBranchNames(branches: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of COMMON_INTEGRATION_BRANCHES) {
    if (branches.includes(name) && !seen.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  for (const name of [...branches].sort((a, b) => a.localeCompare(b))) {
    if (seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }
  return ordered;
}

/** Renders a phase badge using shared .phase-badge classes for consistency */

export interface PendingImage {
  file: File;
  previewUrl: string;
}

type TaskExecutionModeSelection = "standard" | "fast";
export type BranchSelectionMode = "project-default" | "auto-new" | "existing" | "custom-new" | "shared-group";
export interface EnabledWorkflowStepsChangeMeta {
  optionalStepsAvailable: boolean;
}

const PRESET_OPTION_SEPARATOR = "──────────";

export interface TaskFormProps {
  mode: "create" | "edit";

  // Core fields
  description: string;
  onDescriptionChange: (value: string) => void;
  title?: string;
  onTitleChange?: (value: string) => void;

  // Dependencies
  dependencies: string[];
  onDependenciesChange: (deps: string[]) => void;
  branch?: string;
  onBranchChange?: (value: string) => void;
  branchMode?: BranchSelectionMode;
  onBranchModeChange?: (value: BranchSelectionMode) => void;
  baseBranch?: string;
  onBaseBranchChange?: (value: string) => void;
  nodeId?: string;
  onNodeIdChange?: (nodeId: string | undefined) => void;
  nodeOptions?: NodeInfo[];
  nodeOverrideDisabled?: boolean;
  nodeOverrideDisabledReason?: string;

  // Model configuration
  priority?: TaskPriority;
  onPriorityChange?: (value: TaskPriority) => void;
  executorModel: string;
  onExecutorModelChange: (value: string) => void;
  validatorModel: string;
  onValidatorModelChange: (value: string) => void;
  planningModel?: string;
  onPlanningModelChange?: (value: string) => void;
  thinkingLevel?: string;
  onThinkingLevelChange?: (value: string) => void;
  /*
   * FNXC:PlannerOversight 2026-07-04-00:00:
   * Per-task override selector for the workflow-native `plannerOversightLevel` setting
   * (FN-7508). Empty string ("") means "inherit from workflow" — the task uses the
   * default workflow's effective `plannerOversightLevel` value. The four non-empty
   * values (off/observe/steer/autonomous) mirror `BUILTIN_OVERSIGHT_SETTINGS` verbatim.
   * This control is configuration only; runtime oversight controls (quick change,
   * manual nudge, stop, explain-current-action) are FN-7517, not this task.
   */
  plannerOversightLevel?: string;
  onPlannerOversightLevelChange?: (value: string) => void;
  presetMode: "default" | "preset" | "custom";
  onPresetModeChange: (mode: "default" | "preset" | "custom") => void;
  selectedPresetId: string;
  onSelectedPresetIdChange: (id: string) => void;

  // Workflow selection (U6/R3). The form picks a whole workflow (not individual
  // steps), applied atomically at task creation via the create-time `workflowId`.
  //  - `undefined` → inherit the project default (preselected + "(default)" badge).
  //  - `null`      → "No workflow" (listed first).
  //  - `string`    → a specific workflow id.
  // The dropdown only renders when `onWorkflowIdChange` is provided (create mode).
  selectedWorkflowId?: string | null;
  onWorkflowIdChange?: (workflowId: string | null) => void;
  /*
   * FNXC:WorkflowOptionalSteps 2026-07-10-00:00:
   * Edit mode needs the task's resolved workflow id to fetch the optional-step catalog without enabling workflow selection in the edit form. This id is catalog-only: create mode still resolves from selectedWorkflowId/default workflow and remains the only path that seeds defaultOn steps.
   */
  optionalStepsWorkflowId?: string | null;
  // Optional workflow steps the task can opt into. TaskForm fetches + seeds these
  // from the selected workflow's `defaultOn` in create mode, while edit mode only
  // mutates the provided task-specific ids.
  enabledWorkflowSteps?: string[];
  onEnabledWorkflowStepsChange?: (ids: string[], meta?: EnabledWorkflowStepsChangeMeta) => void;

  // Attachments
  pendingImages: PendingImage[];
  onImagesChange: (images: PendingImage[]) => void;

  // Context
  tasks: Task[];
  projectId?: string;
  disabled?: boolean;
  addToast: (message: string, type?: ToastType) => void;
  isActive?: boolean;

  // Auto-save callback (edit mode)
  onAutoSaveDescription?: (description: string) => Promise<void>;

  // Review level (0=None, 1=Plan Only, 2=Plan and Code, 3=Full)
  reviewLevel?: number;
  onReviewLevelChange?: (value: number | undefined) => void;
  autoMerge?: boolean | undefined;
  onAutoMergeChange?: (value: boolean | undefined) => void;
  executionMode?: TaskExecutionModeSelection;
  onExecutionModeChange?: (value: TaskExecutionModeSelection) => void;
  githubTrackingEnabled?: boolean;
  onGithubTrackingEnabledChange?: (value: boolean) => void;
  githubRepoOverride?: string;
  onGithubRepoOverrideChange?: (value: string) => void;

  // AI-assisted creation callbacks (create mode only)
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
  onClose?: () => void;

  // Create-mode primary submission. NewTaskModal owns duplicate checks and payload shaping;
  // TaskForm only places the visible Create affordance in the quick-action row.
  onCreateSubmit?: () => void;
  createSubmitLabel?: string;
  createSubmitDisabled?: boolean;

  /** Optional content to render between the primary section and the "More options" toggle. */
  renderBelowPrimary?: React.ReactNode;
  /** Optional content to render inside "More options" below Model Configuration. */
  renderBelowModelConfiguration?: React.ReactNode;
  /** When true, skip rendering the Dependencies form-group inside "More options". Use when the parent renders its own dependency UI via renderBelowPrimary. */
  hideDependencies?: boolean;
  /** When true (default), More options auto-expands when non-default advanced selections are present. */
  autoExpandMoreOptionsOnSelection?: boolean;
  /**
   * FNXC:NewTask 2026-06-22-20:30:
   * When true, the advanced controls disclosure is always shown — the collapsible disclosure is force-open and its toggle is hidden. Other surfaces keep the default collapsed disclosure.
   *
   * FNXC:NewTask 2026-06-23-00:10:
   * The New Task dialog NO LONGER forces this open. The deep/advanced options (model selectors, branch/base, node, review level, GitHub tracking, etc.) are collapsed by default behind the "Advanced" disclosure; only the common quick-add buttons (Attach, Fast, Priority) are surfaced inline next to Plan. This prop remains for any caller that still wants every advanced control un-collapsed.
   */
  forceMoreOptionsOpen?: boolean;
}

export function TaskForm({
  mode,
  description,
  onDescriptionChange,
  title,
  onTitleChange,
  dependencies,
  onDependenciesChange,
  branch,
  onBranchChange,
  branchMode,
  onBranchModeChange,
  baseBranch,
  onBaseBranchChange,
  nodeId,
  onNodeIdChange,
  nodeOptions,
  nodeOverrideDisabled = false,
  nodeOverrideDisabledReason,
  priority,
  onPriorityChange,
  executorModel,
  onExecutorModelChange,
  validatorModel,
  onValidatorModelChange,
  planningModel,
  onPlanningModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  plannerOversightLevel,
  onPlannerOversightLevelChange,
  presetMode,
  onPresetModeChange,
  selectedPresetId,
  onSelectedPresetIdChange,
  selectedWorkflowId,
  onWorkflowIdChange,
  optionalStepsWorkflowId,
  enabledWorkflowSteps,
  onEnabledWorkflowStepsChange,
  pendingImages,
  onImagesChange,
  tasks,
  projectId,
  disabled = false,
  addToast,
  isActive = true,
  onAutoSaveDescription,
  onPlanningMode,
  onSubtaskBreakdown,
  onClose,
  onCreateSubmit,
  createSubmitLabel,
  createSubmitDisabled,
  renderBelowPrimary,
  renderBelowModelConfiguration,
  hideDependencies,
  autoExpandMoreOptionsOnSelection = true,
  forceMoreOptionsOpen = false,
  reviewLevel,
  onReviewLevelChange,
  autoMerge,
  onAutoMergeChange,
  executionMode,
  onExecutionModeChange,
  githubTrackingEnabled,
  onGithubTrackingEnabledChange,
  githubRepoOverride,
  onGithubRepoOverrideChange,
}: TaskFormProps) {
  const { t } = useTranslation("app");
  const hasInitialMoreOptions =
    (hideDependencies ? false : dependencies.length > 0) ||
    pendingImages.length > 0 ||
    presetMode !== "default" ||
    (priority ?? DEFAULT_TASK_PRIORITY) !== DEFAULT_TASK_PRIORITY ||
    executorModel !== "" ||
    validatorModel !== "" ||
    (planningModel || "") !== "" ||
    (thinkingLevel || "") !== "" ||
    (plannerOversightLevel || "") !== "" ||
    reviewLevel !== undefined ||
    autoMerge !== undefined ||
    executionMode === "fast" ||
    (branch || "") !== "" ||
    (baseBranch || "") !== "" ||
    (nodeId || "") !== "" ||
    (mode === "edit" && (enabledWorkflowSteps?.length ?? 0) > 0) ||
    githubTrackingEnabled === true ||
    (githubRepoOverride || "") !== "";

  const [showDepDropdown, setShowDepDropdown] = useState(false);
  const [showWorkflowDropdown, setShowWorkflowDropdown] = useState(false);
  const executionModeRef = useRef(executionMode);
  useEffect(() => {
    executionModeRef.current = executionMode;
  }, [executionMode]);
  const [showMoreOptions, setShowMoreOptions] = useState(
    autoExpandMoreOptionsOnSelection ? hasInitialMoreOptions : false,
  );
  // FNXC:NewTask 2026-06-22-20:30: When force-open (New Task dialog), the advanced section is always expanded regardless of the local disclosure toggle.
  const moreOptionsOpen = forceMoreOptionsOpen || showMoreOptions;
  const [depSearch, setDepSearch] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
  // U6/R3: full workflow definitions for the picker (fragments excluded below).
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [optionalSteps, setOptionalSteps] = useState<ResolvedWorkflowOptionalStep[]>([]);
  const [optionalStepsLoading, setOptionalStepsLoading] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [baseBranchOptions, setBaseBranchOptions] = useState<string[]>([]);
  const [baseBranchCustomMode, setBaseBranchCustomMode] = useState(false);

  // AI Refinement state
  const [isRefineMenuOpen, setIsRefineMenuOpen] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  const refineMenuRef = useRef<HTMLDivElement>(null);

  const depDropdownRef = useRef<HTMLDivElement>(null);
  const workflowDropdownRef = useRef<HTMLDivElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAutoSavingRef = useRef(false);
  const hadMoreOptionSelectionsRef = useRef(hasInitialMoreOptions);
  const initialDescriptionRef = useRef(description.trim());
  const lastAutoSavedDescriptionRef = useRef(description.trim());

  // Load available models, settings, workflow steps when active
  useEffect(() => {
    if (!isActive) return;
    setModelsLoading(true);
    fetchModels()
      .then((response) => {
        setAvailableModels(response.models);
        setFavoriteProviders(response.favoriteProviders);
        setFavoriteModels(response.favoriteModels);
      })
      .catch(() => {/* silently fail */})
      .finally(() => setModelsLoading(false));
    fetchSettings(projectId)
      .then((nextSettings) => setSettings(nextSettings))
      .catch(() => setSettings(null));
    // U6/R3: load selectable workflows for the picker. Fragments are excluded
    // (KTD-1) so they never appear as selectable task workflows.
    if (onWorkflowIdChange) {
      setWorkflowsLoading(true);
      fetchWorkflows(projectId)
        .then((defs) => setWorkflows(defs.filter((d) => d.kind !== "fragment")))
        .catch(() => setWorkflows([]))
        .finally(() => setWorkflowsLoading(false));
    }
    fetchGlobalSettings()
      .then((nextGlobalSettings) => setGlobalSettings(nextGlobalSettings))
      .catch(() => setGlobalSettings(null));
  }, [isActive, projectId, onWorkflowIdChange]);

  // FNXC:WorkflowOptionalSteps 2026-06-21-00:00:
  // Creating a task should let the user opt into the selected workflow's optional
  // steps, seeded from each step's defaultOn. TaskForm fetches + seeds these in
  // create mode and lifts the enabled set to NewTaskModal for the create payload.
  // Optional workflow steps for the currently-selected workflow (create mode only).
  // `null` selection ("No workflow") → no steps; `undefined` → project default.
  // FNXC:WorkflowOptionalSteps 2026-06-26-05:10:
  // Mirror the executor/store resolution (selection → project default → `builtin:coding`)
  // so `builtin:coding`'s optional steps appear when no project default is configured
  // (FN-7039). Stay `null` until settings load to avoid fetching the wrong workflow first.
  const effectiveOptionalWorkflowId =
    selectedWorkflowId === null
      ? null
      : (selectedWorkflowId ?? settings?.defaultWorkflowId ?? (settings ? "builtin:coding" : null));
  const resolvedOptionalWorkflowId = onWorkflowIdChange ? effectiveOptionalWorkflowId : (optionalStepsWorkflowId ?? null);
  useEffect(() => {
    const isCreateOptionalStepPicker = Boolean(onWorkflowIdChange);
    const isEditOptionalStepPicker = mode === "edit" && Boolean(optionalStepsWorkflowId);
    if (!isCreateOptionalStepPicker && !isEditOptionalStepPicker) return;
    let cancelled = false;
    setOptionalSteps([]);
    if (!resolvedOptionalWorkflowId) {
      // Clear any in-flight loading state (a prior fetch may have been cancelled
      // mid-flight when switching to "No workflow"), so the loading row never sticks.
      setOptionalStepsLoading(false);
      if (isCreateOptionalStepPicker) {
        onEnabledWorkflowStepsChange?.([], { optionalStepsAvailable: false });
      }
      return;
    }
    setOptionalStepsLoading(true);
    fetchWorkflowOptionalSteps(resolvedOptionalWorkflowId, projectId)
      .then((steps) => {
        if (cancelled) return;
        setOptionalSteps(steps);
        if (isCreateOptionalStepPicker) {
          /*
          FNXC:FastOptionalSteps 2026-06-30-10:25:
          Optional-step fetches race user mode changes. When the latest mode is Fast, seed an explicit empty set after loading instead of defaultOn ids so async workflow metadata cannot re-enable optional gates the operator has not manually reselected.
          */
          const seededSteps = executionModeRef.current === "fast"
            ? []
            : steps.filter((s) => s.defaultOn).map((s) => s.templateId);
          onEnabledWorkflowStepsChange?.(seededSteps, { optionalStepsAvailable: steps.length > 0 });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setOptionalSteps([]);
        if (isCreateOptionalStepPicker) {
          onEnabledWorkflowStepsChange?.([], { optionalStepsAvailable: false });
        }
      })
      .finally(() => {
        if (!cancelled) setOptionalStepsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // onEnabledWorkflowStepsChange intentionally omitted from deps: a new identity
    // each render must not re-trigger the fetch/re-seed (would clobber user toggles).
    // Callers must pass a stable callback (NewTaskModal passes a useState setter).
  }, [onWorkflowIdChange, optionalStepsWorkflowId, mode, resolvedOptionalWorkflowId, projectId]);

  const enabledOptionalStepIds = enabledWorkflowSteps ?? [];
  /*
  FNXC:FastOptionalSteps 2026-06-30-09:08:
  Full-dialog Fast controls share one transition contract: entering fast mode clears currently enabled optional workflow steps exactly once, while the inline dropdown remains active so manual reselection is persisted as explicit create intent.
  */
  const handleExecutionModeChange = useCallback((nextMode: TaskExecutionModeSelection) => {
    onExecutionModeChange?.(nextMode);
    if (nextMode === "fast" && onWorkflowIdChange) {
      onEnabledWorkflowStepsChange?.([], { optionalStepsAvailable: optionalSteps.length > 0 });
    }
  }, [onEnabledWorkflowStepsChange, onExecutionModeChange, onWorkflowIdChange, optionalSteps.length]);

  const toggleOptionalStep = useCallback(
    (templateId: string) => {
      const current = enabledWorkflowSteps ?? [];
      const next = current.includes(templateId)
        ? current.filter((id) => id !== templateId)
        : [...current, templateId];
      onEnabledWorkflowStepsChange?.(next, { optionalStepsAvailable: optionalSteps.length > 0 });
    },
    [enabledWorkflowSteps, onEnabledWorkflowStepsChange, optionalSteps.length],
  );

  const availablePresets = settings?.modelPresets || [];
  const selectedPreset = availablePresets.find((preset) => preset.id === selectedPresetId);
  const effectiveGithubRepoDefault = resolveEffectiveGithubRepoDefault(settings, globalSettings);
  const githubRepoOverrideTrimmed = (githubRepoOverride || "").trim();
  const githubRepoOverrideInvalid = githubRepoOverrideTrimmed.length > 0 && !REPO_OVERRIDE_RE.test(githubRepoOverrideTrimmed);
  const hasMoreOptionSelections =
    (hideDependencies ? false : dependencies.length > 0) ||
    pendingImages.length > 0 ||
    presetMode !== "default" ||
    (priority ?? DEFAULT_TASK_PRIORITY) !== DEFAULT_TASK_PRIORITY ||
    executorModel !== "" ||
    validatorModel !== "" ||
    (planningModel || "") !== "" ||
    (thinkingLevel || "") !== "" ||
    (plannerOversightLevel || "") !== "" ||
    reviewLevel !== undefined ||
    autoMerge !== undefined ||
    executionMode === "fast" ||
    (branch || "") !== "" ||
    (baseBranch || "") !== "" ||
    (nodeId || "") !== "" ||
    (mode === "edit" && (enabledWorkflowSteps?.length ?? 0) > 0) ||
    githubTrackingEnabled === true ||
    (githubRepoOverride || "") !== "";

  // Auto-select preset by size (create mode only)
  useEffect(() => {
    if (mode !== "create" || !isActive || !settings?.autoSelectModelPreset) return;
    const recommended = getRecommendedPresetForSize(undefined, settings.defaultPresetBySize || {}, availablePresets);
    if (recommended) {
      const selection = applyPresetToSelection(recommended);
      onSelectedPresetIdChange(recommended.id);
      onPresetModeChange("preset");
      onExecutorModelChange(selection.executorValue);
      onValidatorModelChange(selection.validatorValue);
    }
  }, [isActive, settings, availablePresets, mode]);

  // U6/R3: the workflow picker preselects the project default (undefined →
  // "(default)"); there is no longer a per-step defaultOn auto-select effect.
  const githubTrackingDefaultAppliedRef = useRef(false);
  useEffect(() => {
    if (mode !== "create" || !isActive) return;
    if (!onGithubTrackingEnabledChange) return;
    if (githubTrackingDefaultAppliedRef.current) return;
    if (!settings) return;

    onGithubTrackingEnabledChange(settings.githubTrackingEnabledByDefault ?? false);
    githubTrackingDefaultAppliedRef.current = true;
  }, [mode, isActive, settings, onGithubTrackingEnabledChange]);

  useEffect(() => {
    if (!isActive || !onBaseBranchChange) return;
    fetchGitBranches(projectId)
      .then((branches) => {
        const names = branches
          .map((branchInfo) => branchInfo.name)
          .filter((name): name is string => typeof name === "string" && name.length > 0);
        setBaseBranchOptions(sortBranchNames(names));
      })
      .catch(() => setBaseBranchOptions([]));
  }, [isActive, onBaseBranchChange, projectId]);

  useEffect(() => {
    if (!isActive) {
      githubTrackingDefaultAppliedRef.current = false;
    }
  }, [isActive]);

  // Auto-expand advanced options when non-default values are present.
  useEffect(() => {
    if (!autoExpandMoreOptionsOnSelection) {
      hadMoreOptionSelectionsRef.current = hasMoreOptionSelections;
      return;
    }

    if (hasMoreOptionSelections && !hadMoreOptionSelectionsRef.current) {
      setShowMoreOptions(true);
    }
    hadMoreOptionSelectionsRef.current = hasMoreOptionSelections;
  }, [hasMoreOptionSelections, autoExpandMoreOptionsOnSelection]);

  // Keep dependency dropdown state clean when advanced options are collapsed.
  useEffect(() => {
    if (moreOptionsOpen) return;
    setShowDepDropdown(false);
    setDepSearch("");
    setShowWorkflowDropdown(false);
  }, [moreOptionsOpen]);

  // Auto-select title input text in edit mode (focus is handled by autoFocus)
  useEffect(() => {
    if (mode !== "edit" || !isActive) return;
    if (titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [mode, isActive]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showDepDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (depDropdownRef.current && !depDropdownRef.current.contains(e.target as Node)) {
        setShowDepDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showDepDropdown]);

  useEffect(() => {
    if (!showWorkflowDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (workflowDropdownRef.current && !workflowDropdownRef.current.contains(e.target as Node)) {
        setShowWorkflowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showWorkflowDropdown]);

  // Exit description fullscreen mode when edit controls are unavailable
  useEffect(() => {
    if (mode !== "edit" || disabled) {
      setIsDescriptionExpanded(false);
    }
  }, [mode, disabled]);

  // Reset auto-save tracking when entering edit mode
  useEffect(() => {
    if (mode !== "edit") {
      setAutoSaveStatus("idle");
      return;
    }
    const trimmed = description.trim();
    initialDescriptionRef.current = trimmed;
    lastAutoSavedDescriptionRef.current = trimmed;
    setAutoSaveStatus("idle");
  }, [mode]);

  // Debounced auto-save for edit mode description changes
  useEffect(() => {
    if (mode !== "edit" || !onAutoSaveDescription || !isActive) return;

    const trimmedDescription = description.trim();
    const initialDescription = initialDescriptionRef.current;

    if (trimmedDescription === initialDescription || trimmedDescription === lastAutoSavedDescriptionRef.current) {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
        autoSaveTimeoutRef.current = null;
      }
      if (!isAutoSavingRef.current) {
        setAutoSaveStatus("idle");
      }
      return;
    }

    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    autoSaveTimeoutRef.current = setTimeout(async () => {
      if (isAutoSavingRef.current) return;

      isAutoSavingRef.current = true;
      setAutoSaveStatus("saving");

      try {
        await onAutoSaveDescription(trimmedDescription);
        lastAutoSavedDescriptionRef.current = trimmedDescription;
        setAutoSaveStatus("saved");

        if (autoSaveStatusTimeoutRef.current) {
          clearTimeout(autoSaveStatusTimeoutRef.current);
        }
        autoSaveStatusTimeoutRef.current = setTimeout(() => {
          setAutoSaveStatus("idle");
          autoSaveStatusTimeoutRef.current = null;
        }, 2000);
      } catch {
        setAutoSaveStatus("idle");
      } finally {
        isAutoSavingRef.current = false;
        autoSaveTimeoutRef.current = null;
      }
    }, 1500);

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
        autoSaveTimeoutRef.current = null;
      }
    };
  }, [mode, description, onAutoSaveDescription, isActive]);

  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
      if (autoSaveStatusTimeoutRef.current) {
        clearTimeout(autoSaveStatusTimeoutRef.current);
      }
    };
  }, []);

  // Close refine menu when clicking outside
  useEffect(() => {
    if (!isRefineMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (refineMenuRef.current && !refineMenuRef.current.contains(e.target as Node)) {
        setIsRefineMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isRefineMenuOpen]);

  // Handle paste for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file && ALLOWED_IMAGE_TYPES.includes(file.type)) {
          e.preventDefault();
          onImagesChange([
            ...pendingImages,
            { file, previewUrl: URL.createObjectURL(file) },
          ]);
          return;
        }
      }
    }
  }, [pendingImages, onImagesChange]);

  // Handle file drop for images
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
        onImagesChange([
          ...pendingImages,
          { file, previewUrl: URL.createObjectURL(file) },
        ]);
        return;
      }
    }
  }, [pendingImages, onImagesChange]);

  const removeImage = useCallback((index: number) => {
    const removed = pendingImages[index];
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    onImagesChange(pendingImages.filter((_, i) => i !== index));
  }, [pendingImages, onImagesChange]);

  const toggleDep = useCallback((id: string) => {
    onDependenciesChange(
      dependencies.includes(id) ? dependencies.filter((d) => d !== id) : [...dependencies, id],
    );
  }, [dependencies, onDependenciesChange]);

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  // Auto-resize textarea
  const handleDescriptionInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onDescriptionChange(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [onDescriptionChange]);

  const handleToggleDescriptionExpand = useCallback(() => {
    setIsDescriptionExpanded((prev) => !prev);
  }, []);

  const handleDescriptionFullscreenKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isDescriptionExpanded || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    setIsDescriptionExpanded(false);
  }, [isDescriptionExpanded]);

  // AI Refinement handler
  const handleRefine = useCallback(async (type: RefinementType) => {
    const trimmed = description.trim();
    if (!trimmed || isRefining) return;

    setIsRefining(true);
    try {
      const refined = await refineText(trimmed, type, projectId);
      onDescriptionChange(refined);
      setIsRefineMenuOpen(false);
      addToast(t("taskForm.descriptionRefinedToast", "Description refined with AI"), "success");
      if (descTextareaRef.current) {
        descTextareaRef.current.style.height = "auto";
        descTextareaRef.current.style.height = descTextareaRef.current.scrollHeight + "px";
      }
    } catch (err) {
      const errorMessage = getRefineErrorMessage(err);
      addToast(errorMessage, "error");
    } finally {
      setIsRefining(false);
    }
  }, [description, isRefining, addToast, onDescriptionChange, projectId]);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter((p) => p !== provider)
      : [provider, ...currentFavorites];

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels });
    } catch {
      setFavoriteProviders(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter((m) => m !== modelId)
      : [modelId, ...currentFavorites];

    setFavoriteModels(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites });
    } catch {
      setFavoriteModels(currentFavorites);
    }
  }, [favoriteModels, favoriteProviders]);

  // U6/R3: the project default workflow id (preselected + "(default)" badged).
  const defaultWorkflowId = settings?.defaultWorkflowId ?? null;
  const inheritedWorkflowId = defaultWorkflowId ?? (settings ? "builtin:coding" : null);
  const defaultWorkflow = defaultWorkflowId ? workflows.find((workflow) => workflow.id === defaultWorkflowId) : undefined;
  const selectedWorkflow = selectedWorkflowId === null
    ? null
    : workflows.find((workflow) => workflow.id === (selectedWorkflowId ?? inheritedWorkflowId));
  const selectedWorkflowValue = selectedWorkflowId === null
    ? "__none__"
    : selectedWorkflowId === undefined
      ? (inheritedWorkflowId ?? "")
      : selectedWorkflowId;
  const workflowNameCounts = workflows.reduce((counts, workflow) => {
    counts.set(workflow.name, (counts.get(workflow.name) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const workflowOptionLabel = (workflow: WorkflowDefinition) => {
    const duplicateName = (workflowNameCounts.get(workflow.name) ?? 0) > 1;
    return duplicateName ? `${workflow.name} (${workflow.id})` : workflow.name;
  };
  const workflowInlineLabel = selectedWorkflowId === null
    ? t("taskForm.workflowNone", "No workflow")
    : selectedWorkflow ? workflowOptionLabel(selectedWorkflow) : t("taskForm.workflowInlineDefault", "Normal");
  const orderedWorkflowOptions = [
    ...(defaultWorkflow ? [defaultWorkflow] : []),
    ...workflows.filter((workflow) => workflow.id !== defaultWorkflowId),
  ];
  const selectedNode = (nodeOptions ?? []).find((node) => node.id === nodeId);
  const nodeInlineLabel = selectedNode?.name ?? t("taskForm.nodeInlineDefault", "Node");
  const modelInlineLabel = selectedPreset?.name ?? (presetMode === "custom" ? t("taskForm.modelsCustom", "Models") : t("taskForm.modelsDefault", "Models"));
  const inlinePriority = priority ?? DEFAULT_TASK_PRIORITY;
  const InlinePriorityIcon = getPriorityIcon(inlinePriority);
  const inlinePriorityLabel = getPriorityLabel(inlinePriority);
  const inlinePriorityButtonLabel = t("taskForm.priorityInlineAria", "Priority: {{priority}}", { priority: inlinePriorityLabel });
  const inlineFastButtonLabel = t("taskForm.toggleFastMode", "Toggle fast execution mode");

  const revealAdvancedControl = useCallback((selector: string) => {
    if (!forceMoreOptionsOpen) setShowMoreOptions(true);
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(selector)?.focus();
    }, 0);
  }, [forceMoreOptionsOpen]);

  const availableDeps = tasks
    .filter((t) => !dependencies.includes(t.id))
    .sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return bNum - aNum;
    });

  const filteredDeps = depSearch
    ? availableDeps.filter((t) =>
        t.id.toLowerCase().includes(depSearch.toLowerCase()) ||
        (t.title && t.title.toLowerCase().includes(depSearch.toLowerCase())) ||
        (t.description && t.description.toLowerCase().includes(depSearch.toLowerCase()))
      )
    : availableDeps;

  return (
    <div
      className="task-form"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onPaste={handlePaste}
    >
      <div className="task-form-primary-section">
        {/* Title field (edit mode only) */}
      {mode === "edit" && onTitleChange && (
        <div className="form-group">
          <label htmlFor="task-form-title">{t("taskForm.titleLabel", "Title")}</label>
          <input
            ref={titleInputRef}
            autoFocus
            id="task-form-title"
            type="text"
            className="modal-edit-input"
            placeholder={t("taskForm.titlePlaceholder", "Task title")}
            value={title || ""}
            onChange={(e) => onTitleChange(e.target.value)}
            disabled={disabled}
          />
        </div>
      )}

      {/* Description field */}
      <div className="form-group">
        <label htmlFor="task-form-description" className="description-label-row">
          <span>{t("taskForm.descriptionLabel", "Description")}</span>
          <span
            className={`description-auto-save-status${autoSaveStatus === "idle" ? "" : " is-visible"}`}
            aria-live="polite"
          >
            {autoSaveStatus === "saving" ? t("taskForm.autoSaveSaving", "Saving...") : autoSaveStatus === "saved" ? t("taskForm.autoSaveSaved", "Saved") : ""}
          </span>
        </label>
        <div
          className={`description-with-refine${isDescriptionExpanded ? " description--fullscreen" : ""}`}
          ref={refineMenuRef}
          onKeyDown={handleDescriptionFullscreenKeyDown}
        >
          {isDescriptionExpanded && (
            <div className="description-fullscreen-header">
              <span>{t("taskForm.editingDescription", "Editing Description")}</span>
              <button
                type="button"
                className="btn btn-sm description-expand-btn"
                onClick={handleToggleDescriptionExpand}
                aria-label={t("taskForm.collapseDescription", "Collapse description")}
                title={t("taskForm.collapseDescription", "Collapse description")}
              >
                <Minimize2 size={14} />
              </button>
            </div>
          )}
          <textarea
            ref={descTextareaRef}
            autoFocus={mode === "create"}
            id="task-form-description"
            value={description}
            onChange={handleDescriptionInput}
            placeholder={t("taskForm.descriptionPlaceholder", "What needs to be done?")}
            rows={mode === "edit" ? 8 : 5}
            disabled={disabled || isRefining}
          />
          {/* Determine if refine button will be shown — controls expand button placement */}
          {(() => {
            const showRefineButton = Boolean(description.trim()) && !disabled;
            return (
              <>
                {!isDescriptionExpanded && (
                  <button
                    type="button"
                    className={`btn btn-sm description-expand-btn${showRefineButton ? " description-expand-btn--offset" : " description-expand-btn--flush"}`}
                    onClick={handleToggleDescriptionExpand}
                    aria-label={t("taskForm.expandDescription", "Expand description")}
                    title={t("taskForm.expandDescription", "Expand description")}
                  >
                    <Maximize2 size={14} />
                  </button>
                )}
                {showRefineButton && (
            <button
              type="button"
              className={`btn btn-sm refine-button ${isRefining ? "refine-button--loading" : ""}`}
              onClick={() => setIsRefineMenuOpen((prev) => !prev)}
              disabled={isRefining}
              data-testid="refine-button"
              title={t("taskForm.refineTitle", "Refine description with AI")}
            >
              <Sparkles size={12} style={{ verticalAlign: "middle" }} />
              {isRefining ? t("taskForm.refineInProgress", "Refining...") : t("taskForm.refineButton", "Refine")}
            </button>
                )}
              </>
            );
          })()}
          {isRefineMenuOpen && (
            <div
              className="refine-menu refine-menu--modal"
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="refine-menu-item" onClick={() => handleRefine("clarify")} data-testid="refine-clarify">
                <div className="refine-menu-item-title">{t("taskForm.refineClarifyTitle", "Clarify")}</div>
                <div className="refine-menu-item-desc">{t("taskForm.refineClarifyDesc", "Make the description clearer and more specific")}</div>
              </div>
              <div className="refine-menu-item" onClick={() => handleRefine("add-details")} data-testid="refine-add-details">
                <div className="refine-menu-item-title">{t("taskForm.refineAddDetailsTitle", "Add details")}</div>
                <div className="refine-menu-item-desc">{t("taskForm.refineAddDetailsDesc", "Add implementation details and context")}</div>
              </div>
              <div className="refine-menu-item" onClick={() => handleRefine("expand")} data-testid="refine-expand">
                <div className="refine-menu-item-title">{t("taskForm.refineExpandTitle", "Expand")}</div>
                <div className="refine-menu-item-desc">{t("taskForm.refineExpandDesc", "Expand into a more comprehensive description")}</div>
              </div>
              <div className="refine-menu-item" onClick={() => handleRefine("simplify")} data-testid="refine-simplify">
                <div className="refine-menu-item-title">{t("taskForm.refineSimplifyTitle", "Simplify")}</div>
                <div className="refine-menu-item-desc">{t("taskForm.refineSimplifyDesc", "Simplify and make more concise")}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/*
      FNXC:NewTask 2026-06-23-00:10:
      Common quick-add action row, adjacent to the description (create mode only). The deep/advanced controls stay collapsed behind the "Advanced" disclosure, but the buttons users reach for most — Attach, Fast (execution-mode), Priority — are surfaced INLINE here next to Plan, styled identically to QuickEntryBox's quick-add buttons (shared `.btn .btn-sm`, `.dep-trigger`, lucide icons at size 12). They are wired to TaskForm's existing state/handlers, NOT duplicated:
        - Attach   → fileInputRef.click() (same hidden input the Advanced Attachments group uses; onImagesChange handles the file).
        - Fast     → toggles executionMode standard⇄fast via onExecutionModeChange (mirrors QuickEntryBox quick-entry-fast-toggle).
        - Priority → cycles through TASK_PRIORITIES via onPriorityChange and uses the shared priorityIndicator glyph language.

      FNXC:NewTaskDialogAffordances 2026-07-10-21:45:
      Priority and Fast are icon-only in the inline New Task row to match QuickEntryBox: priority uses the shared up/high, down/low, flag/normal, alert/urgent helper, and Fast uses Zap while title/aria-label/test-id semantics preserve accessibility and tests.
      Plan/Subtask remain gated on their handoff callbacks. Model selectors, branch/base, node, review level, and GitHub tracking stay in the Advanced disclosure.

      FNXC:NewTaskDialogAffordances 2026-06-23-21:20:
      The regular New Task dialog must visibly expose the screenshot quick-add button contract in the immediate action cluster while Advanced remains the deep configuration editor. TaskForm hosts the cluster so create payload state has one source of truth; NewTaskModal only supplies the submit handler and its existing dependency/agent quick controls.

      FNXC:NewTaskDialogAffordances 2026-06-25-00:00:
      Optional workflow steps are now an inline create-time quick button, seeded by the selected workflow's `defaultOn` values and lifted to NewTaskModal through the existing enabledWorkflowSteps state. The Advanced workflow section remains the place to choose the workflow itself, not a duplicate optional-steps trigger.
      */}
      {mode === "create" && (
        <div className="task-form-description-actions" data-testid="task-form-description-actions">
          {onCreateSubmit && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onCreateSubmit}
              disabled={disabled || createSubmitDisabled}
              data-testid="task-form-inline-create"
            >
              {createSubmitLabel ?? t("taskForm.createTask", "Create")}
            </button>
          )}
          {onPlanningMode && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const trimmed = description.trim();
                if (!trimmed) {
                  addToast(t("taskForm.enterDescriptionFirst", "Enter a description first"), "error");
                  return;
                }
                onClose?.();
                onPlanningMode(trimmed);
              }}
              disabled={disabled || !description.trim()}
              data-testid="task-form-plan-button"
            >
              {t("taskForm.planButton", "Plan")}
            </button>
          )}
          {onSubtaskBreakdown && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const trimmed = description.trim();
                if (!trimmed) {
                  addToast(t("taskForm.enterDescriptionFirst", "Enter a description first"), "error");
                  return;
                }
                onClose?.();
                onSubtaskBreakdown(trimmed);
              }}
              disabled={disabled || !description.trim()}
              data-testid="task-form-subtask-button"
            >
              {t("taskForm.subtaskButton", "Subtask")}
            </button>
          )}

          {/* FNXC:NewTask 2026-06-23-00:10: Attach — reuses the Advanced section's hidden file input; programmatic .click() works even while that section is collapsed. */}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            data-testid="task-form-inline-attach"
            title={t("taskForm.attachScreenshot", "Attach Screenshot")}
          >
            <Paperclip size={12} className="task-form-action-icon" />
            {pendingImages.length > 0
              ? t("taskForm.attachCount", "Attach ({{count}})", { count: pendingImages.length })
              : t("taskForm.attach", "Attach")}
          </button>

          {/* FNXC:NewTask 2026-06-23-00:10: Fast — toggles executionMode standard⇄fast; btn-primary when active, matching QuickEntryBox's fast toggle. */}
          {onExecutionModeChange && executionMode !== undefined && (
            <button
              type="button"
              className={`btn btn-sm ${executionMode === "fast" ? "btn-primary" : ""}`}
              onClick={() => handleExecutionModeChange(executionMode === "fast" ? "standard" : "fast")}
              aria-pressed={executionMode === "fast"}
              aria-label={inlineFastButtonLabel}
              disabled={disabled}
              data-testid="task-form-inline-fast"
              title={inlineFastButtonLabel}
            >
              <Zap size={12} className="task-form-action-icon" aria-hidden="true" />
            </button>
          )}

          {/* FNXC:NewTaskDialogAffordances 2026-06-23-21:31: GitHub/workflow/models/node are promoted as visible chips that mutate or focus the same Advanced controls instead of duplicating create-payload state. */}
          {onGithubTrackingEnabledChange && (
            <button
              type="button"
              className={`btn btn-sm ${githubTrackingEnabled ? "btn-primary" : ""}`}
              onClick={() => {
                githubTrackingDefaultAppliedRef.current = true;
                onGithubTrackingEnabledChange(!githubTrackingEnabled);
              }}
              aria-pressed={githubTrackingEnabled === true}
              disabled={disabled}
              data-testid="task-form-inline-github"
              title={t("taskForm.githubTrackingLabel", "GitHub Tracking")}
            >
              <ProviderIcon provider="github" size="sm" />
              {t("taskForm.githubInline", "GitHub")}
            </button>
          )}

          {onWorkflowIdChange && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                revealAdvancedControl("#task-workflow-dropdown-trigger, [data-testid='task-workflow-cta']");
                window.setTimeout(() => setShowWorkflowDropdown(true), 0);
              }}
              disabled={disabled}
              data-testid="task-form-inline-workflow"
              aria-label={t("taskForm.workflowInlineAria", "Choose workflow: {{workflow}}", { workflow: workflowInlineLabel })}
              title={t("taskForm.workflowLabel", "Workflow")}
            >
              {selectedWorkflow ? (
                <WorkflowIcon workflowId={selectedWorkflow.id} icon={selectedWorkflow.icon} className="task-workflow-trigger-icon" decorative />
              ) : null}
              <span className="task-form-inline-workflow-label">{workflowInlineLabel}</span>
            </button>
          )}

          {optionalStepsLoading ? (
            <small className="workflow-optional-steps-loading" data-testid="task-optional-steps-loading">
              {t("taskForm.optionalStepsLoading", "Loading optional steps…")}
            </small>
          ) : (
            <WorkflowOptionalStepsDropdown
              steps={optionalSteps}
              enabledIds={enabledOptionalStepIds}
              onToggle={toggleOptionalStep}
              disabled={disabled}
              triggerTestId="task-form-inline-optional-steps"
            />
          )}

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => revealAdvancedControl("#model-preset, #executor-model")}
            disabled={disabled}
            data-testid="task-form-inline-models"
            aria-label={t("taskForm.modelsInlineAria", "Choose models: {{models}}", { models: modelInlineLabel })}
            title={t("taskForm.modelConfigLabel", "Model Configuration")}
          >
            <Brain size={12} className="task-form-action-icon" />
            {modelInlineLabel}
          </button>

          {onNodeIdChange && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => revealAdvancedControl("#task-node-select")}
              disabled={disabled || nodeOverrideDisabled}
              data-testid="task-form-inline-node"
              aria-label={t("taskForm.nodeInlineAria", "Choose execution node: {{node}}", { node: nodeInlineLabel })}
              title={nodeOverrideDisabled ? nodeOverrideDisabledReason : t("taskForm.nodeOverrideLabel", "Execution Node Override")}
            >
              {selectedNode ? <NodeHealthDot status={selectedNode.status} compact className="task-form-action-icon" /> : <Server size={12} className="task-form-action-icon" />}
              {nodeInlineLabel}
            </button>
          )}

          {/* FNXC:NewTask 2026-06-23-00:10: Priority — cycles TASK_PRIORITIES via onPriorityChange (shared icon-only glyph language, same accessible label shape as QuickEntryBox).
          FNXC:PriorityColorCoding 2026-07-11-00:00: Tint the inline priority glyph from priorityIndicator so the New Task row shares quick-add/card urgency colors without changing button semantics. */}
          {onPriorityChange && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const idx = TASK_PRIORITIES.indexOf(inlinePriority);
                const next = TASK_PRIORITIES[(idx + 1) % TASK_PRIORITIES.length];
                onPriorityChange(next);
              }}
              aria-label={inlinePriorityButtonLabel}
              disabled={disabled}
              data-testid="task-form-inline-priority"
              title={inlinePriorityButtonLabel}
            >
              <InlinePriorityIcon size={12} className="task-form-action-icon" aria-hidden="true" style={{ color: getPriorityColorVar(inlinePriority) }} />
            </button>
          )}
        </div>
      )}
      </div>

      {renderBelowPrimary}

      {/*
      FNXC:NewTask 2026-06-22-20:30: Hide the disclosure toggle entirely when force-open — there is nothing to collapse.
      FNXC:NewTask 2026-06-23-00:10: The disclosure now reads "Advanced" (was "More options"). It stays collapsed by default and hides only the DEEP options (model selectors, branch/base, node, review level, GitHub tracking, workflow). The common quick-add buttons (Attach/Fast/Priority) live inline next to Plan and are always visible, so they are NOT buried behind this toggle.
      */}
      {!forceMoreOptionsOpen && (
        <button
          type="button"
          className="task-form-more-options-toggle"
          onClick={() => setShowMoreOptions((prev) => !prev)}
          aria-expanded={showMoreOptions}
          aria-controls="task-form-more-options"
          disabled={disabled}
          data-testid="task-form-more-options-toggle"
        >
          <span>{t("taskForm.advancedOptions", "Advanced")}</span>
          {showMoreOptions ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      )}

      <div
        id="task-form-more-options"
        className={`task-form-more-options${moreOptionsOpen ? "" : " collapsed"}`}
        aria-hidden={!moreOptionsOpen}
        hidden={!moreOptionsOpen}
        data-testid="task-form-more-options"
      >
      {/* Attachments */}
      <div className="form-group">
        <label>{t("taskForm.attachmentsLabel", "Attachments")}</label>
        <PendingAttachmentPreviews
          attachments={pendingImages}
          onRemove={removeImage}
          disabled={disabled}
          removeLabel={t("taskForm.removeImage", "Remove image")}
          testIdPrefix="task-form-preview"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              onImagesChange([
                ...pendingImages,
                { file, previewUrl: URL.createObjectURL(file) },
              ]);
              e.target.value = "";
            }
          }}
          style={{ display: "none" }}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
        >
          {t("taskForm.attachScreenshot", "Attach Screenshot")}
        </button>
        <small>{t("taskForm.attachHint", "You can also paste images or drag & drop")}</small>
      </div>

      {onNodeIdChange && (
        <div className="form-group">
          <label htmlFor="task-node-select">{t("taskForm.nodeOverrideLabel", "Execution Node Override")}</label>
          <select
            id="task-node-select"
            data-testid="task-node-select"
            className="select"
            value={nodeId ?? ""}
            onChange={(e) => onNodeIdChange(e.target.value || undefined)}
            disabled={disabled || nodeOverrideDisabled}
          >
            <option value="">{t("taskForm.nodeDefaultOption", "Use project default / local")}</option>
            {(nodeOptions ?? []).map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} ({getNodeStatusLabel(node.status, t)})
              </option>
            ))}
          </select>
          {(() => {
            const selectedNode = (nodeOptions ?? []).find((node) => node.id === nodeId);
            if (!selectedNode) return null;
            return (
              <div className="task-form-node-status">
                <NodeHealthDot status={selectedNode.status} showLabel />
              </div>
            );
          })()}
          <small>
            {nodeOverrideDisabledReason ?? t("taskForm.nodeOverrideHint", "Task override takes priority over project default node routing.")}
          </small>
        </div>
      )}

      {!hideDependencies && (
        <>
      {/* Dependencies */}
      <div className="form-group">
        <label>{t("taskForm.dependenciesLabel", "Dependencies")}</label>
        <div className="dep-trigger-wrap" ref={depDropdownRef}>
          <button
            type="button"
            className="btn btn-sm dep-trigger"
            onClick={() => setShowDepDropdown((v) => !v)}
            disabled={disabled}
          >
            {dependencies.length > 0 ? t("taskForm.dependenciesSelected", "{{count}} selected", { count: dependencies.length }) : t("taskForm.addDependencies", "Add dependencies")}
          </button>
          {showDepDropdown && (
            <div className="dep-dropdown">
              <input
                className="dep-dropdown-search"
                placeholder={t("taskForm.searchTasksPlaceholder", "Search tasks…")}
                autoFocus
                value={depSearch}
                onChange={(e) => setDepSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              {filteredDeps.length === 0 ? (
                <div className="dep-dropdown-empty">{t("taskForm.noAvailableTasks", "No available tasks")}</div>
              ) : (
                filteredDeps.map((t) => (
                  <div
                    key={t.id}
                    className={`dep-dropdown-item${dependencies.includes(t.id) ? " selected" : ""}`}
                    onClick={() => toggleDep(t.id)}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <span className="dep-dropdown-id">{t.id}</span>
                    <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 30)}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        {dependencies.length > 0 && (
          <div className="selected-deps">
            {dependencies.map((depId) => (
              <span key={depId} className="dep-chip">
                {depId}
                <button
                  type="button"
                  className="dep-chip-remove"
                  onClick={() => toggleDep(depId)}
                  disabled={disabled}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
        </>
      )}

      {(onBranchChange || onBaseBranchChange || onBranchModeChange) && (
        <div className="form-group">
          <label>{t("taskForm.branchSettingsLabel", "Branch Settings")}</label>
          {onBranchModeChange ? (
            <>
              <label htmlFor="task-branch-mode" className="model-select-label">{t("taskForm.branchStrategyLabel", "Branch strategy")}</label>
              <select
                id="task-branch-mode"
                className="input"
                value={branchMode ?? "project-default"}
                onChange={(event) => onBranchModeChange(event.target.value as BranchSelectionMode)}
                disabled={disabled}
              >
                <option value="project-default">{t("taskForm.branchModeProjectDefault", "Use project/default branch")}</option>
                <option value="auto-new">{t("taskForm.branchModeAutoNew", "Create auto-named branch per task")}</option>
                <option value="existing">{t("taskForm.branchModeExisting", "Use existing branch")}</option>
                <option value="custom-new">{t("taskForm.branchModeCustomNew", "Create custom new branch")}</option>
                <option value="shared-group">{t("taskForm.branchModeSharedGroup", "Merge into a shared feature branch")}</option>
              </select>
            </>
          ) : null}
          {onBranchChange && (!onBranchModeChange || branchMode === "existing" || branchMode === "custom-new" || branchMode === "shared-group") && (
            <>
              <label htmlFor="task-working-branch" className="model-select-label">
                {branchMode === "shared-group" ? t("taskForm.sharedFeatureBranchLabel", "Shared feature branch") : (onBranchModeChange ? t("taskForm.branchNameLabel", "Branch name") : t("taskForm.workingBranchLabel", "Working branch"))}
              </label>
              <input
                id="task-working-branch"
                className="input"
                value={branch || ""}
                onChange={(e) => onBranchChange(e.target.value)}
                placeholder={branchMode === "shared-group" ? t("taskForm.sharedBranchPlaceholder", "e.g. clionboarding") : t("taskForm.branchPlaceholder", "e.g. feature/my-task")}
                disabled={disabled}
              />
            </>
          )}
          {onBaseBranchChange && (
            <>
              <label htmlFor="task-base-branch" className="model-select-label">{t("taskForm.baseBranchLabel", "Merge target / base branch")}</label>
              {(() => {
                const currentValue = baseBranch || "";
                const valueIsKnown = currentValue.length > 0 && baseBranchOptions.includes(currentValue);
                const isCustomMode = baseBranchCustomMode || (currentValue.length > 0 && !valueIsKnown) || baseBranchOptions.length === 0;
                if (isCustomMode) {
                  return (
                    <div className="form-inline-group">
                      <input
                        id="task-base-branch"
                        className="input"
                        value={currentValue}
                        onChange={(e) => onBaseBranchChange(e.target.value)}
                        placeholder={t("taskForm.baseBranchPlaceholder", "e.g. main")}
                        disabled={disabled}
                        data-testid="task-base-branch-custom-input"
                      />
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => {
                          setBaseBranchCustomMode(false);
                          onBaseBranchChange("");
                        }}
                        disabled={disabled}
                        data-testid="task-base-branch-use-dropdown"
                      >
                        {t("taskForm.useDropdown", "Use dropdown")}
                      </button>
                    </div>
                  );
                }

                return (
                  <select
                    id="task-base-branch"
                    className="select"
                    value={currentValue}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next === CUSTOM_BRANCH_OPTION) {
                        setBaseBranchCustomMode(true);
                        return;
                      }
                      onBaseBranchChange(next === DEFAULT_BRANCH_OPTION ? "" : next);
                    }}
                    disabled={disabled}
                    data-testid="task-base-branch-select"
                  >
                    <option value={DEFAULT_BRANCH_OPTION}>{t("taskForm.baseBranchDefault", "(default / project branch)")}</option>
                    {baseBranchOptions.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                    <option value={CUSTOM_BRANCH_OPTION}>{t("taskForm.baseBranchCustom", "Custom…")}</option>
                  </select>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Model Selection */}
      <div className="form-group">
        <label>{t("taskForm.modelConfigLabel", "Model Configuration")}</label>
        {onPriorityChange && (
          <div className="model-select-row">
            <label htmlFor="task-priority" className="model-select-label">{t("taskForm.priorityLabel", "Priority")}</label>
            <select
              id="task-priority"
              data-testid="task-priority-select"
              value={priority ?? DEFAULT_TASK_PRIORITY}
              onChange={(e) => onPriorityChange(e.target.value as TaskPriority)}
              disabled={disabled}
            >
              {TASK_PRIORITIES.map((taskPriority) => (
                <option key={taskPriority} value={taskPriority}>
                  {t(`taskForm.priority_${taskPriority}`, taskPriority[0].toUpperCase() + taskPriority.slice(1))}
                </option>
              ))}
            </select>
          </div>
        )}
        {onExecutionModeChange && executionMode !== undefined && (
          <div className="model-select-row">
            <label htmlFor="task-execution-mode" className="model-select-label">{t("taskForm.executionModeLabel", "Execution mode")}</label>
            <select
              id="task-execution-mode"
              data-testid="task-form-execution-mode-select"
              value={executionMode}
              onChange={(e) => handleExecutionModeChange(e.target.value as TaskExecutionModeSelection)}
              disabled={disabled}
            >
              <option value="standard">{t("taskForm.executionModeStandard", "Standard")}</option>
              <option value="fast">{t("taskForm.executionModeFast", "Fast")}</option>
            </select>
          </div>
        )}
        {modelsLoading ? (
          <div className="model-selector-loading"><LoadingSpinner label={t("taskForm.loadingModels", "Loading models…")} /></div>
        ) : availableModels.length === 0 ? (
          <small>{t("taskForm.noModelsAvailable", "No models available. Configure authentication in Settings.")}</small>
        ) : (
          <>
            <div className="model-select-row">
              <label htmlFor="model-preset" className="model-select-label">{t("taskForm.presetLabel", "Preset")}</label>
              <select
                id="model-preset"
                value={presetMode === "preset" ? selectedPresetId : presetMode}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "default") {
                    onPresetModeChange("default");
                    onSelectedPresetIdChange("");
                    onExecutorModelChange("");
                    onValidatorModelChange("");
                    return;
                  }
                  if (value === "custom") {
                    onPresetModeChange("custom");
                    onSelectedPresetIdChange("");
                    return;
                  }
                  const preset = availablePresets.find((entry) => entry.id === value);
                  const selection = applyPresetToSelection(preset);
                  onPresetModeChange("preset");
                  onSelectedPresetIdChange(value);
                  onExecutorModelChange(selection.executorValue);
                  onValidatorModelChange(selection.validatorValue);
                }}
                disabled={disabled}
              >
                <option value="default">{t("taskForm.presetUseDefault", "Use default")}</option>
                {availablePresets.length > 0 ? <option disabled>{PRESET_OPTION_SEPARATOR}</option> : null}
                {availablePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.name}</option>
                ))}
                <option value="custom">{t("taskForm.presetCustom", "Custom")}</option>
              </select>
            </div>
            {presetMode === "preset" && selectedPreset ? (
              <small>{t("taskForm.usingPreset", "Using preset: {{name}}", { name: selectedPreset.name })}</small>
            ) : null}
            {presetMode === "preset" ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onPresetModeChange("custom")}
                disabled={disabled}
              >
                {t("taskForm.overridePreset", "Override")}
              </button>
            ) : null}
            <div className="model-select-row">
              <label htmlFor="executor-model" className="model-select-label">{t("taskForm.executorLabel", "Executor")}</label>
              <CustomModelDropdown
                id="executor-model"
                label={t("taskForm.executorModelLabel", "Executor Model")}
                value={executorModel}
                onChange={(value) => {
                  onPresetModeChange("custom");
                  onSelectedPresetIdChange("");
                  onExecutorModelChange(value);
                }}
                models={availableModels}
                disabled={disabled || presetMode === "preset"}
                favoriteProviders={favoriteProviders}
                onToggleFavorite={handleToggleFavorite}
                favoriteModels={favoriteModels}
                onToggleModelFavorite={handleToggleModelFavorite}
                thinkingLevel={thinkingLevel || ""}
                onThinkingLevelChange={onThinkingLevelChange ? (value) => onThinkingLevelChange(value) : undefined}
                defaultThinkingLevel={settings?.defaultThinkingLevel ?? "off"}
              />
            </div>
            <div className="model-select-row">
              <label htmlFor="validator-model" className="model-select-label">{t("taskForm.reviewerLabel", "Reviewer")}</label>
              <CustomModelDropdown
                id="validator-model"
                label={t("taskForm.reviewerModelLabel", "Reviewer Model")}
                value={validatorModel}
                onChange={(value) => {
                  onPresetModeChange("custom");
                  onSelectedPresetIdChange("");
                  onValidatorModelChange(value);
                }}
                models={availableModels}
                disabled={disabled || presetMode === "preset"}
                favoriteProviders={favoriteProviders}
                onToggleFavorite={handleToggleFavorite}
                favoriteModels={favoriteModels}
                onToggleModelFavorite={handleToggleModelFavorite}
              />
            </div>
            {onPlanningModelChange && (
              <div className="model-select-row">
                <label htmlFor="planning-model" className="model-select-label">{t("taskForm.planningLabel", "Planning")}</label>
                <CustomModelDropdown
                  id="planning-model"
                  label={t("taskForm.planningModelLabel", "Planning Model")}
                  value={planningModel || ""}
                  onChange={(value) => {
                    onPresetModeChange("custom");
                    onSelectedPresetIdChange("");
                    onPlanningModelChange(value);
                  }}
                  models={availableModels}
                  disabled={disabled || presetMode === "preset"}
                  favoriteProviders={favoriteProviders}
                  onToggleFavorite={handleToggleFavorite}
                  favoriteModels={favoriteModels}
                  onToggleModelFavorite={handleToggleModelFavorite}
                />
              </div>
            )}
            {onPlannerOversightLevelChange && (
              <div className="model-select-row">
                {/* FNXC:PlannerOversight 2026-07-04-00:00: Per-task override for the workflow-native plannerOversightLevel setting (FN-7508). Empty value inherits the workflow's effective value; the four levels mirror BUILTIN_OVERSIGHT_SETTINGS verbatim. Configuration only — runtime controls are FN-7517. */}
                <label htmlFor="planner-oversight-level" className="model-select-label">{t("taskForm.plannerOversightLabel", "Planner oversight")}</label>
                <select
                  id="planner-oversight-level"
                  data-testid="planner-oversight-level-select"
                  value={plannerOversightLevel || ""}
                  onChange={(e) => onPlannerOversightLevelChange(e.target.value)}
                  disabled={disabled}
                >
                  <option value="">{t("taskForm.plannerOversightInherit", "Inherit from workflow")}</option>
                  <option value="off">{t("taskForm.plannerOversightOff", "Off")}</option>
                  <option value="observe">{t("taskForm.plannerOversightObserve", "Observe")}</option>
                  <option value="steer">{t("taskForm.plannerOversightSteer", "Steer")}</option>
                  <option value="autonomous">{t("taskForm.plannerOversightAutonomous", "Autonomous recovery")}</option>
                </select>
              </div>
            )}
            {onReviewLevelChange && (
              /*
              FNXC:ReviewLevelPreset 2026-07-19-10:50 (U8 / R6):
              Review is now a CREATION-TIME preset over the workflow's optional review
              steps (level -> enabledWorkflowSteps at create), not a runtime signal
              triage decides. The default (unset) leaves the workflow's own default-on
              steps in place; an explicit optional-step selection always wins over the
              level preset (server-side applyReviewLevelPreset).
              */
              <div className="model-select-row">
                <label htmlFor="review-level" className="model-select-label">{t("taskForm.reviewLabel", "Review")}</label>
                <select
                  id="review-level"
                  value={reviewLevel ?? ""}
                  onChange={(e) => onReviewLevelChange(e.target.value === "" ? undefined : parseInt(e.target.value, 10))}
                  disabled={disabled}
                >
                  <option value="">{t("taskForm.reviewDefault", "Default (workflow review steps)")}</option>
                  <option value="0">{t("taskForm.reviewLevel0", "0 — None")}</option>
                  <option value="1">{t("taskForm.reviewLevel1", "1 — Code Review")}</option>
                  <option value="2">{t("taskForm.reviewLevel2", "2 — Plan + Code")}</option>
                  <option value="3">{t("taskForm.reviewLevel3", "3 — Plan + Browser + Code")}</option>
                </select>
              </div>
            )}
            {onAutoMergeChange && (
              <div className="model-select-row">
                <label htmlFor="task-automerge-select" className="model-select-label">{t("taskForm.autoMergeLabel", "Auto-merge")}</label>
                <select
                  id="task-automerge-select"
                  data-testid="task-automerge-select"
                  value={autoMerge === undefined ? "" : autoMerge ? "on" : "off"}
                  onChange={(e) => {
                    if (e.target.value === "on") return onAutoMergeChange(true);
                    if (e.target.value === "off") return onAutoMergeChange(false);
                    return onAutoMergeChange(undefined);
                  }}
                  disabled={disabled}
                >
                  <option value="">{t("taskForm.autoMergeDefault", "Default (Follow project setting)")}</option>
                  <option value="on">{t("taskForm.autoMergeEnabled", "Enabled")}</option>
                  <option value="off">{t("taskForm.autoMergeDisabled", "Disabled")}</option>
                </select>
                <small>{t("taskForm.autoMergeHint", "Default follows the project auto-merge setting.")}</small>
              </div>
            )}
          </>
        )}
      </div>

      {renderBelowModelConfiguration}

      {/* Workflow picker (U6/R3). A task picks a whole workflow at creation; the
          selection is materialized atomically server-side via `workflowId`. */}
      {onWorkflowIdChange && (
        <div className="form-group" data-testid="workflow-steps-section">
          <label htmlFor="task-workflow-dropdown-trigger">{t("taskForm.workflowLabel", "Workflow")}</label>
          {workflowsLoading ? (
            <div className="workflow-select-loading" data-testid="task-workflow-loading">
              <LoadingSpinner label={t("taskForm.workflowsLoading", "Loading workflows…")} />
            </div>
          ) : workflows.length === 0 ? (
            // Built-ins are always present, so an empty list means the fetch
            // failed. No editor-open prop is plumbed through TaskForm, so we
            // surface a plain-text CTA rather than inventing new prop wiring.
            <div className="workflow-select-cta" data-testid="task-workflow-cta">
              {t("taskForm.workflowsCta", "Set up workflows in the editor")}
            </div>
          ) : (
            <div className="task-workflow-dropdown-wrap" ref={workflowDropdownRef}>
              {/*
              FNXC:NewTaskWorkflowDropdown 2026-06-30-18:31:
              Native selects cannot render the shared workflow identity icons. The create-time workflow selector uses a styled button/listbox while keeping the atomic `workflowId` contract: `__none__` becomes null, undefined still displays inherited default state, and real workflow ids are passed through unchanged.
              */}
              <button
                id="task-workflow-dropdown-trigger"
                type="button"
                className="btn dep-trigger task-workflow-dropdown-trigger"
                data-testid="task-workflow-dropdown-trigger"
                aria-haspopup="listbox"
                aria-expanded={showWorkflowDropdown}
                aria-label={t("taskForm.workflowInlineAria", "Choose workflow: {{workflow}}", { workflow: workflowInlineLabel })}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShowWorkflowDropdown((open) => !open)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setShowWorkflowDropdown(false);
                  }
                }}
              >
                {selectedWorkflow ? (
                  <WorkflowIcon workflowId={selectedWorkflow.id} icon={selectedWorkflow.icon} className="task-workflow-trigger-icon" decorative />
                ) : null}
                <span className="task-workflow-trigger-label">{workflowInlineLabel}</span>
                {selectedWorkflowId === undefined && defaultWorkflow ? (
                  <span className="task-workflow-default-badge">{t("taskForm.workflowDefaultBadge", "(default)")}</span>
                ) : null}
                <ChevronDown size={12} aria-hidden="true" />
              </button>
              {showWorkflowDropdown && (
                <div className="dep-dropdown task-workflow-dropdown-menu" role="listbox" data-testid="task-workflow-dropdown-menu">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedWorkflowValue === "__none__"}
                    className={`dep-dropdown-item task-workflow-dropdown-option${selectedWorkflowValue === "__none__" ? " selected" : ""}`}
                    data-testid="task-workflow-option-none"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onWorkflowIdChange(null);
                      setShowWorkflowDropdown(false);
                    }}
                  >
                    <span className="task-workflow-option-copy">
                      <span className="dep-dropdown-title task-workflow-option-name">{t("taskForm.workflowNone", "No workflow")}</span>
                    </span>
                  </button>
                  {orderedWorkflowOptions.map((workflow) => {
                    const optionLabel = workflowOptionLabel(workflow);
                    const isSelected = selectedWorkflowValue === workflow.id;
                    return (
                      <button
                        key={workflow.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        aria-label={workflow.id === defaultWorkflowId ? `${optionLabel} ${t("taskForm.workflowDefaultBadge", "(default)")}` : optionLabel}
                        className={`dep-dropdown-item task-workflow-dropdown-option${isSelected ? " selected" : ""}`}
                        data-testid={`task-workflow-option-${workflow.id}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          onWorkflowIdChange(workflow.id);
                          setShowWorkflowDropdown(false);
                        }}
                      >
                        <WorkflowIcon workflowId={workflow.id} icon={workflow.icon} className="task-workflow-option-icon" decorative />
                        <span className="task-workflow-option-copy">
                          <span className="dep-dropdown-title task-workflow-option-name">{workflow.name}</span>
                          {(workflowNameCounts.get(workflow.name) ?? 0) > 1 ? (
                            <span className="dep-dropdown-subtitle task-workflow-option-id">{workflow.id}</span>
                          ) : null}
                        </span>
                        {workflow.id === defaultWorkflowId ? (
                          <span className="task-workflow-default-badge">{t("taskForm.workflowDefaultBadge", "(default)")}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <small className="workflow-select-help" data-testid="task-workflow-help">
            {t("taskForm.workflowHelp", "The selected workflow's steps run automatically around this task's execution.")}
          </small>
        </div>
      )}

      {mode === "edit" && onEnabledWorkflowStepsChange && (optionalStepsLoading || optionalSteps.length > 0) && (
        <div className="form-group" data-testid="task-form-edit-workflow-steps-group">
          {/* FNXC:WorkflowOptionalSteps 2026-07-10-00:18: Edit-mode Workflow Steps belongs in More options immediately before GitHub Tracking so shared edit/create forms keep the documented advanced-section order while avoiding an empty button shell for workflows with no optional steps. */}
          <label>{t("taskForm.workflowStepsLabel", "Workflow Steps")}</label>
          {optionalStepsLoading ? (
            <small className="workflow-optional-steps-loading" data-testid="task-edit-optional-steps-loading">
              {t("taskForm.optionalStepsLoading", "Loading optional steps…")}
            </small>
          ) : (
            <WorkflowOptionalStepsDropdown
              steps={optionalSteps}
              enabledIds={enabledOptionalStepIds}
              onToggle={toggleOptionalStep}
              disabled={disabled}
              triggerTestId="task-form-edit-optional-steps"
            />
          )}
        </div>
      )}

      {(onGithubTrackingEnabledChange || onGithubRepoOverrideChange) && (
        <div className="form-group" data-testid="task-form-github-tracking">
          <label>{t("taskForm.githubTrackingLabel", "GitHub Tracking")}</label>
          {onGithubTrackingEnabledChange && (
            <label className="checkbox-label" htmlFor="task-github-tracking-enabled">
              <input
                id="task-github-tracking-enabled"
                type="checkbox"
                checked={githubTrackingEnabled === true}
                onChange={(event) => {
                  githubTrackingDefaultAppliedRef.current = true;
                  onGithubTrackingEnabledChange(event.target.checked);
                }}
                disabled={disabled}
              />
              {t("taskForm.githubTrackingEnable", "Enable GitHub issue tracking for this task")}
            </label>
          )}
          {onGithubRepoOverrideChange && (
            <>
              <label htmlFor="task-github-repo-override" className="model-select-label">{t("taskForm.githubRepoLabel", "Repository (owner/repo)")}</label>
              <input
                id="task-github-repo-override"
                className="input"
                value={githubRepoOverride || ""}
                onChange={(event) => onGithubRepoOverrideChange(event.target.value)}
                placeholder={effectiveGithubRepoDefault || "owner/repo"}
                disabled={disabled}
              />
              {githubRepoOverrideInvalid ? (
                <div className="form-error">{t("taskForm.githubRepoFormatError", "Repository must be in owner/repo format.")}</div>
              ) : null}
            </>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
