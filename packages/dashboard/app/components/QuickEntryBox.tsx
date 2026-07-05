import "./QuickEntryBox.css";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import type { ToastType } from "../hooks/useToast";
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, getErrorMessage } from "@fusion/core";
import type { Task, Settings, TaskPriority, ResolvedWorkflowOptionalStep } from "@fusion/core";
import type { ModelInfo, Agent, CreateTaskInput, DuplicateMatch, BoardWorkflowDefinition, NodeInfo } from "../api";
import { checkDuplicateTasks, fetchModels, fetchSettings, updateGlobalSettings, fetchAgents, uploadAttachment, fetchWorkflowOptionalSteps } from "../api";
import { DuplicateWarningModal } from "./DuplicateWarningModal";
import { Link, Paperclip, Brain, Lightbulb, ListTree, Sparkles, Save, ChevronDown, ChevronUp, ChevronRight, Bot, Server, Flag } from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { LoadingSpinner } from "./LoadingSpinner";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";
import { useNodes } from "../hooks/useNodes";
import { NodeHealthDot } from "./NodeHealthDot";
import { ProviderIcon } from "./ProviderIcon";
import { WorkflowOptionalStepsDropdown } from "./WorkflowOptionalStepsDropdown";
import { WorkflowIcon } from "./WorkflowIcon";

const STORAGE_KEY = "kb-quick-entry-text";
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface PendingImage {
  file: File;
  previewUrl: string;
}

interface QuickEntryBoxProps {
  onCreate?: (input: CreateTaskInput) => Promise<Task | void>;
  addToast: (message: string, type?: ToastType) => void;
  tasks?: Task[];
  availableModels?: ModelInfo[];
  /**
   * Preserved for callers that still pass planning handoff props through shared quick-create plumbing.
   * QuickEntryBox intentionally does not render a quick-add Plan button.
   */
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  /**
   * Called when the user clicks the "Subtask" button to trigger subtask breakdown.
   */
  onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
  /** Selected workflow lane for AI-assisted create actions. Omit in legacy board mode to preserve project-default inheritance. */
  workflowId?: string | null;
  /** Real workflows available to the quick-add workflow selector. Board-only aggregate sentinels must be filtered before rendering/submission. */
  workflowOptions?: BoardWorkflowDefinition[];
  /** Project/default workflow id used when the parent view is aggregate or stale. */
  defaultWorkflowId?: string | null;
  /** Optional project context for API calls */
  projectId?: string;
  /**
   * When true, the component automatically expands when focused.
   * Set to false to keep the view collapsed until manually toggled.
   * Defaults to true for backward compatibility.
   */
  autoExpand?: boolean;
  /*
  FNXC:QuickEntry 2026-06-22-01:10:
  Initial disclosure (expanded controls) state. List view passes false so quick-add starts COLLAPSED; Board/columns keep the default true so quick-add stays OPEN. This is independent of autoExpand (which only governs expand-on-focus).
  */
  defaultExpanded?: boolean;
  /*
  FNXC:QuickEntry 2026-06-22-19:25:
  List view renders quick-add as a COMPACT single-line input so the box isn't tall. When true, the textarea stays one line: isExpanded initializes false, focus does NOT auto-expand it, and auto-resize-to-scrollHeight is short-circuited (capped to the one-line min-height). Board/columns omit singleLine, preserving the tall 80px + auto-grow behavior. singleLine governs only textarea height, not the disclosure/controls panel (which List already collapses via defaultExpanded={false}).
  */
  singleLine?: boolean;
  /**
   * Favorited provider IDs from shared app-level state.
   * When provided (alongside availableModels), the component uses these
   * instead of its own internal favorite state.
   */
  favoriteProviders?: string[];
  /**
   * Favorited model IDs from shared app-level state.
   * When provided (alongside availableModels), the component uses these
   * instead of its own internal favorite state.
   */
  favoriteModels?: string[];
  /**
   * Toggle favorite provider callback from shared app-level state.
   */
  onToggleFavorite?: (provider: string) => void;
  /**
   * Toggle favorite model callback from shared app-level state.
   */
  onToggleModelFavorite?: (modelId: string) => void;
  onOpenTask?: (id: string) => void;
}

function getModelSelectionValue(provider?: string, modelId?: string): string {
  return provider && modelId ? `${provider}/${modelId}` : "";
}

function parseModelSelection(value: string): { provider?: string; modelId?: string } {
  if (!value) {
    return { provider: undefined, modelId: undefined };
  }

  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) {
    return { provider: undefined, modelId: undefined };
  }

  return {
    provider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
}

function getRealWorkflowOptions(workflowOptions: BoardWorkflowDefinition[] | undefined): BoardWorkflowDefinition[] {
  return (workflowOptions ?? []).filter((workflow) => workflow.id !== "__all_workflows__");
}

function resolveQuickAddWorkflowId(
  parentWorkflowId: string | null | undefined,
  defaultWorkflowId: string | null | undefined,
  workflowOptions: BoardWorkflowDefinition[],
): string | null | undefined {
  if (parentWorkflowId === undefined) return undefined;
  if (parentWorkflowId === null) return null;
  if (workflowOptions.length === 0) return parentWorkflowId === "__all_workflows__" ? null : parentWorkflowId;
  const validIds = new Set(workflowOptions.map((workflow) => workflow.id));
  if (validIds.has(parentWorkflowId)) return parentWorkflowId;
  if (defaultWorkflowId && validIds.has(defaultWorkflowId)) return defaultWorkflowId;
  return workflowOptions[0]?.id ?? null;
}

function hasMeaningfulNodeChoice(nodes: NodeInfo[]): boolean {
  /*
  FNXC:QuickAddNodeRouting 2026-06-30-00:00:
  Local-only projects should not show a Node button because the project-default route already means local execution. Keep the picker only when a remote or second registered node makes routing a real choice.
  */
  return nodes.length > 1 || nodes.some((node) => node.type !== "local");
}

export function QuickEntryBox({ onCreate, addToast, tasks = [], availableModels, onSubtaskBreakdown, workflowId, workflowOptions, defaultWorkflowId, projectId, autoExpand = true, defaultExpanded = true, singleLine = false, favoriteProviders: parentFavoriteProviders, favoriteModels: parentFavoriteModels, onToggleFavorite: parentToggleFavorite, onToggleModelFavorite: parentToggleModelFavorite, onOpenTask }: QuickEntryBoxProps) {
  const { t } = useTranslation("app");
  const [description, setDescription] = useState(() => {
    if (typeof window !== "undefined") {
      return getScopedItem(STORAGE_KEY, projectId) || "";
    }
    return "";
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  // isExpanded controls textarea height styling (auto-resize)
  // FNXC:QuickEntry 2026-06-22-19:25: singleLine (List view) starts collapsed so the textarea is one line, not the tall 80px variant.
  const [isExpanded, setIsExpanded] = useState(!singleLine);
  // isDisclosureExpanded controls visibility of the controls panel (Deps, Models, etc.)
  // Starts expanded by default — controls visible immediately
  const [isDisclosureExpanded, setIsDisclosureExpanded] = useState(defaultExpanded);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const touchButtonRef = useRef<HTMLButtonElement | null>(null);
  const justResetRef = useRef(false);
  const previousProjectIdRef = useRef(projectId);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  // Rich creation state (mirrors InlineCreateCard)
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsProjectId, setAgentsProjectId] = useState<string | undefined>(undefined);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [showNodePicker, setShowNodePicker] = useState(false);
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [activeModelSubmenu, setActiveModelSubmenu] = useState<"plan" | "executor" | "validator" | null>(null);
  const [executorProvider, setExecutorProvider] = useState<string | undefined>(undefined);
  const [executorModelId, setExecutorModelId] = useState<string | undefined>(undefined);
  const [validatorProvider, setValidatorProvider] = useState<string | undefined>(undefined);
  const [validatorModelId, setValidatorModelId] = useState<string | undefined>(undefined);
  const [planningProvider, setPlanningProvider] = useState<string | undefined>(undefined);
  const [planningModelId, setPlanningModelId] = useState<string | undefined>(undefined);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelMenuPortalRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const agentPickerPortalRef = useRef<HTMLDivElement>(null);
  const nodePickerRef = useRef<HTMLDivElement>(null);
  const nodePickerPortalRef = useRef<HTMLDivElement>(null);
  const priorityPickerRef = useRef<HTMLDivElement>(null);
  const priorityPickerPortalRef = useRef<HTMLDivElement>(null);
  const [agentPickerPosition, setAgentPickerPosition] = useState<{ top: number; left: number; width: number; maxHeight?: number } | null>(null);
  const [nodePickerPosition, setNodePickerPosition] = useState<{ top: number; left: number; width: number; maxHeight?: number } | null>(null);
  const [priorityPickerPosition, setPriorityPickerPosition] = useState<{ top: number; left: number; width: number; maxHeight?: number } | null>(null);
  const [modelMenuPosition, setModelMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight?: number } | null>(null);
  // Dependency dropdown portal refs and state
  const depTriggerRef = useRef<HTMLButtonElement>(null);
  const depDropdownPortalRef = useRef<HTMLDivElement>(null);
  const [depDropdownPosition, setDepDropdownPosition] = useState<{ top: number; left: number; width: number; maxHeight?: number } | null>(null);
  const [portalRoot] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.body : null,
  );
  const realWorkflowOptions = useMemo(() => getRealWorkflowOptions(workflowOptions), [workflowOptions]);
  const workflowPickerRef = useRef<HTMLDivElement>(null);
  const workflowTriggerRef = useRef<HTMLButtonElement>(null);
  const workflowPickerPortalRef = useRef<HTMLDivElement>(null);
  const [workflowPickerPosition, setWorkflowPickerPosition] = useState<{ top: number; left: number; width: number; maxHeight?: number } | null>(null);
  const previousWorkflowDefaultRef = useRef<{ workflowId: string | null | undefined; defaultWorkflowId: string | null | undefined }>({ workflowId, defaultWorkflowId });
  const [showWorkflowPicker, setShowWorkflowPicker] = useState(false);
  /*
  FNXC:QuickAddWorkflow 2026-06-30-00:00:
  Quick-add needs an independent real workflow target because the main Board selector can be on the aggregate "All workflows" read view. Resolve only against real workflow ids and keep the aggregate sentinel out of task create, Plan, Subtask, and optional-step requests.
  */
  const [quickEntryWorkflowId, setQuickEntryWorkflowId] = useState<string | null | undefined>(() => (
    resolveQuickAddWorkflowId(workflowId, defaultWorkflowId, getRealWorkflowOptions(workflowOptions))
  ));
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>(availableModels ?? []);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | undefined>(undefined);
  const [optionalSteps, setOptionalSteps] = useState<ResolvedWorkflowOptionalStep[]>([]);
  const [enabledOptionalStepIds, setEnabledOptionalStepIds] = useState<string[]>([]);
  const [isFastMode, setIsFastMode] = useState(false);
  const isFastModeRef = useRef(isFastMode);
  useEffect(() => {
    isFastModeRef.current = isFastMode;
  }, [isFastMode]);
  const [githubTrackingOverride, setGithubTrackingOverride] = useState<boolean | null>(null);
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [nodeId, setNodeId] = useState<string | undefined>(undefined);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[] | null>(null);
  const submitInFlightRef = useRef(false);
  const { nodes } = useNodes();
  const shouldShowNodePicker = useMemo(() => hasMeaningfulNodeChoice(nodes), [nodes]);
  const selectedNode = shouldShowNodePicker && nodeId ? nodes.find((node) => node.id === nodeId) : undefined;
  const effectiveNodeId = shouldShowNodePicker && selectedNode ? selectedNode.id : undefined;
  useEffect(() => {
    if (shouldShowNodePicker && (!nodeId || selectedNode)) {
      return;
    }

    setNodeId(undefined);
    setShowNodePicker(false);
    setNodePickerPosition(null);
  }, [nodeId, selectedNode, shouldShowNodePicker]);

  // Use parent-provided favorites when available, otherwise internal state
  const effectiveFavoriteProviders = parentFavoriteProviders ?? favoriteProviders;
  const effectiveFavoriteModels = parentFavoriteModels ?? favoriteModels;

  // If onCreate is not provided, the component is disabled
  const isDisabled = !onCreate;

  // Fetch models if not provided by parent
  useEffect(() => {
    if (availableModels) {
      setLoadedModels(availableModels);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }

    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    fetchModels()
      .then((response) => {
        if (!cancelled) {
          setLoadedModels(response.models);
          // Only set internal favorites when parent doesn't manage them
          if (!parentFavoriteProviders) {
            setFavoriteProviders(response.favoriteProviders);
          }
          if (!parentFavoriteModels) {
            setFavoriteModels(response.favoriteModels);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setModelsError(getErrorMessage(err) || t("tasks.loadModelsFailed", "Failed to load models"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setModelsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [availableModels, parentFavoriteProviders, parentFavoriteModels]);

  // Settings always drive toggle/preset behavior, regardless of model source.
  useEffect(() => {
    let cancelled = false;

    fetchSettings(projectId)
      .then((nextSettings) => {
        if (!cancelled) {
          setSettings(nextSettings);
        }
      })
      .catch(() => {
        // Silently ignore settings fetch failure
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /*
  FNXC:WorkflowOptionalSteps 2026-06-25-00:00:
  Quick-add creation needs the active workflow's optional steps in the immediate action row, seeded from each step's `defaultOn`, and forwarded through `enabledWorkflowSteps`. `null` workflow is an explicit no-workflow opt-out, while `undefined` inherits the project default so Board and List quick-add match TaskForm's create-time resolution.

  FNXC:WorkflowOptionalSteps 2026-06-26-05:10:
  Resolution MUST mirror the executor/store (explicit workflowId → project default → `builtin:coding`). The earlier `?? null` tail hid `builtin:coding`'s optional steps (browser-verification, code-review) whenever no project default workflow was configured, so operators never saw the toggles even though the unselected task runs `builtin:coding` (FN-7039). Fall back to `builtin:coding` once settings have loaded; stay `null` while settings are still loading so we don't fetch the wrong workflow then refetch.
  */
  const selectedQuickEntryWorkflow = typeof quickEntryWorkflowId === "string"
    ? realWorkflowOptions.find((option) => option.id === quickEntryWorkflowId)
    : undefined;
  const quickEntryWorkflowNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const option of realWorkflowOptions) {
      counts.set(option.name, (counts.get(option.name) ?? 0) + 1);
    }
    return counts;
  }, [realWorkflowOptions]);
  const showWorkflowSelector = workflowId !== undefined && realWorkflowOptions.length >= 2 && quickEntryWorkflowId !== null;
  const quickEntryWorkflowLabel = selectedQuickEntryWorkflow?.name ?? t("tasks.workflow", "Workflow");
  const selectedQuickEntryWorkflowIcon = selectedQuickEntryWorkflow?.icon;
  const selectedWorkflowForCreate = workflowId === undefined ? undefined : quickEntryWorkflowId;

  useEffect(() => {
    const parentChanged = previousWorkflowDefaultRef.current.workflowId !== workflowId
      || previousWorkflowDefaultRef.current.defaultWorkflowId !== defaultWorkflowId;
    previousWorkflowDefaultRef.current = { workflowId, defaultWorkflowId };
    setQuickEntryWorkflowId((current) => {
      const resolved = resolveQuickAddWorkflowId(workflowId, defaultWorkflowId, realWorkflowOptions);
      if (parentChanged) return resolved;
      if (typeof current === "string" && realWorkflowOptions.some((option) => option.id === current)) {
        return current;
      }
      return resolved;
    });
  }, [defaultWorkflowId, realWorkflowOptions, workflowId]);

  const effectiveOptionalWorkflowId =
    selectedWorkflowForCreate === null
      ? null
      : (selectedWorkflowForCreate ?? settings?.defaultWorkflowId ?? (settings ? "builtin:coding" : null));

  useEffect(() => {
    let cancelled = false;
    setOptionalSteps([]);
    setEnabledOptionalStepIds([]);

    if (!effectiveOptionalWorkflowId) {
      return () => {
        cancelled = true;
      };
    }

    fetchWorkflowOptionalSteps(effectiveOptionalWorkflowId, projectId)
      .then((steps) => {
        if (cancelled) return;
        setOptionalSteps(steps);
        /*
        FNXC:FastOptionalSteps 2026-06-30-10:24:
        Optional-step metadata can resolve after the operator has already selected Fast. Seed `[]` in that race so async defaultOn loading cannot undo Fast's speed-first opt-out; later dropdown clicks still add explicit selections normally.
        */
        setEnabledOptionalStepIds(isFastModeRef.current ? [] : steps.filter((step) => step.defaultOn).map((step) => step.templateId));
      })
      .catch(() => {
        if (cancelled) return;
        setOptionalSteps([]);
        setEnabledOptionalStepIds([]);
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveOptionalWorkflowId, projectId]);

  const toggleOptionalStep = useCallback((templateId: string) => {
    setEnabledOptionalStepIds((prev) => (
      prev.includes(templateId)
        ? prev.filter((id) => id !== templateId)
        : [...prev, templateId]
    ));
  }, []);

  /*
  FNXC:FastOptionalSteps 2026-06-30-09:05:
  Fast task creation is speed-first: switching standard → fast clears currently enabled optional workflow steps. The dropdown remains enabled so the operator can manually opt Browser Verification, Plan Review, Code Review, or a custom optional group back in before create.

  FNXC:FastOptionalSteps 2026-06-30-10:41:
  A Fast create must submit explicit `[]` even if optional-step metadata has not loaded yet; otherwise the store/engine see `enabledWorkflowSteps` as omitted and re-seed default-on gates.
  */
  const toggleFastMode = useCallback(() => {
    setIsFastMode((prev) => {
      const next = !prev;
      if (next) setEnabledOptionalStepIds([]);
      return next;
    });
  }, []);

  const executorSelectionValue = getModelSelectionValue(executorProvider, executorModelId);
  const validatorSelectionValue = getModelSelectionValue(validatorProvider, validatorModelId);
  const planningSelectionValue = getModelSelectionValue(planningProvider, planningModelId);

  const hasExecutorOverride = Boolean(executorProvider && executorModelId);
  const hasValidatorOverride = Boolean(validatorProvider && validatorModelId);
  const hasPlanningOverride = Boolean(planningProvider && planningModelId);
  const selectedModelCount = Number(hasExecutorOverride) + Number(hasValidatorOverride) + Number(hasPlanningOverride);
  const modelMenuLabel = selectedPresetId
    ? settings?.modelPresets?.find((p) => p.id === selectedPresetId)?.name ?? t("tasks.models", "Models")
    : selectedModelCount > 0
      ? t("tasks.modelsCount", { count: selectedModelCount, defaultValue_one: "{{count}} model", defaultValue_other: "{{count}} models" })
      : t("tasks.models", "Models");

  const getModelBadgeLabel = useCallback(
    (provider?: string, modelId?: string) => {
      if (!provider || !modelId) return t("tasks.usingDefault", "Using default");
      const matched = loadedModels.find((model) => model.provider === provider && model.id === modelId);
      return matched ? `${matched.provider}/${matched.id}` : `${provider}/${modelId}`;
    },
    [loadedModels],
  );

  useEffect(() => {
    setDescription(getScopedItem(STORAGE_KEY, projectId) || "");
  }, [projectId]);

  // Persist description to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      setScopedItem(STORAGE_KEY, description, projectId);
    }
  }, [description, projectId]);

  // Clear agents cache when projectId changes to prevent stale agents from leaking across projects
  useEffect(() => {
    if (previousProjectIdRef.current === projectId) {
      return;
    }
    previousProjectIdRef.current = projectId;
    setAgents([]);
    setAgentsProjectId(undefined);
    setSelectedAgentId(null);
    setShowAgentPicker(false);
    setAgentPickerPosition(null);
  }, [projectId]);

  // Clean up legacy disclosure persistence key from previous versions
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("kb-quick-entry-expanded");
    }
  }, []);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  // Cleanup image preview URLs on unmount
  useEffect(() => {
    return () => {
      pendingImagesRef.current.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
  }, []);

  // Auto-resize textarea based on content
  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get accurate scrollHeight
    textarea.style.height = "auto";
    // Set to scrollHeight (capped at max-height via CSS)
    const newHeight = Math.min(textarea.scrollHeight, 200);
    textarea.style.height = `${newHeight}px`;
  }, []);

  // Resize when description changes (not in fullscreen mode since CSS handles it)
  // FNXC:QuickEntry 2026-06-22-19:25: singleLine (List view) must stay one line — skip auto-resize-to-scrollHeight so the textarea never grows tall with content; CSS clamps it to the one-line height.
  useEffect(() => {
    if (isExpanded && !singleLine) {
      autoResize();
    }
  }, [description, isExpanded, autoResize, singleLine]);

  /*
  FNXC:QuickEntryFocus 2026-06-25-00:00:
  After a successful task creation, the quick-entry textarea must not re-focus itself on any surface, desktop or mobile. The user explicitly does not want focus to return to the input after adding a task, superseding FN-6217/FN-6219; keep clearing the form on submit.
  */

  // Clear dep search when dropdown closes
  useEffect(() => {
    if (!showDeps) setDepSearch("");
  }, [showDeps]);

  // Close model menu when clicking outside
  useEffect(() => {
    if (!isModelMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInsideTrigger = modelTriggerRef.current?.contains(target);
      const clickedInsidePortal = modelMenuPortalRef.current?.contains(target);
      // Also check for clicks inside CustomModelDropdown's portaled dropdown
      const clickedInsideCombobox = (target instanceof Element) && (target.closest?.(".model-combobox-dropdown--portal") != null);

      if (!clickedInsideTrigger && !clickedInsidePortal && !clickedInsideCombobox) {
        setIsModelMenuOpen(false);
        setActiveModelSubmenu(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isModelMenuOpen]);

  useEffect(() => {
    if (!showNodePicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (nodePickerRef.current?.contains(target)) return;
      if (nodePickerPortalRef.current?.contains(target)) return;
      setShowNodePicker(false);
      setNodePickerPosition(null);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showNodePicker]);

  useEffect(() => {
    if (!showAgentPicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Check both the trigger button and the portaled dropdown
      if (agentPickerRef.current?.contains(target)) return;
      if (agentPickerPortalRef.current?.contains(target)) return;
      setShowAgentPicker(false);
      setAgentPickerPosition(null);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showAgentPicker]);

  useEffect(() => {
    if (!showPriorityPicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (priorityPickerRef.current?.contains(target)) return;
      if (priorityPickerPortalRef.current?.contains(target)) return;
      setShowPriorityPicker(false);
      setPriorityPickerPosition(null);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPriorityPicker]);

  useEffect(() => {
    if (!showWorkflowPicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (workflowPickerRef.current?.contains(target)) return;
      if (workflowPickerPortalRef.current?.contains(target)) return;
      setShowWorkflowPicker(false);
      setWorkflowPickerPosition(null);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showWorkflowPicker]);

  const resetForm = useCallback(() => {
    pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setPendingImages([]);
    dragDepthRef.current = 0;
    setIsFileDragOver(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    setDescription("");
    setDependencies([]);
    setSelectedAgentId(null);
    setShowAgentPicker(false);
    setAgentPickerPosition(null);
    setShowNodePicker(false);
    setNodePickerPosition(null);
    setShowPriorityPicker(false);
    setPriorityPickerPosition(null);
    setExecutorProvider(undefined);
    setExecutorModelId(undefined);
    setValidatorProvider(undefined);
    setValidatorModelId(undefined);
    setPlanningProvider(undefined);
    setPlanningModelId(undefined);
    setSelectedPresetId(undefined);
    setEnabledOptionalStepIds(optionalSteps.filter((step) => step.defaultOn).map((step) => step.templateId));
    setIsFastMode(false);
    setGithubTrackingOverride(null);
    setPriority(DEFAULT_TASK_PRIORITY);
    setNodeId(undefined);
    setShowDeps(false);
    setIsModelMenuOpen(false);
    setModelMenuPosition(null);
    setActiveModelSubmenu(null);
    justResetRef.current = true;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Clear localStorage when form is reset (after successful creation)
    if (typeof window !== "undefined") {
      removeScopedItem(STORAGE_KEY, projectId);
    }
  }, [pendingImages, projectId, optionalSteps]);

  const handleImageFiles = useCallback((files: FileList | File[] | null | undefined) => {
    if (!files || files.length === 0) return;

    const newImages: PendingImage[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
        newImages.push({ file, previewUrl: URL.createObjectURL(file) });
      }
    }

    if (newImages.length > 0) {
      setPendingImages((prev) => [...prev, ...newImages]);
    }
  }, []);

  const isFileDrag = useCallback((dataTransfer: DataTransfer | null) => {
    if (!dataTransfer) return false;
    return Array.from(dataTransfer.types ?? []).includes("Files");
  }, []);

  /*
  FNXC:QuickAddAttachments 2026-06-30-00:00:
  Quick Add uses an icon-only paperclip to keep the action row compact, so the accessible name and title carry the Attach action plus pending-image count. The same image intake path handles file input, paste, and file drag/drop so previews and post-create uploads stay consistent.
  */
  const attachLabel = pendingImages.length > 0
    ? t("tasks.attachImagesCount", "Attach images ({{count}} pending)", { count: pendingImages.length })
    : t("tasks.attachImages", "Attach images");

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsFileDragOver(true);
  }, [isFileDrag]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }, [isFileDrag]);

  const clearFileDragState = useCallback(() => {
    dragDepthRef.current = 0;
    setIsFileDragOver(false);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsFileDragOver(false);
    }
  }, [isFileDrag]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    clearFileDragState();
    if (isSubmitting) return;
    handleImageFiles(e.dataTransfer.files);
  }, [clearFileDragState, handleImageFiles, isFileDrag, isSubmitting]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitting) return;
    handleImageFiles(e.clipboardData?.files);
  }, [handleImageFiles, isSubmitting]);

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const removed = prev[index];
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const submitCreateTask = useCallback(async (trimmed: string, overrides?: { acknowledgedDuplicates?: string[] }) => {
    if (!onCreate) {
      return;
    }

    const originalDescription = description;
    setDescription("");
    try {
      /*
      FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
      Do not hard-code `column: "triage"` — the store resolves the landing column from the forwarded (or project-default) workflow's intake column, so a manual-intake workflow (e.g. Coding (Ideas) → "ideas") parks the card for the operator instead of being auto-triaged.
      */
      const createdTask = await onCreate({
        description: trimmed,
        ...(selectedWorkflowForCreate !== undefined ? { workflowId: selectedWorkflowForCreate } : {}),
        dependencies: dependencies.length ? dependencies : undefined,
        ...(selectedAgentId ? { assignedAgentId: selectedAgentId } : {}),
        modelPresetId: selectedPresetId,
        modelProvider: hasExecutorOverride ? executorProvider : undefined,
        modelId: hasExecutorOverride ? executorModelId : undefined,
        validatorModelProvider: hasValidatorOverride ? validatorProvider : undefined,
        validatorModelId: hasValidatorOverride ? validatorModelId : undefined,
        planningModelProvider: hasPlanningOverride ? planningProvider : undefined,
        planningModelId: hasPlanningOverride ? planningModelId : undefined,
        /*
        FNXC:QuickAddWorkflowSteps 2026-06-29-01:31:
        Quick Add optional-step toggles are explicit task intent. When the workflow exposes optional steps and the user unchecks every one, submit an empty array instead of omitting the field so default-on Plan Review / Code Review do not reappear on the created task.
        */
        enabledWorkflowSteps: isFastMode || optionalSteps.length > 0 ? enabledOptionalStepIds : undefined,
        ...(isFastMode ? { executionMode: "fast" } : {}),
        githubTracking: githubTrackingOverride !== null ? { enabled: githubTrackingOverride } : undefined,
        priority,
        nodeId: effectiveNodeId,
        acknowledgedDuplicates: overrides?.acknowledgedDuplicates,
      });
      if (createdTask && pendingImages.length > 0) {
        const failures: string[] = [];
        for (const pendingImage of pendingImages) {
          try {
            await uploadAttachment(createdTask.id, pendingImage.file, projectId);
          } catch {
            failures.push(pendingImage.file.name);
          }
        }

        if (failures.length > 0) {
          addToast(t("tasks.uploadFailed", "Failed to upload: {{files}}", { files: failures.join(", ") }), "error");
        }
      }
      resetForm();
    } catch (err) {
      setDescription(originalDescription);
      addToast(getErrorMessage(err) || t("tasks.createFailed", "Failed to create task"), "error");
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    onCreate,
    description,
    dependencies,
    selectedWorkflowForCreate,
    selectedAgentId,
    selectedPresetId,
    hasExecutorOverride,
    executorProvider,
    executorModelId,
    hasValidatorOverride,
    validatorProvider,
    validatorModelId,
    hasPlanningOverride,
    planningProvider,
    planningModelId,
    enabledOptionalStepIds,
    isFastMode,
    settings,
    githubTrackingOverride,
    priority,
    effectiveNodeId,
    pendingImages,
    projectId,
    addToast,
    resetForm,
  ]);

  const handleSubmit = useCallback(async () => {
    if (submitInFlightRef.current) {
      return;
    }

    submitInFlightRef.current = true;
    setIsSubmitting(true);

    const trimmed = description.trim();
    if (!trimmed || !onCreate) {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
      return;
    }

    let releaseLockOnExit = true;
    try {
      const matches = await checkDuplicateTasks({ description: trimmed }, projectId);
      if (matches.length > 0) {
        setDuplicateMatches(matches);
        releaseLockOnExit = false;
        return;
      }
    } catch (_error) {
      addToast(t("tasks.duplicateCheckFailed", "Duplicate check failed; creating task anyway."), "error");
    }

    releaseLockOnExit = false;
    await submitCreateTask(trimmed);

    if (releaseLockOnExit) {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }, [description, onCreate, projectId, submitCreateTask, addToast]);

  const handleDuplicateOpen = useCallback((taskId: string) => {
    if (onOpenTask) {
      onOpenTask(taskId);
    } else if (typeof window !== "undefined") {
      window.location.hash = `#/tasks/${taskId}`;
    }
    setDuplicateMatches(null);
  }, [onOpenTask]);

  const handleDuplicateProceed = useCallback(async () => {
    const trimmed = description.trim();
    const matches = duplicateMatches;
    if (!trimmed || !matches || matches.length === 0) {
      setDuplicateMatches(null);
      submitInFlightRef.current = false;
      setIsSubmitting(false);
      return;
    }

    setDuplicateMatches(null);
    // Keep optimistic submit lock active while duplicate-confirmed creation is in flight.
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    await submitCreateTask(trimmed, { acknowledgedDuplicates: matches.map((match) => match.id) });
  }, [description, duplicateMatches, submitCreateTask]);

  const handleDuplicateCancel = useCallback(() => {
    setDuplicateMatches(null);
    submitInFlightRef.current = false;
    setIsSubmitting(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter") {
        if (e.shiftKey) {
          // Allow Shift+Enter to insert a newline in any quick-entry state
          // Don't prevent default - let the newline be inserted
          // FNXC:QuickEntry 2026-06-22-19:25: singleLine (List view) stays one line even on Shift+Enter — do not expand the textarea.
          if (!singleLine) {
            setIsExpanded(true);
          }
          return;
        }
        // Enter without Shift submits
        e.preventDefault();
        if (duplicateMatches || submitInFlightRef.current) {
          return;
        }
        handleSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Close model submenu first if open
        if (activeModelSubmenu) {
          setActiveModelSubmenu(null);
          return;
        }
        // Close model menu if open
        if (isModelMenuOpen) {
          setIsModelMenuOpen(false);
          setModelMenuPosition(null);
          return;
        }
        if (showDeps) {
          setShowDeps(false);
          return;
        }
        if (showNodePicker) {
          setShowNodePicker(false);
          setNodePickerPosition(null);
          return;
        }
        if (showPriorityPicker) {
          setShowPriorityPicker(false);
          setPriorityPickerPosition(null);
          return;
        }
        if (showWorkflowPicker) {
          setShowWorkflowPicker(false);
          setWorkflowPickerPosition(null);
          return;
        }
        if (showAgentPicker) {
          setShowAgentPicker(false);
          setAgentPickerPosition(null);
          return;
        }
        // Clear non-empty input on Escape and clear localStorage
        if (description.trim()) {
          setDescription("");
          // Reset height
          if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
          }
          // Clear localStorage when user explicitly clears input
          if (typeof window !== "undefined") {
            removeScopedItem(STORAGE_KEY, projectId);
          }
        }
        // Collapse textarea and disclosure on escape
        setIsExpanded(false);
        setIsDisclosureExpanded(false);
        textareaRef.current?.blur();
      }
    },
    [
      handleSubmit,
      description,
      isExpanded,
      showDeps,
      showAgentPicker,
      showNodePicker,
      isModelMenuOpen,
      activeModelSubmenu,
      showPriorityPicker,
      showWorkflowPicker,
      projectId,
      setIsDisclosureExpanded,
      duplicateMatches,
      singleLine,
    ],
  );

  const handleBlur = useCallback(() => {
    // No auto-collapse on blur — state persists until manually toggled or task is submitted/cancelled
    // Only clear the justResetRef flag if needed
    if (justResetRef.current) {
      justResetRef.current = false;
    }
  }, []);

  const handleFocus = useCallback(() => {
    // Auto-expand on focus when autoExpand prop is true (default)
    // FNXC:QuickEntry 2026-06-22-19:25: never auto-expand the textarea on focus when singleLine (List view) — it must stay one line.
    if (autoExpand && !singleLine) {
      setIsExpanded(true);
    }
  }, [autoExpand, singleLine]);

  const toggleDep = useCallback((id: string) => {
    setDependencies((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  }, []);

  const getEffectiveViewport = useCallback(() => {
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) {
      return {
        width: vv.width,
        height: vv.height,
        offsetTop: vv.offsetTop,
        offsetLeft: vv.offsetLeft,
      };
    }

    return {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
    };
  }, []);

  const updateModelMenuPosition = useCallback(() => {
    const trigger = modelTriggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 4;
    const isMobile = viewportWidth <= 768;

    const preferredHeight = isMobile
      ? Math.min(viewportHeight * 0.6, 360)
      : Math.min(viewportHeight * 0.5, 360);

    const preferredDesktopWidth = Math.max(rect.width * 1.35, 320);
    const preferredWidth = isMobile
      ? Math.min(viewportWidth - horizontalPadding * 2, 360)
      : preferredDesktopWidth;

    const width = Math.min(
      preferredWidth,
      Math.max(viewportWidth - horizontalPadding * 2, 240),
    );

    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;

    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const availableBelow = Math.max(spaceBelow - verticalPadding - gap, 160);
    const availableAbove = Math.max(spaceAbove - verticalPadding - gap, 160);
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;

    const maxHeight = Math.max(
      Math.min(openUpward ? availableAbove : availableBelow, preferredHeight),
      160,
    );

    const left = Math.min(
      Math.max(triggerLeft, horizontalPadding),
      viewportWidth - horizontalPadding - width,
    ) + offsetLeft;

    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - maxHeight - gap + offsetTop)
      : Math.min(
          triggerBottom + gap + offsetTop,
          viewportHeight + offsetTop - verticalPadding - maxHeight,
        );

    setModelMenuPosition({
      top,
      left,
      width,
      maxHeight,
    });
  }, [getEffectiveViewport]);

  const updateWorkflowPickerPosition = useCallback(() => {
    const trigger = workflowTriggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 4;
    const isMobile = viewportWidth <= 768;
    const preferredHeight = Math.min(viewportHeight * (isMobile ? 0.6 : 0.5), 360);
    /*
    FNXC:QuickAddWorkflow 2026-06-30-16:16:
    The workflow menu is wider than its compact trigger, so portal and clamp it against the visual viewport instead of anchoring it to the trigger's inline start. This keeps right-side Board columns and wrapped mobile action rows readable without horizontal overflow.
    */
    const preferredWidth = isMobile
      ? Math.min(viewportWidth - horizontalPadding * 2, 448)
      : Math.min(Math.max(rect.width * 3, 448), 512);
    const width = Math.min(
      preferredWidth,
      Math.max(viewportWidth - horizontalPadding * 2, 240),
    );

    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;
    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const availableBelow = Math.max(spaceBelow - verticalPadding - gap, 180);
    const availableAbove = Math.max(spaceAbove - verticalPadding - gap, 180);
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      Math.min(openUpward ? availableAbove : availableBelow, preferredHeight),
      180,
    );

    const left = Math.min(
      Math.max(triggerLeft, horizontalPadding),
      viewportWidth - horizontalPadding - width,
    ) + offsetLeft;
    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - maxHeight - gap + offsetTop)
      : Math.min(
          triggerBottom + gap + offsetTop,
          viewportHeight + offsetTop - verticalPadding - maxHeight,
        );

    setWorkflowPickerPosition({ top, left, width, maxHeight });
  }, [getEffectiveViewport]);

  const updateDepDropdownPosition = useCallback(() => {
    const trigger = depTriggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 4;
    const isMobile = viewportWidth <= 768;

    const preferredHeight = isMobile
      ? Math.min(viewportHeight * 0.6, 320)
      : Math.min(viewportHeight * 0.5, 320);

    // Wider dropdown for dependency selection - easier to read task names
    const preferredWidth = isMobile
      ? Math.min(viewportWidth - horizontalPadding * 2, 360)
      : Math.max(rect.width, 280);

    const width = Math.min(
      preferredWidth,
      Math.max(viewportWidth - horizontalPadding * 2, 240),
    );

    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;

    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const availableBelow = Math.max(spaceBelow - verticalPadding - gap, 200);
    const availableAbove = Math.max(spaceAbove - verticalPadding - gap, 200);
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;

    const maxHeight = Math.max(
      Math.min(openUpward ? availableAbove : availableBelow, preferredHeight),
      200,
    );

    const left = Math.min(
      Math.max(triggerLeft, horizontalPadding),
      viewportWidth - horizontalPadding - width,
    ) + offsetLeft;

    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - maxHeight - gap + offsetTop)
      : Math.min(
          triggerBottom + gap + offsetTop,
          viewportHeight + offsetTop - verticalPadding - maxHeight,
        );

    setDepDropdownPosition({
      top,
      left,
      width,
      maxHeight,
    });
  }, [getEffectiveViewport]);

  const updateAgentPickerPosition = useCallback(() => {
    const trigger = agentPickerRef.current?.querySelector("button") as HTMLButtonElement | null;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 4;
    const isMobile = viewportWidth <= 768;

    const preferredHeight = isMobile
      ? Math.min(viewportHeight * 0.6, 320)
      : Math.min(viewportHeight * 0.5, 320);

    const preferredWidth = isMobile
      ? Math.min(viewportWidth - horizontalPadding * 2, 280)
      : Math.max(rect.width, 240);

    const width = Math.min(
      preferredWidth,
      Math.max(viewportWidth - horizontalPadding * 2, 200),
    );

    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;

    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const availableBelow = Math.max(spaceBelow - verticalPadding - gap, 160);
    const availableAbove = Math.max(spaceAbove - verticalPadding - gap, 160);
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;

    const maxHeight = Math.max(
      Math.min(openUpward ? availableAbove : availableBelow, preferredHeight),
      160,
    );

    const left = Math.min(
      Math.max(triggerLeft, horizontalPadding),
      viewportWidth - horizontalPadding - width,
    ) + offsetLeft;

    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - maxHeight - gap + offsetTop)
      : Math.min(
          triggerBottom + gap + offsetTop,
          viewportHeight + offsetTop - verticalPadding - maxHeight,
        );

    setAgentPickerPosition({
      top,
      left,
      width,
      maxHeight,
    });
  }, [getEffectiveViewport]);

  const updateNodePickerPosition = useCallback(() => {
    const trigger = nodePickerRef.current?.querySelector("button") as HTMLButtonElement | null;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 4;
    const isMobile = viewportWidth <= 768;

    const preferredHeight = isMobile
      ? Math.min(viewportHeight * 0.6, 320)
      : Math.min(viewportHeight * 0.5, 320);

    const preferredWidth = isMobile
      ? Math.min(viewportWidth - horizontalPadding * 2, 280)
      : Math.max(rect.width, 240);

    const width = Math.min(
      preferredWidth,
      Math.max(viewportWidth - horizontalPadding * 2, 200),
    );

    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;

    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const availableBelow = Math.max(spaceBelow - verticalPadding - gap, 160);
    const availableAbove = Math.max(spaceAbove - verticalPadding - gap, 160);
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;

    const maxHeight = Math.max(
      Math.min(openUpward ? availableAbove : availableBelow, preferredHeight),
      160,
    );

    const left = Math.min(
      Math.max(triggerLeft, horizontalPadding),
      viewportWidth - horizontalPadding - width,
    ) + offsetLeft;

    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - maxHeight - gap + offsetTop)
      : Math.min(
          triggerBottom + gap + offsetTop,
          viewportHeight + offsetTop - verticalPadding - maxHeight,
        );

    setNodePickerPosition({
      top,
      left,
      width,
      maxHeight,
    });
  }, [getEffectiveViewport]);

  const updatePriorityPickerPosition = useCallback(() => {
    const trigger = priorityPickerRef.current?.querySelector("button") as HTMLButtonElement | null;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 4;
    const preferredHeight = 220;
    const width = Math.min(
      Math.max(rect.width, 200),
      Math.max(viewportWidth - horizontalPadding * 2, 200),
    );

    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;

    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const availableBelow = Math.max(spaceBelow - verticalPadding - gap, 160);
    const availableAbove = Math.max(spaceAbove - verticalPadding - gap, 160);
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      Math.min(openUpward ? availableAbove : availableBelow, preferredHeight),
      160,
    );

    const left = Math.min(
      Math.max(triggerLeft, horizontalPadding),
      viewportWidth - horizontalPadding - width,
    ) + offsetLeft;

    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - maxHeight - gap + offsetTop)
      : Math.min(
          triggerBottom + gap + offsetTop,
          viewportHeight + offsetTop - verticalPadding - maxHeight,
        );

    setPriorityPickerPosition({
      top,
      left,
      width,
      maxHeight,
    });
  }, [getEffectiveViewport]);

  // Keep model menu portal anchored during scroll/resize
  useEffect(() => {
    if (!isModelMenuOpen) return;

    const handleReposition = () => updateModelMenuPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", handleReposition);
      vv.addEventListener("scroll", handleReposition);
    }

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      if (vv) {
        vv.removeEventListener("resize", handleReposition);
        vv.removeEventListener("scroll", handleReposition);
      }
    };
  }, [isModelMenuOpen, updateModelMenuPosition]);

  // Keep workflow picker portal anchored during scroll/resize
  useEffect(() => {
    if (!showWorkflowPicker) return;

    const handleReposition = () => updateWorkflowPickerPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", handleReposition);
      vv.addEventListener("scroll", handleReposition);
    }

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      if (vv) {
        vv.removeEventListener("resize", handleReposition);
        vv.removeEventListener("scroll", handleReposition);
      }
    };
  }, [showWorkflowPicker, updateWorkflowPickerPosition]);

  // Keep dependency dropdown portal anchored during scroll/resize
  useEffect(() => {
    if (!showDeps) return;

    const handleReposition = () => updateDepDropdownPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", handleReposition);
      vv.addEventListener("scroll", handleReposition);
    }

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      if (vv) {
        vv.removeEventListener("resize", handleReposition);
        vv.removeEventListener("scroll", handleReposition);
      }
    };
  }, [showDeps, updateDepDropdownPosition]);

  // Keep agent picker portal anchored during scroll/resize
  useEffect(() => {
    if (!showAgentPicker) return;

    const handleReposition = () => updateAgentPickerPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", handleReposition);
      vv.addEventListener("scroll", handleReposition);
    }

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      if (vv) {
        vv.removeEventListener("resize", handleReposition);
        vv.removeEventListener("scroll", handleReposition);
      }
    };
  }, [showAgentPicker, updateAgentPickerPosition]);

  // Keep node picker portal anchored during scroll/resize
  useEffect(() => {
    if (!showNodePicker) return;

    const handleReposition = () => updateNodePickerPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", handleReposition);
      vv.addEventListener("scroll", handleReposition);
    }

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      if (vv) {
        vv.removeEventListener("resize", handleReposition);
        vv.removeEventListener("scroll", handleReposition);
      }
    };
  }, [showNodePicker, updateNodePickerPosition]);

  // Keep priority picker portal anchored during scroll/resize
  useEffect(() => {
    if (!showPriorityPicker) return;

    const handleReposition = () => updatePriorityPickerPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", handleReposition);
      vv.addEventListener("scroll", handleReposition);
    }

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      if (vv) {
        vv.removeEventListener("resize", handleReposition);
        vv.removeEventListener("scroll", handleReposition);
      }
    };
  }, [showPriorityPicker, updatePriorityPickerPosition]);

  const handlePlanningModelChange = useCallback((value: string) => {
    const next = parseModelSelection(value);
    setPlanningProvider(next.provider);
    setPlanningModelId(next.modelId);
  }, []);

  const handleExecutorChange = useCallback((value: string) => {
    const next = parseModelSelection(value);
    setExecutorProvider(next.provider);
    setExecutorModelId(next.modelId);
  }, []);

  const handleValidatorChange = useCallback((value: string) => {
    const next = parseModelSelection(value);
    setValidatorProvider(next.provider);
    setValidatorModelId(next.modelId);
  }, []);

  const handleToggleFavorite = useCallback(async (provider: string) => {
    // Delegate to parent callback when available
    if (parentToggleFavorite) {
      parentToggleFavorite(provider);
      return;
    }

    const currentFavorites = favoriteProviders;
    const isFavorite = currentFavorites.includes(provider);
    const newFavorites = isFavorite
      ? currentFavorites.filter((p) => p !== provider)
      : [provider, ...currentFavorites];

    setFavoriteProviders(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders: newFavorites, favoriteModels });
    } catch {
      // Revert on error
      setFavoriteProviders(currentFavorites);
    }
  }, [favoriteProviders, favoriteModels, parentToggleFavorite]);

  const handleToggleModelFavorite = useCallback(async (modelId: string) => {
    // Delegate to parent callback when available
    if (parentToggleModelFavorite) {
      parentToggleModelFavorite(modelId);
      return;
    }

    const currentFavorites = favoriteModels;
    const isFavorite = currentFavorites.includes(modelId);
    const newFavorites = isFavorite
      ? currentFavorites.filter((m) => m !== modelId)
      : [modelId, ...currentFavorites];

    setFavoriteModels(newFavorites);

    try {
      await updateGlobalSettings({ favoriteProviders, favoriteModels: newFavorites });
    } catch {
      // Revert on error
      setFavoriteModels(currentFavorites);
    }
  }, [favoriteModels, favoriteProviders, parentToggleModelFavorite]);

  /*
  FNXC:QuickEntry 2026-06-30-00:00:
  Quick-add intentionally exposes no Plan button, disabled Plan state, tooltip, test id, or click target. Keep non-quick-add planning entry points such as the New Task dialog and model-menu planning lane intact.
  */
  const handleSubtaskClick = useCallback(() => {
    const trimmed = description.trim();
    if (!trimmed) {
      addToast(t("tasks.enterDescriptionFirst", "Enter a description first"), "error");
      return;
    }
    if (selectedWorkflowForCreate !== undefined) {
      onSubtaskBreakdown?.(trimmed, selectedWorkflowForCreate);
    } else {
      onSubtaskBreakdown?.(trimmed);
    }
    // Clear the form after triggering subtask breakdown
    resetForm();
  }, [description, onSubtaskBreakdown, selectedWorkflowForCreate, addToast, resetForm]);

  const handleSaveClick = useCallback(() => {
    // Save button now creates the task (same as Enter key)
    handleSubmit();
  }, [handleSubmit]);

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  const loadModels = useCallback(async () => {
    if (availableModels) {
      setLoadedModels(availableModels);
      setModelsError(null);
      setModelsLoading(false);
      return;
    }

    setModelsLoading(true);
    setModelsError(null);
    try {
      const response = await fetchModels();
      setLoadedModels(response.models);
      // Only set internal favorites when parent doesn't manage them
      if (!parentFavoriteProviders) {
        setFavoriteProviders(response.favoriteProviders);
      }
      if (!parentFavoriteModels) {
        setFavoriteModels(response.favoriteModels);
      }
    } catch (err) {
      setModelsError(getErrorMessage(err) || t("tasks.loadModelsFailed", "Failed to load models"));
    } finally {
      setModelsLoading(false);
    }
  }, [availableModels, parentFavoriteProviders, parentFavoriteModels]);

  const loadAgents = useCallback(async () => {
    if (agents.length > 0 && agentsProjectId === projectId) {
      setShowAgentPicker(true);
      updateAgentPickerPosition();
      return;
    }

    setAgentsLoading(true);
    try {
      const result = await fetchAgents(undefined, projectId);
      setAgents(result);
      setAgentsProjectId(projectId);
      setShowAgentPicker(true);
      updateAgentPickerPosition();
    } catch (err) {
      const msg = getErrorMessage(err);
      addToast(msg ? t("tasks.loadAgentsFailed", "Failed to load agents: {{msg}}", { msg }) : t("tasks.loadAgentsFailedGeneric", "Failed to load agents"), "error");
      setShowAgentPicker(false);
    } finally {
      setAgentsLoading(false);
    }
  }, [agents.length, agentsProjectId, projectId, addToast, updateAgentPickerPosition]);

  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) : undefined;
  const selectedAgentLabel = selectedAgent?.name ?? selectedAgentId;
  const projectGithubTrackingDefault = settings?.githubTrackingEnabledByDefault === true;
  const effectiveGithubTracking = githubTrackingOverride ?? projectGithubTrackingDefault;
  const githubToggleLabel = effectiveGithubTracking
    ? t("tasks.githubTrackingOn", "GitHub tracking ON for next task (project default: {{default}})", { default: projectGithubTrackingDefault ? t("tasks.githubTrackingDefaultOn", "on") : t("tasks.githubTrackingDefaultOff", "off") })
    : t("tasks.githubTrackingOff", "GitHub tracking OFF for next task (project default: {{default}})", { default: projectGithubTrackingDefault ? t("tasks.githubTrackingDefaultOn", "on") : t("tasks.githubTrackingDefaultOff", "off") });

  // Show expanded controls based on disclosure state (user preference), not textarea focus
  const showExpandedControls = isDisclosureExpanded;

  const toggleExpanded = useCallback(() => {
    setIsDisclosureExpanded((prev) => {
      const next = !prev;
      setIsExpanded(next);
      return next;
    });
  }, []);

  return (
    <>
      <div
        className={`quick-entry-box ${isDisclosureExpanded ? "quick-entry-box--expanded" : "quick-entry-box--collapsed"}${singleLine ? " quick-entry--single-line" : ""}${isFileDragOver ? " quick-entry-box--drag-over" : ""}`}
        data-testid="quick-entry-box"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDragEnd={clearFileDragState}
        onDrop={handleDrop}
      >
      {isFileDragOver && (
        <div className="quick-entry-drop-target" data-testid="quick-entry-drop-target" aria-hidden="true">
          <Paperclip size={16} aria-hidden="true" />
          <span>{t("tasks.dropImagesToAttach", "Drop images to attach")}</span>
        </div>
      )}
      <div className="description-with-refine">
        <div className="quick-entry-main-row">
          <div className="quick-entry-textarea-wrap">
            <textarea
              ref={textareaRef}
              className={`quick-entry-input ${isExpanded && !singleLine ? "quick-entry-input--expanded" : ""}`}
              placeholder={isSubmitting ? t("tasks.creating", "Creating...") : t("tasks.addTaskPlaceholder", "Add a task...")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={handleFocus}
              onBlur={handleBlur}
              disabled={isSubmitting || isDisabled}
              data-testid="quick-entry-input"
              rows={singleLine ? 1 : 2}
              aria-controls="quick-entry-controls"
              aria-expanded={isDisclosureExpanded}
            />
          </div>
          <button
            type="button"
            className="btn btn-sm quick-entry-toggle"
            onClick={toggleExpanded}
            aria-expanded={isDisclosureExpanded}
            aria-controls="quick-entry-controls"
            data-testid="quick-entry-toggle"
            title={isDisclosureExpanded ? t("tasks.collapse", "Collapse") : t("tasks.expand", "Expand")}
          >
            {isDisclosureExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>
      <div
        id="quick-entry-controls"
        className="quick-entry-controls"
        hidden={!showExpandedControls}
        aria-hidden={!showExpandedControls}
      >
        {/* All quick-create actions behind single disclosure toggle */}
        {showExpandedControls && !isSubmitting && (
          <div
            className="quick-entry-actions"
            data-testid="quick-entry-actions"
            onTouchStart={(e: React.TouchEvent) => {
              const target = e.target;
              if (!(target instanceof Element)) return;
              const button = target.closest("button");
              if (button && !button.disabled) {
                if (document.activeElement === textareaRef.current) {
                  e.preventDefault();
                }
                touchButtonRef.current = button;
              }
            }}
            onTouchEnd={() => {
              touchButtonRef.current = null;
            }}
            onTouchCancel={() => {
              touchButtonRef.current = null;
            }}
          >
            {showWorkflowSelector && (
              <div className="quick-entry-workflow-wrap" ref={workflowPickerRef}>
                <button
                  ref={workflowTriggerRef}
                  type="button"
                  className="btn btn-sm dep-trigger quick-entry-workflow-trigger"
                  data-testid="quick-entry-workflow-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={showWorkflowPicker}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setShowDeps(false);
                    setShowAgentPicker(false);
                    setAgentPickerPosition(null);
                    setShowNodePicker(false);
                    setNodePickerPosition(null);
                    setShowPriorityPicker(false);
                    setPriorityPickerPosition(null);
                    setIsModelMenuOpen(false);
                    setModelMenuPosition(null);
                    setActiveModelSubmenu(null);
                    setShowWorkflowPicker((prev) => {
                      const next = !prev;
                      if (next) {
                        updateWorkflowPickerPosition();
                      } else {
                        setWorkflowPickerPosition(null);
                      }
                      return next;
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setShowWorkflowPicker(false);
                      setWorkflowPickerPosition(null);
                    }
                  }}
                  title={t("tasks.quickEntryWorkflowTitle", "Workflow for the next task")}
                >
                  <WorkflowIcon
                    workflowId={selectedQuickEntryWorkflow?.id ?? quickEntryWorkflowId ?? ""}
                    icon={selectedQuickEntryWorkflowIcon}
                    className="quick-entry-workflow-icon"
                    decorative
                  />
                  <span className="quick-entry-workflow-label">{quickEntryWorkflowLabel}</span>
                  <ChevronDown size={12} aria-hidden="true" />
                </button>
                {showWorkflowPicker && portalRoot && workflowPickerPosition && createPortal(
                  <div
                    ref={workflowPickerPortalRef}
                    className="dep-dropdown quick-entry-workflow-menu"
                    role="listbox"
                    data-testid="quick-entry-workflow-menu"
                    style={{
                      position: "fixed",
                      top: `${workflowPickerPosition.top}px`,
                      left: `${workflowPickerPosition.left}px`,
                      width: `${workflowPickerPosition.width}px`,
                      maxHeight: workflowPickerPosition.maxHeight ? `${workflowPickerPosition.maxHeight}px` : undefined,
                      overflowY: workflowPickerPosition.maxHeight ? "auto" : undefined,
                    }}
                  >
                    <div className="dep-dropdown-search-header">{t("tasks.quickEntryWorkflowHeader", "Create in workflow")}</div>
                    {realWorkflowOptions.map((option) => {
                      const duplicateName = (quickEntryWorkflowNameCounts.get(option.name) ?? 0) > 1;
                      const optionLabel = duplicateName
                        ? t("tasks.quickEntryWorkflowDuplicateLabel", "{{name}} ({{id}})", { name: option.name, id: option.id })
                        : option.name;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="option"
                          aria-selected={quickEntryWorkflowId === option.id}
                          aria-label={optionLabel}
                          className={`dep-dropdown-item quick-entry-workflow-option${quickEntryWorkflowId === option.id ? " selected" : ""}`}
                          data-testid={`quick-entry-workflow-option-${option.id}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setQuickEntryWorkflowId(option.id);
                            setShowWorkflowPicker(false);
                            setWorkflowPickerPosition(null);
                          }}
                        >
                          <WorkflowIcon workflowId={option.id} icon={option.icon} className="quick-entry-workflow-icon" decorative />
                          <span className="quick-entry-workflow-option-copy">
                            <span className="dep-dropdown-title quick-entry-workflow-option-name">{option.name}</span>
                            {duplicateName ? <span className="dep-dropdown-subtitle quick-entry-workflow-option-id">{option.id}</span> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>,
                  portalRoot,
                )}
              </div>
            )}

            <button
              type="button"
              className="btn btn-task-create btn-sm"
              onClick={handleSaveClick}
              onMouseDown={(e) => e.preventDefault()}
              disabled={!description.trim() || isSubmitting}
              data-testid="quick-entry-save"
              title={t("tasks.createTaskTitle", "Create task")}
            >
              <Save size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
              {t("tasks.save", "Save")}
            </button>

            {/* FNXC:QuickAddAttachments 2026-06-30-00:00: Keep the Quick Add attachment affordance immediately to the right of Save while preserving the icon-only label, hidden file input trigger, and pending-count badge. */}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              className="btn btn-icon btn-sm quick-entry-attach-button"
              data-testid="quick-entry-attach"
              onClick={() => fileInputRef.current?.click()}
              aria-label={attachLabel}
              title={attachLabel}
            >
              <Paperclip size={12} aria-hidden="true" />
              {pendingImages.length > 0 && (
                <span className="quick-entry-attach-count" aria-hidden="true">{pendingImages.length}</span>
              )}
            </button>

            <button
              type="button"
              className={`btn btn-sm ${isFastMode ? "btn-primary" : ""}`}
              onClick={toggleFastMode}
              onMouseDown={(e) => e.preventDefault()}
              aria-pressed={isFastMode}
              data-testid="quick-entry-fast-toggle"
              title={t("tasks.toggleFastMode", "Toggle fast execution mode")}
            >
              {t("tasks.fast", "Fast")}
            </button>

            <button
              type="button"
              className={`btn btn-sm ${effectiveGithubTracking ? "btn-primary" : ""}`}
              onClick={() => {
                setGithubTrackingOverride((prev) => !(prev ?? projectGithubTrackingDefault));
              }}
              onMouseDown={(e) => e.preventDefault()}
              aria-pressed={effectiveGithubTracking}
              data-testid="quick-entry-github-toggle"
              title={githubToggleLabel}
              aria-label={githubToggleLabel}
            >
              <ProviderIcon provider="github" size="sm" />
            </button>

            <div className="priority-trigger-wrap" ref={priorityPickerRef}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                className="btn btn-sm dep-trigger"
                data-testid="quick-entry-priority-button"
                onClick={() => {
                  setShowDeps(false);
                  setShowAgentPicker(false);
                  setAgentPickerPosition(null);
                  setShowNodePicker(false);
                  setNodePickerPosition(null);
                  setIsModelMenuOpen(false);
                  setModelMenuPosition(null);
                  setActiveModelSubmenu(null);
                  setShowPriorityPicker((prev) => {
                    const next = !prev;
                    if (next) {
                      updatePriorityPickerPosition();
                    } else {
                      setPriorityPickerPosition(null);
                    }
                    return next;
                  });
                }}
              >
                <Flag size={12} style={{ verticalAlign: "middle" }} />
                {` ${priority[0].toUpperCase()}${priority.slice(1)}`}
              </button>
            </div>

            {showPriorityPicker && portalRoot && priorityPickerPosition && createPortal(
              <div
                ref={priorityPickerPortalRef}
                className="dep-dropdown priority-picker-dropdown priority-picker-dropdown--portal"
                onMouseDown={(e) => e.preventDefault()}
                style={{
                  position: "fixed",
                  top: `${priorityPickerPosition.top}px`,
                  left: `${priorityPickerPosition.left}px`,
                  width: `${priorityPickerPosition.width}px`,
                  maxHeight: priorityPickerPosition.maxHeight ? `${priorityPickerPosition.maxHeight}px` : undefined,
                  overflowY: priorityPickerPosition.maxHeight ? "auto" : undefined,
                }}
              >
                <div className="dep-dropdown-search-header">{t("tasks.selectPriority", "Select priority")}</div>
                {TASK_PRIORITIES.map((taskPriority) => {
                  const label = `${taskPriority[0].toUpperCase()}${taskPriority.slice(1)}`;
                  return (
                    <div
                      key={taskPriority}
                      className={`dep-dropdown-item${priority === taskPriority ? " selected" : ""}`}
                      data-testid={`quick-entry-priority-option-${taskPriority}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setPriority(taskPriority);
                        setShowPriorityPicker(false);
                        setPriorityPickerPosition(null);
                      }}
                    >
                      <span className="dep-dropdown-title">{label}</span>
                    </div>
                  );
                })}
              </div>,
              portalRoot,
            )}

            <WorkflowOptionalStepsDropdown
              steps={optionalSteps}
              enabledIds={enabledOptionalStepIds}
              onToggle={toggleOptionalStep}
              disabled={isSubmitting || isDisabled}
              triggerTestId="quick-entry-optional-steps-trigger"
            />

            {/* FNXC:QuickAddSubtaskFlag 2026-06-21-00:00: Render no Subtask button or click target unless App wires the default-off `subtaskBreakdown` experiment callback. */}
            {onSubtaskBreakdown && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleSubtaskClick}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!description.trim()}
                data-testid="subtask-button"
                title={t("tasks.subtaskButtonTitle", "Break down into AI-generated subtasks")}
              >
                <ListTree size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                {t("tasks.subtask", "Subtask")}
              </button>
            )}
            {/*
              FNXC:QuickAddRefine 2026-06-30-00:00:
              Quick Add intentionally omits AI Refine so the compact create row has no refine button, menu, loading state, or /ai/refine-text path. New Task and TaskForm keep their dedicated refine affordance for richer task drafting.
            */}
            <div className="dep-trigger-wrap">
              <button
                ref={depTriggerRef}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                className="btn btn-sm dep-trigger"
                data-testid="quick-entry-deps"
                onClick={() => {
                  setShowDeps((prev) => {
                    const next = !prev;
                    if (next) {
                      setIsModelMenuOpen(false);
                      setModelMenuPosition(null);
                      setActiveModelSubmenu(null);
                      setShowAgentPicker(false);
                      setAgentPickerPosition(null);
                      setShowNodePicker(false);
                      setNodePickerPosition(null);
                      setShowPriorityPicker(false);
                      setPriorityPickerPosition(null);
                      // Position the dropdown before rendering
                      updateDepDropdownPosition();
                    } else {
                      setDepDropdownPosition(null);
                    }
                    return next;
                  });
                }}
              >
                <Link size={12} style={{ verticalAlign: "middle" }} />
                {dependencies.length > 0 ? t("tasks.depsCount", "{{count}} deps", { count: dependencies.length }) : t("tasks.deps", "Deps")}
              </button>
            </div>
            {/* Dependency dropdown rendered via portal for proper viewport positioning */}
            {showDeps && portalRoot && depDropdownPosition && (() => {
              const term = depSearch.toLowerCase();
              const filtered = (term
                ? tasks.filter((t) =>
                    t.id.toLowerCase().includes(term) ||
                    (t.title && t.title.toLowerCase().includes(term)) ||
                    (t.description && t.description.toLowerCase().includes(term))
                  )
                : [...tasks]
              ).sort((a, b) => {
                const cmp = b.createdAt.localeCompare(a.createdAt);
                if (cmp !== 0) return cmp;
                const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
                const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
                return bNum - aNum;
              });
              return createPortal(
                <div
                  ref={depDropdownPortalRef}
                  className="dep-dropdown dep-dropdown--portal"
                  onMouseDown={(e) => e.preventDefault()}
                  style={{
                    position: "fixed",
                    top: `${depDropdownPosition.top}px`,
                    left: `${depDropdownPosition.left}px`,
                    width: `${depDropdownPosition.width}px`,
                    maxHeight: depDropdownPosition.maxHeight ? `${depDropdownPosition.maxHeight}px` : undefined,
                    overflowY: depDropdownPosition.maxHeight ? "auto" : undefined,
                  }}
                >
                  <input
                    className="dep-dropdown-search"
                    placeholder={t("tasks.searchTasksPlaceholder", "Search tasks…")}
                    autoFocus={typeof document === "undefined" || document.activeElement !== textareaRef.current}
                    value={depSearch}
                    onChange={(e) => setDepSearch(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {filtered.length === 0 ? (
                    <div className="dep-dropdown-empty">{t("tasks.noExistingTasks", "No existing tasks")}</div>
                  ) : (
                    filtered.map((t) => (
                      <div
                        key={t.id}
                        className={`dep-dropdown-item${dependencies.includes(t.id) ? " selected" : ""}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleDep(t.id)}
                      >
                        <span className="dep-dropdown-id">{t.id}</span>
                        <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 60)}</span>
                      </div>
                    ))
                  )}
                </div>,
                portalRoot,
              );
            })()}

            <button
              ref={modelTriggerRef}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              className="btn btn-sm"
              data-testid="quick-entry-models"
              onClick={() => {
                setShowDeps(false);
                setShowAgentPicker(false);
                setAgentPickerPosition(null);
                setShowNodePicker(false);
                setNodePickerPosition(null);
                setShowPriorityPicker(false);
                setPriorityPickerPosition(null);
                setActiveModelSubmenu(null);
                setIsModelMenuOpen(true);
                updateModelMenuPosition();
              }}
            >
              <Brain size={12} style={{ verticalAlign: "middle" }} />
              {modelMenuLabel}
            </button>

            {shouldShowNodePicker && (
              <div className="node-trigger-wrap" ref={nodePickerRef}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  className="btn btn-sm dep-trigger"
                  data-testid="quick-entry-node-button"
                  onClick={() => {
                    setShowDeps(false);
                    setShowAgentPicker(false);
                    setAgentPickerPosition(null);
                    setIsModelMenuOpen(false);
                    setModelMenuPosition(null);
                    setActiveModelSubmenu(null);
                    setShowPriorityPicker(false);
                    setPriorityPickerPosition(null);
                    setShowNodePicker((prev) => {
                      const next = !prev;
                      if (next) {
                        updateNodePickerPosition();
                      } else {
                        setNodePickerPosition(null);
                      }
                      return next;
                    });
                  }}
                >
                  <Server size={12} style={{ verticalAlign: "middle" }} />
                  {` ${selectedNode?.name ?? t("tasks.node", "Node")}`}
                  {selectedNode && (
                    <span className="quick-entry-node-status">
                      <NodeHealthDot status={selectedNode.status} showLabel />
                    </span>
                  )}
                </button>
              </div>
            )}

            {shouldShowNodePicker && showNodePicker && portalRoot && nodePickerPosition && createPortal(
              <div
                ref={nodePickerPortalRef}
                className="dep-dropdown node-picker-dropdown node-picker-dropdown--portal"
                onMouseDown={(e) => e.preventDefault()}
                style={{
                  position: "fixed",
                  top: `${nodePickerPosition.top}px`,
                  left: `${nodePickerPosition.left}px`,
                  width: `${nodePickerPosition.width}px`,
                  maxHeight: nodePickerPosition.maxHeight ? `${nodePickerPosition.maxHeight}px` : undefined,
                  overflowY: nodePickerPosition.maxHeight ? "auto" : undefined,
                }}
              >
                <div className="dep-dropdown-search-header">{t("tasks.selectExecutionNode", "Select execution node")}</div>
                <div
                  className={`dep-dropdown-item node-picker-item${nodeId == null ? " selected" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setNodeId(undefined);
                    setShowNodePicker(false);
                    setNodePickerPosition(null);
                  }}
                >
                  <span className="node-picker-item-name">{t("tasks.projectDefaultLocal", "Project default / local")}</span>
                </div>
                {nodes.map((node) => (
                  <div
                    key={node.id}
                    className={`dep-dropdown-item node-picker-item${nodeId === node.id ? " selected" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setNodeId(node.id);
                      setShowNodePicker(false);
                      setNodePickerPosition(null);
                    }}
                  >
                    <span className="quick-entry-node-status">
                      <NodeHealthDot status={node.status} />
                    </span>
                    <span className="node-picker-item-name">{node.name}</span>
                    <span className="node-picker-item-status">{
                      node.status === "online" ? t("nodes.statusOnline", "Online") :
                      node.status === "connecting" ? t("nodes.statusConnecting", "Connecting") :
                      node.status === "error" ? t("nodes.statusError", "Error") :
                      t("nodes.statusOffline", "Offline")
                    }</span>
                  </div>
                ))}
              </div>,
              portalRoot,
            )}

            <div className="agent-trigger-wrap" ref={agentPickerRef}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                className="btn btn-sm dep-trigger"
                onClick={() => {
                  if (showAgentPicker) {
                    setShowAgentPicker(false);
                    setAgentPickerPosition(null);
                  } else {
                    setShowNodePicker(false);
                    setNodePickerPosition(null);
                    setShowPriorityPicker(false);
                    setPriorityPickerPosition(null);
                    void loadAgents();
                  }
                }}
                data-testid="quick-entry-agent-button"
              >
                <Bot size={12} style={{ verticalAlign: "middle" }} />
                {selectedAgentLabel ? ` ${selectedAgentLabel}` : ` ${t("tasks.agent", "Agent")}`}
              </button>
            </div>
            {showAgentPicker && portalRoot && agentPickerPosition && createPortal(
              <div
                ref={agentPickerPortalRef}
                className="dep-dropdown agent-picker-dropdown agent-picker-dropdown--portal"
                onMouseDown={(e) => e.preventDefault()}
                style={{
                  position: "fixed",
                  top: `${agentPickerPosition.top}px`,
                  left: `${agentPickerPosition.left}px`,
                  width: `${agentPickerPosition.width}px`,
                  maxHeight: agentPickerPosition.maxHeight ? `${agentPickerPosition.maxHeight}px` : undefined,
                  overflowY: agentPickerPosition.maxHeight ? "auto" : undefined,
                }}
              >
                <div className="dep-dropdown-search-header">{t("tasks.selectAgent", "Select agent")}</div>
                {agentsLoading && <div className="dep-dropdown-empty"><LoadingSpinner label={t("tasks.loadingAgents", "Loading agents...")} /></div>}
                {!agentsLoading && agents.map((a) => (
                  <div
                    key={a.id}
                    className={`dep-dropdown-item${selectedAgentId === a.id ? " selected" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSelectedAgentId(a.id === selectedAgentId ? null : a.id);
                      setShowAgentPicker(false);
                      setAgentPickerPosition(null);
                    }}
                  >
                    <Bot size={12} style={{ marginRight: 6 }} />
                    <span className="dep-dropdown-id">{a.role}</span>
                    <span className="dep-dropdown-title">{a.name}</span>
                  </div>
                ))}
                {!agentsLoading && agents.length === 0 && (
                  <div className="dep-dropdown-empty">{t("tasks.noAgentsAvailable", "No agents available")}</div>
                )}
                {selectedAgentId && (
                  <div
                    className="dep-dropdown-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSelectedAgentId(null);
                      setShowAgentPicker(false);
                      setAgentPickerPosition(null);
                    }}
                  >
                    <span className="dep-dropdown-title">{t("tasks.clearSelection", "Clear selection")}</span>
                  </div>
                )}
              </div>,
              portalRoot,
            )}

          </div>
        )}

        {pendingImages.length > 0 && (
          <div className="inline-create-previews">
            {pendingImages.map((img, index) => (
              <div key={img.previewUrl} className="inline-create-preview">
                <img src={img.previewUrl} alt={img.file.name} />
                <button
                  type="button"
                  className="inline-create-preview-remove"
                  onClick={() => removeImage(index)}
                  disabled={isSubmitting}
                  title={t("tasks.removeImage", "Remove image")}
                  data-testid={`quick-entry-preview-remove-${index}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {isModelMenuOpen && portalRoot && modelMenuPosition && createPortal(
            <div
              ref={modelMenuPortalRef}
              className="model-nested-menu model-nested-menu--portal"
              onMouseDown={(e) => e.preventDefault()}
              data-testid="model-nested-menu"
              style={{
                position: "fixed",
                top: `${modelMenuPosition.top}px`,
                left: `${modelMenuPosition.left}px`,
                width: `${modelMenuPosition.width}px`,
                maxHeight: modelMenuPosition.maxHeight ? `${modelMenuPosition.maxHeight}px` : undefined,
                overflowY: modelMenuPosition.maxHeight ? "auto" : undefined,
              }}
            >
              {activeModelSubmenu === null ? (
                // Top-level menu with Plan/Executor/Reviewer choices
                <div className="model-menu-items">
                  <button
                    type="button"
                    className={`model-menu-item ${hasPlanningOverride ? "model-menu-item--active" : ""}`}
                    onClick={() => setActiveModelSubmenu("plan")}
                    data-testid="model-menu-plan"
                  >
                    <span className="model-menu-item-label">
                      <Lightbulb size={12} style={{ verticalAlign: "middle", marginRight: 6 }} />
                      {t("tasks.modelPlan", "Plan")}
                    </span>
                    <span className="model-menu-item-value">
                      {hasPlanningOverride
                        ? getModelBadgeLabel(planningProvider, planningModelId)
                        : t("tasks.usingDefault", "Using default")}
                    </span>
                    <ChevronRight size={12} style={{ marginLeft: "auto", color: "var(--text-dim)" }} />
                  </button>
                  <button
                    type="button"
                    className={`model-menu-item ${hasExecutorOverride ? "model-menu-item--active" : ""}`}
                    onClick={() => setActiveModelSubmenu("executor")}
                    data-testid="model-menu-executor"
                  >
                    <span className="model-menu-item-label">
                      <Sparkles size={12} style={{ verticalAlign: "middle", marginRight: 6 }} />
                      {t("tasks.modelExecutor", "Executor")}
                    </span>
                    <span className="model-menu-item-value">
                      {hasExecutorOverride
                        ? getModelBadgeLabel(executorProvider, executorModelId)
                        : t("tasks.usingDefault", "Using default")}
                    </span>
                    <ChevronRight size={12} style={{ marginLeft: "auto", color: "var(--text-dim)" }} />
                  </button>
                  <button
                    type="button"
                    className={`model-menu-item ${hasValidatorOverride ? "model-menu-item--active" : ""}`}
                    onClick={() => setActiveModelSubmenu("validator")}
                    data-testid="model-menu-validator"
                  >
                    <span className="model-menu-item-label">
                      <Brain size={12} style={{ verticalAlign: "middle", marginRight: 6 }} />
                      {t("tasks.modelReviewer", "Reviewer")}
                    </span>
                    <span className="model-menu-item-value">
                      {hasValidatorOverride
                        ? getModelBadgeLabel(validatorProvider, validatorModelId)
                        : t("tasks.usingDefault", "Using default")}
                    </span>
                    <ChevronRight size={12} style={{ marginLeft: "auto", color: "var(--text-dim)" }} />
                  </button>
                </div>
              ) : (
                // Submenu with CustomModelDropdown for the selected target
                <div className="model-submenu">
                  <button
                    type="button"
                    className="model-submenu-back"
                    onClick={() => setActiveModelSubmenu(null)}
                    data-testid="model-submenu-back"
                  >
                    <ChevronDown size={12} style={{ transform: "rotate(90deg)", marginRight: 4 }} />
                    {t("common.back", "Back")}
                  </button>
                  <div className="model-submenu-header">
                    {activeModelSubmenu === "plan" && t("tasks.planModel", "Plan Model")}
                    {activeModelSubmenu === "executor" && t("tasks.executorModel", "Executor Model")}
                    {activeModelSubmenu === "validator" && t("tasks.reviewerModel", "Reviewer Model")}
                  </div>
                  <CustomModelDropdown
                    models={loadedModels}
                    value={
                      activeModelSubmenu === "plan"
                        ? planningSelectionValue
                        : activeModelSubmenu === "executor"
                          ? executorSelectionValue
                          : validatorSelectionValue
                    }
                    onChange={
                      activeModelSubmenu === "plan"
                        ? handlePlanningModelChange
                        : activeModelSubmenu === "executor"
                          ? handleExecutorChange
                          : handleValidatorChange
                    }
                    placeholder={t("tasks.usingDefault", "Using default")}
                    disabled={modelsLoading}
                    id={`model-${activeModelSubmenu}-select`}
                    label={`${activeModelSubmenu} model`}
                    favoriteProviders={effectiveFavoriteProviders}
                    onToggleFavorite={handleToggleFavorite}
                    favoriteModels={effectiveFavoriteModels}
                    onToggleModelFavorite={handleToggleModelFavorite}
                  />
                  {modelsError && (
                    <div className="model-submenu-error">
                      <span>{modelsError}</span>
                      <button type="button" className="btn btn-sm" onClick={loadModels}>
                        {t("common.retry", "Retry")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>,
            portalRoot,
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            handleImageFiles(e.target.files);
            e.currentTarget.value = "";
          }}
          data-testid="quick-entry-file-input"
        />
        {/* FNXC:QuickEntry 2026-06-25-00:00: FN-7047 removes the persistent "Enter to create · Esc to cancel" hint so quick entry has no leftover affordance shell after the help text was retired. */}
      </div>
      {duplicateMatches && (
        <DuplicateWarningModal
          matches={duplicateMatches}
          onOpen={handleDuplicateOpen}
          onProceed={handleDuplicateProceed}
          onCancel={handleDuplicateCancel}
        />
      )}
    </>
  );
}
