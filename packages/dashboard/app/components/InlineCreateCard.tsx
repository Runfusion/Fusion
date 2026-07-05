import "./InlineCreateCard.css";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Brain, Link, ListTree, Zap, ChevronDown, ChevronUp, Bot, Maximize2, Minimize2, Server } from "lucide-react";
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, type Task, type TaskPriority, type Settings, type ResolvedWorkflowOptionalStep } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { checkDuplicateTasks, fetchModels, uploadAttachment, fetchSettings, updateGlobalSettings, fetchAgents, fetchWorkflowOptionalSteps, DuplicateCandidatesError } from "../api";
import type { CreateTaskInput, ModelInfo, Agent, NodeInfo, DuplicateMatch } from "../api";
import { useNodes } from "../hooks/useNodes";
import { ModelSelectionModal } from "./ModelSelectionModal";
import { NodeHealthDot } from "./NodeHealthDot";
import { DuplicateWarningModal } from "./DuplicateWarningModal";
import { LoadingSpinner } from "./LoadingSpinner";
import { applyPresetToSelection } from "../utils/modelPresets";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";
import { WorkflowSelector } from "./WorkflowSelector";
import { WorkflowOptionalStepsDropdown } from "./WorkflowOptionalStepsDropdown";

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const STORAGE_KEY = "kb-inline-create-text";

interface PendingImage {
  file: File;
  previewUrl: string;
}

interface InlineCreateCardProps {
  tasks: Task[];
  onSubmit: (input: CreateTaskInput) => Promise<Task>;
  onCancel: () => void;
  addToast: (msg: string, type?: ToastType) => void;
  projectId?: string;
  /**
   * Optional model list from a parent surface. When omitted, InlineCreateCard
   * fetches models itself so it can stay reusable in both list and board flows
   * without forcing model data to be threaded through every caller.
   */
  availableModels?: ModelInfo[];
  /**
   * Preserved for shared create-surface prop compatibility. Inline quick-create intentionally omits Plan.
   */
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  /**
   * Called when the user clicks the "Subtask" button to trigger subtask breakdown.
   */
  onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
}

function getNodeStatusLabel(status: NodeInfo["status"], t?: (key: string, defaultValue: string) => string): string {
  if (status === "online") return t ? t("inline.online", "Online") : "Online";
  if (status === "connecting") return t ? t("inline.connecting", "Connecting") : "Connecting";
  if (status === "error") return t ? t("inline.error", "Error") : "Error";
  return t ? t("inline.offline", "Offline") : "Offline";
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

function hasMeaningfulNodeChoice(nodes: NodeInfo[]): boolean {
  /*
  FNXC:QuickAddNodeRouting 2026-06-30-00:00:
  Local-only inline quick-create should not show a Node button because the project-default route already means local execution. Keep the picker only when a remote or second registered node makes routing a real choice.
  */
  return nodes.length > 1 || nodes.some((node) => node.type !== "local");
}

export function InlineCreateCard({
  tasks,
  onSubmit,
  onCancel,
  addToast,
  projectId,
  availableModels,
  onSubtaskBreakdown,
}: InlineCreateCardProps) {
  const { t } = useTranslation("app");
  const [description, setDescription] = useState(() => {
    if (typeof window !== "undefined") {
      return getScopedItem(STORAGE_KEY, projectId) || "";
    }
    return "";
  });
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [showNodePicker, setShowNodePicker] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [nodeId, setNodeId] = useState<string | undefined>(undefined);
  const { nodes } = useNodes();
  const shouldShowNodePicker = useMemo(() => hasMeaningfulNodeChoice(nodes), [nodes]);
  const selectedNode = shouldShowNodePicker && nodeId ? nodes.find((node) => node.id === nodeId) : undefined;
  const effectiveNodeId = shouldShowNodePicker && selectedNode ? selectedNode.id : undefined;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | undefined>(undefined);
  const [executorProvider, setExecutorProvider] = useState<string | undefined>(undefined);
  const [executorModelId, setExecutorModelId] = useState<string | undefined>(undefined);
  const [validatorProvider, setValidatorProvider] = useState<string | undefined>(undefined);
  const [validatorModelId, setValidatorModelId] = useState<string | undefined>(undefined);
  const [planningProvider, setPlanningProvider] = useState<string | undefined>(undefined);
  const [planningModelId, setPlanningModelId] = useState<string | undefined>(undefined);
  const [optionalSteps, setOptionalSteps] = useState<ResolvedWorkflowOptionalStep[]>([]);
  const [enabledOptionalStepIds, setEnabledOptionalStepIds] = useState<string[]>([]);
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>(availableModels ?? []);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  // isDescriptionExpanded controls fullscreen description editing mode
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  // Track textarea focus for expand button visibility
  const [isDescriptionFocused, setIsDescriptionFocused] = useState(false);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[] | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<CreateTaskInput | null>(null);
  const justResetRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const nodePickerRef = useRef<HTMLDivElement>(null);

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
    setAgents([]);
    setSelectedAgentId(null);
  }, [projectId]);

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
      setFavoriteProviders(response.favoriteProviders);
      setFavoriteModels(response.favoriteModels);
    } catch (err) {
      setModelsError(getErrorMessage(err) || "Failed to load models");
    } finally {
      setModelsLoading(false);
    }
  }, [availableModels]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!showDeps) setDepSearch("");
  }, [showDeps]);

  useEffect(() => {
    if (shouldShowNodePicker && (!nodeId || selectedNode)) {
      return;
    }

    setNodeId(undefined);
    setShowNodePicker(false);
  }, [nodeId, selectedNode, shouldShowNodePicker]);

  useEffect(() => {
    if (!showAgentPicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (agentPickerRef.current?.contains(target)) return;
      setShowAgentPicker(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showAgentPicker]);

  useEffect(() => {
    if (!showNodePicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (nodePickerRef.current?.contains(target)) return;
      setShowNodePicker(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showNodePicker]);

  useEffect(() => {
    let cancelled = false;

    if (availableModels) {
      setLoadedModels(availableModels);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }

    setModelsLoading(true);
    setModelsError(null);
    fetchModels()
      .then((response) => {
        if (!cancelled) {
          setLoadedModels(response.models);
          setFavoriteProviders(response.favoriteProviders);
          setFavoriteModels(response.favoriteModels);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setModelsError(getErrorMessage(err) || "Failed to load models");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setModelsLoading(false);
        }
      });

    fetchSettings(projectId)
      .then((nextSettings) => {
        if (!cancelled) {
          setSettings(nextSettings);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettings(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [availableModels, projectId]);

  const executorSelectionValue = getModelSelectionValue(executorProvider, executorModelId);
  const validatorSelectionValue = getModelSelectionValue(validatorProvider, validatorModelId);
  const planningSelectionValue = getModelSelectionValue(planningProvider, planningModelId);
  const availablePresets = settings?.modelPresets || [];
  const selectedPreset = availablePresets.find((preset) => preset.id === selectedPresetId);

  const hasExecutorOverride = Boolean(executorProvider && executorModelId);
  const hasValidatorOverride = Boolean(validatorProvider && validatorModelId);
  const hasPlanningOverride = Boolean(planningProvider && planningModelId);
  const selectedModelCount = Number(hasExecutorOverride) + Number(hasValidatorOverride) + Number(hasPlanningOverride);
  const effectiveWorkflowId = selectedWorkflowId || settings?.defaultWorkflowId || "builtin:coding";

  useEffect(() => {
    let cancelled = false;
    setOptionalSteps([]);
    setEnabledOptionalStepIds([]);

    fetchWorkflowOptionalSteps(effectiveWorkflowId, projectId)
      .then((steps) => {
        if (cancelled) return;
        setOptionalSteps(steps);
        setEnabledOptionalStepIds(steps.filter((step) => step.defaultOn).map((step) => step.templateId));
      })
      .catch(() => {
        if (cancelled) return;
        setOptionalSteps([]);
        setEnabledOptionalStepIds([]);
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveWorkflowId, projectId]);

  const toggleOptionalStep = useCallback((templateId: string) => {
    setEnabledOptionalStepIds((prev) => (
      prev.includes(templateId)
        ? prev.filter((id) => id !== templateId)
        : [...prev, templateId]
    ));
  }, []);

  // Track focus-out for conditional cancel behavior and justResetRef cleanup.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const handleFocusOut = (e: FocusEvent) => {
      // relatedTarget is the element receiving focus — if it's inside the card, ignore
      if (e.relatedTarget instanceof Node && card.contains(e.relatedTarget)) return;

      if (justResetRef.current) {
        justResetRef.current = false;
        return;
      }

      const hasOpenOverlay = showDeps || showAgentPicker || isModelModalOpen || showPresets;
      const hasDescription = description.trim().length > 0;
      const shouldCancelWhenCollapsed = !isExpanded && !hasDescription && !hasOpenOverlay;
      const shouldCancelWhenExpanded = isExpanded && !hasDescription && !hasOpenOverlay;

      if (shouldCancelWhenCollapsed || shouldCancelWhenExpanded) {
        onCancel();
      }
    };

    card.addEventListener("focusout", handleFocusOut);
    return () => card.removeEventListener("focusout", handleFocusOut);
  }, [description, isExpanded, onCancel, showDeps, showAgentPicker, isModelModalOpen, showPresets]);

  // Clean up object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));

      // Clear localStorage on unmount if there's no description (user abandoned)
      if (typeof window !== "undefined") {
        const current = getScopedItem(STORAGE_KEY, projectId);
        if (current && current.trim() === "") {
          removeScopedItem(STORAGE_KEY, projectId);
        }
      }
    };
  }, [projectId]);

  /**
   * Handles paste events on the textarea. Extracts image files from the
   * clipboard data, creates object URL previews, and appends them to
   * the pendingImages state. Non-image files are silently ignored.
   */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (submitting) return;
      const files = e.clipboardData?.files;
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
    },
    [submitting],
  );

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  /*
  FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
  submitTask no longer applies the selected workflow post-create via selectTaskWorkflow — handleSubmit now forwards workflowId inside the CreateTaskInput so the store materializes the workflow and resolves the intake column (e.g. Coding (Ideas) → "ideas") atomically at create time. A post-create selectTaskWorkflow call would race the store's intake-column resolution and re-introduce the auto-triage bug this task fixes.
  */
  const submitTask = useCallback(async (input: CreateTaskInput) => {
    setSubmitting(true);
    try {
      const task = await onSubmit(input);

      // Upload pending images as attachments
      if (pendingImages.length > 0) {
        const failures: string[] = [];
        for (const img of pendingImages) {
          try {
            await uploadAttachment(task.id, img.file, projectId);
          } catch {
            failures.push(img.file.name);
          }
        }
        if (failures.length > 0) {
          addToast(`Failed to upload: ${failures.join(", ")}`, "error");
        }
      }

      // Clean up preview URLs
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setPendingImages([]);

      setDescription("");
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
      setSelectedPresetId(undefined);
      setExecutorProvider(undefined);
      setExecutorModelId(undefined);
      setValidatorProvider(undefined);
      setValidatorModelId(undefined);
      setPlanningProvider(undefined);
      setPlanningModelId(undefined);
      setEnabledOptionalStepIds([]);
      setPriority(DEFAULT_TASK_PRIORITY);
      setDependencies([]);
      setSelectedAgentId(null);
      setNodeId(undefined);
      setShowDeps(false);
      setShowNodePicker(false);
      setShowAgentPicker(false);
      setIsModelModalOpen(false);
      setShowPresets(false);
      setSelectedWorkflowId(null);
      setEnabledOptionalStepIds([]);
      addToast(`Created ${task.id}`, "success");

      // Collapse and clear localStorage after successful task creation
      setIsExpanded(false);
      setIsDescriptionExpanded(false); // Exit fullscreen mode on submit
      justResetRef.current = true;
      if (typeof window !== "undefined") {
        removeScopedItem(STORAGE_KEY, projectId);
      }
    } catch (err) {
      if (err instanceof DuplicateCandidatesError && err.matches.length > 0) {
        setDuplicateMatches(err.matches);
        addToast(`Linked existing ${err.matches[0]?.id ?? "task"}`, "success");
      } else {
        addToast(getErrorMessage(err), "error");
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    pendingImages,
    onSubmit,
    addToast,
    projectId,
  ]);

  const handleSubmit = useCallback(async () => {
    if (!description.trim() || submitting) return;

    /*
    FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
    Do not hard-code `column: "triage"` here — the store resolves the landing column from the forwarded (or project-default) workflow's intake column, e.g. Coding (Ideas) → "ideas". Forwarding `workflowId` at create time (instead of applying it post-create via selectTaskWorkflow) lets the store materialize the workflow and land the card in its resolved intake column atomically, so a manual-intake workflow parks the card for the operator instead of being auto-triaged.
    */
    const input: CreateTaskInput = {
      description: description.trim(),
      ...(selectedWorkflowId ? { workflowId: selectedWorkflowId } : {}),
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
      FNXC:InlineCreateWorkflowSteps 2026-06-29-02:45:
      Inline create optional-step toggles are explicit task intent. When a workflow exposes optional steps and the operator unchecks all of them, submit `[]` so default-on Plan Review / Code Review stay disabled on the created task instead of reappearing from workflow defaults.
      */
      enabledWorkflowSteps: optionalSteps.length > 0 ? enabledOptionalStepIds : undefined,
      priority,
      nodeId: effectiveNodeId,
    };

    try {
      const matches = await checkDuplicateTasks({ description: description.trim() }, projectId);
      if (matches.length > 0) {
        setDuplicateMatches(matches);
        setPendingSubmit(input);
        return;
      }
    } catch {
      addToast("Duplicate check failed; creating task anyway.", "error");
    }

    await submitTask(input);
  }, [description, submitting, selectedWorkflowId, dependencies, selectedAgentId, selectedPresetId, hasExecutorOverride, executorProvider, executorModelId, hasValidatorOverride, validatorProvider, validatorModelId, hasPlanningOverride, planningProvider, planningModelId, optionalSteps.length, enabledOptionalStepIds, priority, effectiveNodeId, projectId, addToast, submitTask]);

  const handleDuplicateProceed = useCallback(async () => {
    const matches = duplicateMatches;
    const input = pendingSubmit;
    setDuplicateMatches(null);
    setPendingSubmit(null);
    if (!matches || !input || matches.length === 0) return;
    await submitTask({
      ...input,
      acknowledgedDuplicates: matches.map((match) => match.id),
    });
  }, [duplicateMatches, pendingSubmit, submitTask]);

  const handleDuplicateCancel = useCallback(() => {
    setDuplicateMatches(null);
    setPendingSubmit(null);
  }, []);

  const handleDuplicateOpen = useCallback((taskId: string) => {
    if (typeof window !== "undefined") {
      window.location.hash = `#/tasks/${taskId}`;
    }
    setDuplicateMatches(null);
    setPendingSubmit(null);
  }, []);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Exit fullscreen mode first - highest priority
        if (isDescriptionExpanded) {
          setIsDescriptionExpanded(false);
          return;
        }
        // Close dropdowns first if open
        if (showDeps || showNodePicker || showAgentPicker || isModelModalOpen || showPresets) {
          setShowDeps(false);
          setShowNodePicker(false);
          setShowAgentPicker(false);
          setIsModelModalOpen(false);
          setShowPresets(false);
          return;
        }
        // Clear non-empty input on Escape and clear localStorage
        if (description.trim()) {
          setDescription("");
          // Reset height
          if (inputRef.current) {
            inputRef.current.style.height = "auto";
          }
          // Clear localStorage when user explicitly clears input
          if (typeof window !== "undefined") {
            removeScopedItem(STORAGE_KEY, projectId);
          }
        }
        // Collapse and cancel on escape
        setIsExpanded(false);
        onCancel();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [
      handleSubmit,
      onCancel,
      description,
      isDescriptionExpanded,
      showDeps,
      showNodePicker,
      showAgentPicker,
      isModelModalOpen,
      showPresets,
      projectId,
    ],
  );

  const toggleDep = useCallback((id: string) => {
    setDependencies((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  }, []);

  const toggleDepsDropdown = useCallback(() => {
    setShowDeps((prev) => {
      const next = !prev;
      if (next) {
        setIsModelModalOpen(false);
        setShowNodePicker(false);
        setShowAgentPicker(false);
      }
      return next;
    });
  }, []);

  const toggleModelsDropdown = useCallback(() => {
    setIsModelModalOpen(true);
    setShowDeps(false);
    setShowNodePicker(false);
    setShowAgentPicker(false);
  }, []);

  const loadAgents = useCallback(async () => {
    if (agents.length > 0) {
      setShowNodePicker(false);
      setShowAgentPicker(true);
      return;
    }

    setAgentsLoading(true);
    try {
      const result = await fetchAgents(undefined, projectId);
      setAgents(result);
      setShowNodePicker(false);
      setShowAgentPicker(true);
    } catch (err) {
      const msg = getErrorMessage(err);
      addToast(msg ? `Failed to load agents: ${msg}` : "Failed to load agents", "error");
      setShowAgentPicker(false);
    } finally {
      setAgentsLoading(false);
    }
  }, [agents.length, projectId, addToast]);

  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) : undefined;
  const selectedAgentLabel = selectedAgent?.name ?? selectedAgentId;

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

  const handlePlanningModelChange = useCallback((value: string) => {
    const next = parseModelSelection(value);
    setPlanningProvider(next.provider);
    setPlanningModelId(next.modelId);
  }, []);

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
      // Revert on error
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
      // Revert on error
      setFavoriteModels(currentFavorites);
    }
  }, [favoriteModels, favoriteProviders]);

  const handleModelDropdownMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      (target.closest("button") || target.closest("input"))
    ) {
      return;
    }
    e.preventDefault();
  }, []);

  /*
  FNXC:InlineCreate 2026-06-30-00:00:
  Inline quick-create intentionally omits the Plan button, icon, disabled state, tooltip, and click target while preserving Subtask and task creation controls.
  */
  const handleSubtaskClick = useCallback(() => {
    const trimmed = description.trim();
    if (!trimmed) {
      addToast(t("inline.enterDescriptionFirst", "Enter a description first"), "error");
      return;
    }
    if (selectedWorkflowId !== null) {
      onSubtaskBreakdown?.(trimmed, selectedWorkflowId);
    } else {
      onSubtaskBreakdown?.(trimmed);
    }
    // Clear the input after triggering subtask breakdown
    setDescription("");
    setSelectedWorkflowId(null);
    setDependencies([]);
    setExecutorProvider(undefined);
    setExecutorModelId(undefined);
    setValidatorProvider(undefined);
    setValidatorModelId(undefined);
    setPlanningProvider(undefined);
    setPlanningModelId(undefined);
    setEnabledOptionalStepIds([]);
    setSelectedPresetId(undefined);
    setSelectedAgentId(null);
    setNodeId(undefined);
    setShowDeps(false);
    setShowAgentPicker(false);
    setIsModelModalOpen(false);
    setShowPresets(false);
    setIsExpanded(false);
  }, [description, onSubtaskBreakdown, selectedWorkflowId, addToast]);

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleToggleDescriptionExpand = useCallback(() => {
    setIsDescriptionExpanded((prev) => {
      const next = !prev;
      // Focus the fullscreen textarea after it renders
      if (next && inputRef.current) {
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      return next;
    });
  }, []);

  const handleDescriptionFullscreenKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isDescriptionExpanded || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    setIsDescriptionExpanded(false);
  }, [isDescriptionExpanded]);

  return (
    <div className={`inline-create-card ${isExpanded ? "inline-create-card--expanded" : "inline-create-card--collapsed"}`} ref={cardRef}>
      <div
        className={`description-with-refine${isDescriptionExpanded ? " description--fullscreen" : ""}`}
        onKeyDown={handleDescriptionFullscreenKeyDown}
      >
        {isDescriptionExpanded && (
          <div className="description-fullscreen-header">
            <span>{t("inline.editingDescription", "Editing Description")}</span>
            <button
              type="button"
              className="btn btn-sm description-expand-btn"
              onClick={handleToggleDescriptionExpand}
              aria-label={t("inline.collapseDescription", "Collapse description")}
              title={t("inline.collapseDescription", "Collapse description")}
              data-testid="inline-create-collapse"
            >
              <Minimize2 size={14} />
            </button>
          </div>
        )}
        {!isDescriptionExpanded && (
          <div className="inline-create-main-row">
            <div className="inline-create-textarea-wrap">
              <textarea
                ref={inputRef}
                rows={1}
                className="inline-create-input"
                placeholder={t("inline.whatNeedsToBeDone", "What needs to be done?")}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = el.scrollHeight + "px";
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => setIsDescriptionFocused(true)}
                onBlur={() => setIsDescriptionFocused(false)}
                disabled={submitting}
                aria-controls={isExpanded ? "inline-create-controls" : undefined}
              />
              {isDescriptionFocused && description.trim() && !submitting && (
                <button
                  type="button"
                  className="btn btn-sm inline-create-expand-btn"
                  onClick={handleToggleDescriptionExpand}
                  onMouseDown={(e) => e.preventDefault()}
                  aria-label={t("inline.expandDescription", "Expand description")}
                  title={t("inline.expandDescription", "Expand description")}
                  data-testid="inline-create-expand"
                >
                  <Maximize2 size={14} />
                </button>
              )}
            </div>
            <button
              type="button"
              className="btn btn-sm inline-create-toggle"
              onClick={toggleExpanded}
              aria-expanded={isExpanded}
              aria-controls={isExpanded ? "inline-create-controls" : undefined}
              aria-label={isExpanded ? t("inline.collapseTaskOptions", "Collapse advanced task options") : t("inline.expandTaskOptions", "Expand advanced task options")}
              data-testid="inline-create-toggle"
              title={isExpanded ? t("inline.collapse", "Collapse") : t("inline.expand", "Expand")}
            >
              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        )}
        {isDescriptionExpanded && (
          <textarea
            ref={inputRef}
            rows={10}
            className="inline-create-input inline-create-input--fullscreen"
            placeholder={t("inline.whatNeedsToBeDone", "What needs to be done?")}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = el.scrollHeight + "px";
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setIsDescriptionFocused(true)}
            onBlur={() => setIsDescriptionFocused(false)}
            disabled={submitting}
            data-testid="inline-create-input-fullscreen"
          />
        )}
      </div>
      {pendingImages.length > 0 && (
        <div className="inline-create-previews">
          {pendingImages.map((img, i) => (
            <div key={img.previewUrl} className="inline-create-preview">
              <img src={img.previewUrl} alt={img.file.name} />
              <button
                type="button"
                className="inline-create-preview-remove"
                onClick={() => removeImage(i)}
                disabled={submitting}
                title={t("inline.removeImage", "Remove image")}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {isExpanded && (
        <div id="inline-create-controls" className="inline-create-footer">
          <div className="inline-create-controls">
            {/* FNXC:QuickAddSubtaskFlag 2026-06-21-00:00: Render no Subtask button or orphaned inline-create click target unless the default-off `subtaskBreakdown` experiment wires this callback. */}
            {onSubtaskBreakdown && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={handleSubtaskClick}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!description.trim()}
                data-testid="subtask-button"
                title={t("inline.breakDownSubtasks", "Break down into AI-generated subtasks")}
              >
                <ListTree size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                {t("inline.subtask", "Subtask")}
              </button>
            )}
            <div className="dep-trigger-wrap">
              <button
                type="button"
                className="btn btn-sm dep-trigger"
                onClick={toggleDepsDropdown}
              >
                <Link size={12} style={{ verticalAlign: "middle" }} />
                {dependencies.length > 0 ? ` ${dependencies.length} ${t("inline.deps", "deps")}` : ` ${t("inline.deps", "Deps")}`}
              </button>
              {showDeps && (() => {
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
                return (
                  <div className="dep-dropdown" onMouseDown={(e) => e.preventDefault()}>
                    <input
                      className="dep-dropdown-search"
                      placeholder={t("inline.searchTasks", "Search tasks…")}
                      autoFocus
                      value={depSearch}
                      onChange={(e) => setDepSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {filtered.length === 0 ? (
                      <div className="dep-dropdown-empty">{t("inline.noExistingTasks", "No existing tasks")}</div>
                    ) : (
                      filtered.map((t) => (
                        <div
                          key={t.id}
                          className={`dep-dropdown-item${dependencies.includes(t.id) ? " selected" : ""}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => toggleDep(t.id)}
                        >
                          <span className="dep-dropdown-id">{t.id}</span>
                          <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 30)}</span>
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}
            </div>

            {shouldShowNodePicker && (
              <div className="node-trigger-wrap" ref={nodePickerRef}>
                <button
                  type="button"
                  className="btn btn-sm dep-trigger"
                  data-testid="inline-create-node-button"
                  onClick={() => {
                    setShowNodePicker((prev) => {
                      const next = !prev;
                      if (next) {
                        setShowDeps(false);
                        setShowAgentPicker(false);
                        setIsModelModalOpen(false);
                        setShowPresets(false);
                      }
                      return next;
                    });
                  }}
                >
                  <Server size={12} style={{ verticalAlign: "middle" }} />
                  {selectedNode ? ` ${selectedNode.name}` : ` ${t("inline.node", "Node")}`}
                  {selectedNode && <NodeHealthDot status={selectedNode.status} showLabel />}
                </button>
                {showNodePicker && (
                  <div className="dep-dropdown node-picker-dropdown" onMouseDown={(e) => e.preventDefault()}>
                    <div className="dep-dropdown-search-header">{t("inline.selectExecutionNode", "Select execution node")}</div>
                    <button
                      type="button"
                      className={`dep-dropdown-item node-picker-item${nodeId === undefined ? " selected" : ""}`}
                      onClick={() => {
                        setNodeId(undefined);
                        setShowNodePicker(false);
                      }}
                    >
                      <span className="dep-dropdown-title">{t("inline.projectDefaultLocal", "Project default / local")}</span>
                    </button>
                    {nodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        className={`dep-dropdown-item node-picker-item${nodeId === node.id ? " selected" : ""}`}
                        onClick={() => {
                          setNodeId(node.id);
                          setShowNodePicker(false);
                        }}
                      >
                        <NodeHealthDot status={node.status} />
                        <span className="dep-dropdown-title">{node.name}</span>
                        <span className="node-picker-status-label">{getNodeStatusLabel(node.status, t)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="agent-trigger-wrap" ref={agentPickerRef}>
              <button
                type="button"
                className="btn btn-sm dep-trigger"
                onClick={() => {
                  if (showAgentPicker) {
                    setShowAgentPicker(false);
                  } else {
                    void loadAgents();
                  }
                }}
                data-testid="inline-create-agent-button"
              >
                <Bot size={12} style={{ verticalAlign: "middle" }} />
                {selectedAgentLabel ? ` ${selectedAgentLabel}` : ` ${t("inline.agent", "Agent")}`}
              </button>
              {showAgentPicker && (
                <div className="dep-dropdown agent-picker-dropdown" onMouseDown={(e) => e.preventDefault()}>
                  <div className="dep-dropdown-search-header">{t("inline.selectAgent", "Select agent")}</div>
                  {agentsLoading && <div className="dep-dropdown-empty"><LoadingSpinner label={t("inline.loadingAgents", "Loading agents...")} /></div>}
                  {!agentsLoading && agents.map((a) => (
                    <div
                      key={a.id}
                      className={`dep-dropdown-item${selectedAgentId === a.id ? " selected" : ""}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSelectedAgentId(a.id === selectedAgentId ? null : a.id);
                        setShowAgentPicker(false);
                      }}
                    >
                      <Bot size={12} style={{ marginRight: 6 }} />
                      <span className="dep-dropdown-id">{a.role}</span>
                      <span className="dep-dropdown-title">{a.name}</span>
                    </div>
                  ))}
                  {!agentsLoading && agents.length === 0 && (
                    <div className="dep-dropdown-empty">{t("inline.noAgentsAvailable", "No agents available")}</div>
                  )}
                  {selectedAgentId && (
                    <div
                      className="dep-dropdown-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSelectedAgentId(null);
                        setShowAgentPicker(false);
                      }}
                    >
                      <span className="dep-dropdown-title">{t("inline.clearSelection", "Clear selection")}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {optionalSteps.length > 0 && (
              <div
                className="inline-create-optional-steps"
                aria-label={t("inline.optionalWorkflowSteps", "Optional workflow steps")}
              >
                {/* FNXC:TaskCreation 2026-06-21-00:00:
                    Inline quick-add uses the shared optional-steps dropdown so it matches
                    the modal/quick-add keyboard + a11y behavior and toggles the same
                    enabledWorkflowSteps set submitted on create. */}
                <WorkflowOptionalStepsDropdown
                  steps={optionalSteps}
                  enabledIds={enabledOptionalStepIds}
                  onToggle={toggleOptionalStep}
                  triggerTestId="inline-create-optional-steps-trigger"
                />
              </div>
            )}

            <WorkflowSelector
              value={selectedWorkflowId}
              onChange={(id) => setSelectedWorkflowId(id)}
              projectId={projectId}
              addToast={addToast}
              label="Workflow"
              disabled={submitting}
            />

            <label className="inline-create-priority-wrap" htmlFor="inline-create-priority-select">
              <span className="visually-hidden">{t("inline.priority", "Priority")}</span>
              <select
                id="inline-create-priority-select"
                className="select inline-create-priority-select"
                data-testid="inline-create-priority-select"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
              >
                {TASK_PRIORITIES.map((taskPriority) => (
                  <option key={taskPriority} value={taskPriority}>
                    {t("inline.priorityLabel", "Priority: {{level}}", { level: `${taskPriority[0].toUpperCase()}${taskPriority.slice(1)}` })}
                  </option>
                ))}
              </select>
            </label>

            <div className="inline-create-model-wrap">
              <button
                type="button"
                className="btn btn-sm inline-create-model-trigger"
                onClick={() => {
                  setShowPresets((prev) => {
                    const next = !prev;
                    if (next) {
                      setShowDeps(false);
                      setShowNodePicker(false);
                      setShowAgentPicker(false);
                      setIsModelModalOpen(false);
                    }
                    return next;
                  });
                }}
                aria-expanded={showPresets}
                aria-haspopup="listbox"
              >
                <Zap size={12} style={{ verticalAlign: "middle" }} />
                {selectedPreset ? ` ${selectedPreset.name}` : ` ${t("inline.preset", "Preset")}`}
              </button>
              {showPresets && (
                <div className="inline-create-model-dropdown" onMouseDown={handleModelDropdownMouseDown}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setSelectedPresetId(undefined);
                      setExecutorProvider(undefined);
                      setExecutorModelId(undefined);
                      setValidatorProvider(undefined);
                      setValidatorModelId(undefined);
                      setPlanningProvider(undefined);
                      setPlanningModelId(undefined);
                      setShowPresets(false);
                    }}
                  >
                    {t("inline.useDefault", "Use default")}
                  </button>
                  {availablePresets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        const selection = applyPresetToSelection(preset);
                        const executor = parseModelSelection(selection.executorValue);
                        const validator = parseModelSelection(selection.validatorValue);
                        setSelectedPresetId(preset.id);
                        setExecutorProvider(executor.provider);
                        setExecutorModelId(executor.modelId);
                        setValidatorProvider(validator.provider);
                        setValidatorModelId(validator.modelId);
                        setShowPresets(false);
                      }}
                    >
                      {preset.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowPresets(false)}
                  >
                    {t("inline.custom", "Custom")}
                  </button>
                </div>
              )}
              <button
                type="button"
                className="btn btn-sm inline-create-model-trigger"
                onClick={toggleModelsDropdown}
                aria-expanded={isModelModalOpen}
                aria-haspopup="dialog"
              >
                <Brain size={12} style={{ verticalAlign: "middle" }} />
                {selectedPreset
                  ? ` ${selectedPreset.name} · ${selectedModelCount} ${t("inline.model", "model", { count: selectedModelCount })}`
                  : selectedModelCount > 0
                    ? ` ${selectedModelCount} ${t("inline.model", "model", { count: selectedModelCount })}`
                    : ` ${t("inline.models", "Models")}`}
              </button>

            </div>

          </div>
          <div className="inline-create-actions">
            <span className="inline-create-hint">{t("inline.hintEnterEsc", "Enter to create · Esc to cancel")}</span>
            <button
              type="button"
              className="btn btn-task-create btn-sm"
              onClick={handleSubmit}
              disabled={!description.trim() || submitting}
              data-testid="save-button"
            >
              {submitting ? t("inline.creating", "Creating...") : t("inline.save", "Save")}
            </button>
          </div>
        </div>
      )}

      {typeof document !== "undefined"
        ? createPortal(
            <ModelSelectionModal
              isOpen={isModelModalOpen}
              onClose={() => setIsModelModalOpen(false)}
              models={loadedModels}
              executorValue={executorSelectionValue}
              validatorValue={validatorSelectionValue}
              planningValue={planningSelectionValue}
              onExecutorChange={handleExecutorChange}
              onValidatorChange={handleValidatorChange}
              onPlanningChange={handlePlanningModelChange}
              modelsLoading={modelsLoading}
              modelsError={modelsError}
              onRetry={loadModels}
              favoriteProviders={favoriteProviders}
              onToggleFavorite={handleToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={handleToggleModelFavorite}
              presets={availablePresets}
              selectedPresetId={selectedPresetId}
              onPresetChange={(presetId) => setSelectedPresetId(presetId)}
            />,
            document.body,
          )
        : null}

      {duplicateMatches && duplicateMatches.length > 0 ? (
        <DuplicateWarningModal
          matches={duplicateMatches}
          onProceed={handleDuplicateProceed}
          onCancel={handleDuplicateCancel}
          onOpen={handleDuplicateOpen}
        />
      ) : null}
    </div>
  );
}
