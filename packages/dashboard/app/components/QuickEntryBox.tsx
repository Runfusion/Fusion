import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { ToastType } from "../hooks/useToast";
import type { Task, TaskCreateInput, Settings } from "@fusion/core";
import type { ModelInfo, RefinementType, Agent } from "../api";
import { fetchModels, fetchSettings, refineText, getRefineErrorMessage, updateGlobalSettings, fetchAgents, uploadAttachment } from "../api";
import { Link, Paperclip, Brain, Lightbulb, ListTree, Sparkles, Save, ChevronDown, ChevronUp, ChevronRight, Bot } from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { getScopedItem, removeScopedItem, setScopedItem } from "../utils/projectStorage";

const STORAGE_KEY = "kb-quick-entry-text";
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface PendingImage {
  file: File;
  previewUrl: string;
}

interface QuickEntryBoxProps {
  onCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  addToast: (message: string, type?: ToastType) => void;
  tasks?: Task[];
  availableModels?: ModelInfo[];
  /**
   * Called when the user clicks the "Plan" button to open planning mode.
   */
  onPlanningMode?: (initialPlan: string) => void;
  /**
   * Called when the user clicks the "Subtask" button to trigger subtask breakdown.
   */
  onSubtaskBreakdown?: (description: string) => void;
  /** Optional project context for API calls */
  projectId?: string;
  /**
   * When true, the component automatically expands when focused.
   * Set to false to keep the view collapsed until manually toggled.
   * Defaults to true for backward compatibility.
   */
  autoExpand?: boolean;
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

export function QuickEntryBox({ onCreate, addToast, tasks = [], availableModels, onPlanningMode, onSubtaskBreakdown, projectId, autoExpand = true, favoriteProviders: parentFavoriteProviders, favoriteModels: parentFavoriteModels, onToggleFavorite: parentToggleFavorite, onToggleModelFavorite: parentToggleModelFavorite }: QuickEntryBoxProps) {
  const [description, setDescription] = useState(() => {
    if (typeof window !== "undefined") {
      return getScopedItem(STORAGE_KEY, projectId) || "";
    }
    return "";
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  // isExpanded controls textarea height styling (auto-resize)
  const [isExpanded, setIsExpanded] = useState(false);
  // isDisclosureExpanded controls visibility of the controls panel (Deps, Models, etc.)
  // Always starts collapsed — user must explicitly toggle each session
  const [isDisclosureExpanded, setIsDisclosureExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const justResetRef = useRef(false);
  const previousProjectIdRef = useRef(projectId);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const pendingImagesRef = useRef<PendingImage[]>([]);

  // Rich creation state (mirrors InlineCreateCard)
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsProjectId, setAgentsProjectId] = useState<string | undefined>(undefined);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
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
  const [modelMenuPosition, setModelMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight?: number } | null>(null);
  // Dependency dropdown portal refs and state
  const depTriggerRef = useRef<HTMLButtonElement>(null);
  const depDropdownPortalRef = useRef<HTMLDivElement>(null);
  const [depDropdownPosition, setDepDropdownPosition] = useState<{ top: number; left: number; width: number; maxHeight?: number } | null>(null);
  const [portalRoot] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.body : null,
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadedModels, setLoadedModels] = useState<ModelInfo[]>(availableModels ?? []);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | undefined>(undefined);

  // AI Refinement state
  const [isRefineMenuOpen, setIsRefineMenuOpen] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const refineMenuRef = useRef<HTMLDivElement>(null);
  const refineMenuPortalRef = useRef<HTMLDivElement>(null);
  const [refineMenuPosition, setRefineMenuPosition] = useState<{ top: number; left: number } | null>(null);

  // Use parent-provided favorites when available, otherwise internal state
  const effectiveFavoriteProviders = parentFavoriteProviders ?? favoriteProviders;
  const effectiveFavoriteModels = parentFavoriteModels ?? favoriteModels;

  // If onCreate is not provided, the component is disabled
  const isDisabled = !onCreate;

  // Fetch models and settings if not provided by parent
  useEffect(() => {
    if (availableModels) {
      setLoadedModels(availableModels);
      setModelsLoading(false);
      setModelsError(null);
    } else {
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
        .catch((err: any) => {
          if (!cancelled) {
            setModelsError(err?.message || "Failed to load models");
          }
        })
        .finally(() => {
          if (!cancelled) {
            setModelsLoading(false);
          }
        });

      // Also fetch settings for presets
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
    }
  }, [availableModels, parentFavoriteProviders, parentFavoriteModels, projectId]);

  const executorSelectionValue = getModelSelectionValue(executorProvider, executorModelId);
  const validatorSelectionValue = getModelSelectionValue(validatorProvider, validatorModelId);
  const planningSelectionValue = getModelSelectionValue(planningProvider, planningModelId);

  const hasExecutorOverride = Boolean(executorProvider && executorModelId);
  const hasValidatorOverride = Boolean(validatorProvider && validatorModelId);
  const hasPlanningOverride = Boolean(planningProvider && planningModelId);
  const selectedModelCount = Number(hasExecutorOverride) + Number(hasValidatorOverride) + Number(hasPlanningOverride);
  const modelMenuLabel = selectedPresetId
    ? settings?.modelPresets?.find((p) => p.id === selectedPresetId)?.name ?? "Models"
    : selectedModelCount > 0
      ? `${selectedModelCount} model${selectedModelCount === 1 ? "" : "s"}`
      : "Models";

  const getModelBadgeLabel = useCallback(
    (provider?: string, modelId?: string) => {
      if (!provider || !modelId) return "Using default";
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
  useEffect(() => {
    if (isExpanded) {
      autoResize();
    }
  }, [description, isExpanded, autoResize]);

  // Restore focus after submission completes (when textarea is re-enabled)
  useEffect(() => {
    if (!isSubmitting && description === "" && textareaRef.current) {
      // Use setTimeout to ensure focus happens after React re-enables the textarea
      const focusTimeout = setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
      return () => clearTimeout(focusTimeout);
    }
  }, [isSubmitting, description]);

  // Clear dep search when dropdown closes
  useEffect(() => {
    if (!showDeps) setDepSearch("");
  }, [showDeps]);

  // Close refine menu when clicking outside
  useEffect(() => {
    if (!isRefineMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInsideTrigger = refineMenuRef.current?.contains(target);
      const clickedInsidePortal = refineMenuPortalRef.current?.contains(target);

      if (!clickedInsideTrigger && !clickedInsidePortal) {
        setIsRefineMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isRefineMenuOpen]);

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
    if (!showAgentPicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (agentPickerRef.current?.contains(target)) return;
      setShowAgentPicker(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showAgentPicker]);

  const resetForm = useCallback(() => {
    pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setPendingImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    setDescription("");
    setDependencies([]);
    setSelectedAgentId(null);
    setShowAgentPicker(false);
    setExecutorProvider(undefined);
    setExecutorModelId(undefined);
    setValidatorProvider(undefined);
    setValidatorModelId(undefined);
    setPlanningProvider(undefined);
    setPlanningModelId(undefined);
    setSelectedPresetId(undefined);
    setShowDeps(false);
    setIsModelMenuOpen(false);
    setModelMenuPosition(null);
    setActiveModelSubmenu(null);
    setIsRefineMenuOpen(false);
    setIsRefining(false);
    setIsExpanded(false); // Collapse textarea height on reset
    setIsDisclosureExpanded(false); // Always reset controls to collapsed after creation
    justResetRef.current = true;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Clear localStorage when form is reset (after successful creation)
    if (typeof window !== "undefined") {
      removeScopedItem(STORAGE_KEY, projectId);
    }
  }, [pendingImages, projectId]);

  const handleImageFiles = useCallback((files: FileList | null | undefined) => {
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

  const handleSubmit = useCallback(async () => {
    const trimmed = description.trim();
    if (!trimmed || isSubmitting || !onCreate) return;

    setIsSubmitting(true);
    try {
      const createdTask = await onCreate({
        description: trimmed,
        column: "triage",
        dependencies: dependencies.length ? dependencies : undefined,
        ...(selectedAgentId ? { assignedAgentId: selectedAgentId } : {}),
        modelPresetId: selectedPresetId,
        modelProvider: hasExecutorOverride ? executorProvider : undefined,
        modelId: hasExecutorOverride ? executorModelId : undefined,
        validatorModelProvider: hasValidatorOverride ? validatorProvider : undefined,
        validatorModelId: hasValidatorOverride ? validatorModelId : undefined,
        planningModelProvider: hasPlanningOverride ? planningProvider : undefined,
        planningModelId: hasPlanningOverride ? planningModelId : undefined,
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
          addToast(`Failed to upload: ${failures.join(", ")}`, "error");
        }
      }
      // Clear input for rapid entry
      resetForm();
      // Note: Focus restoration is handled by useEffect when isSubmitting becomes false
    } catch (err: any) {
      addToast(err.message || "Failed to create task", "error");
      // Keep input content on failure so user can retry
    } finally {
      setIsSubmitting(false);
    }
  }, [
    description,
    isSubmitting,
    onCreate,
    dependencies,
    selectedAgentId,
    hasExecutorOverride,
    executorProvider,
    executorModelId,
    hasValidatorOverride,
    validatorProvider,
    validatorModelId,
    hasPlanningOverride,
    planningProvider,
    planningModelId,
    pendingImages,
    projectId,
    addToast,
    resetForm,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter") {
        if (e.shiftKey && isExpanded) {
          // Allow Shift+Enter to insert newline when expanded or in fullscreen mode
          // Don't prevent default - let the newline be inserted
          return;
        }
        // Enter without Shift submits
        e.preventDefault();
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
        if (isRefineMenuOpen) {
          setIsRefineMenuOpen(false);
          return;
        }
        if (showAgentPicker) {
          setShowAgentPicker(false);
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
      isModelMenuOpen,
      activeModelSubmenu,
      isRefineMenuOpen,
      projectId,
      setIsDisclosureExpanded,
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
    if (autoExpand) {
      setIsExpanded(true);
    }
  }, [autoExpand]);

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

    const preferredWidth = isMobile
      ? Math.min(viewportWidth - horizontalPadding * 2, 360)
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

    setModelMenuPosition({
      top,
      left,
      width,
      maxHeight,
    });
  }, [getEffectiveViewport]);

  const updateRefineMenuPosition = useCallback(() => {
    const trigger = refineMenuRef.current?.querySelector(".refine-button") as HTMLElement | null;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 8;
    const verticalPadding = 12;
    const gap = 4;
    const expectedMenuHeight = Math.min(200, Math.max(viewportHeight - verticalPadding * 2, 160));
    const menuWidth = Math.min(200, viewportWidth - horizontalPadding * 2);

    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;

    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const openUpward = spaceBelow < expectedMenuHeight && spaceAbove > spaceBelow;

    const left = Math.min(
      Math.max(triggerLeft, horizontalPadding),
      viewportWidth - horizontalPadding - menuWidth,
    ) + offsetLeft;

    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - expectedMenuHeight - gap + offsetTop)
      : Math.min(
          triggerBottom + gap + offsetTop,
          viewportHeight + offsetTop - verticalPadding - expectedMenuHeight,
        );

    setRefineMenuPosition({
      top,
      left,
    });
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

  // Keep refine menu portal anchored during scroll/resize
  useEffect(() => {
    if (!isRefineMenuOpen) return;

    const handleReposition = () => updateRefineMenuPosition();

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
  }, [isRefineMenuOpen, updateRefineMenuPosition]);

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

  const handlePlanClick = useCallback(() => {
    const trimmed = description.trim();
    if (!trimmed) {
      addToast("Enter a description first", "error");
      return;
    }
    onPlanningMode?.(trimmed);
    // Clear the form after triggering planning mode
    resetForm();
  }, [description, onPlanningMode, addToast, resetForm]);

  const handleSubtaskClick = useCallback(() => {
    const trimmed = description.trim();
    if (!trimmed) {
      addToast("Enter a description first", "error");
      return;
    }
    onSubtaskBreakdown?.(trimmed);
    // Clear the form after triggering subtask breakdown
    resetForm();
  }, [description, onSubtaskBreakdown, addToast, resetForm]);

  const handleSaveClick = useCallback(() => {
    // Save button now creates the task (same as Enter key)
    handleSubmit();
  }, [handleSubmit]);

  const handleRefine = useCallback(async (type: RefinementType) => {
    const trimmed = description.trim();
    if (!trimmed || isRefining) return;

    setIsRefineMenuOpen(false);
    setIsRefining(true);
    try {
      const refined = await refineText(trimmed, type);
      setDescription(refined);
      addToast("Description refined with AI", "success");
      // Auto-resize textarea after content update
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
      }
    } catch (err: any) {
      const errorMessage = getRefineErrorMessage(err);
      addToast(errorMessage, "error");
    } finally {
      setIsRefining(false);
    }
  }, [description, isRefining, addToast]);

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
    } catch (err: any) {
      setModelsError(err?.message || "Failed to load models");
    } finally {
      setModelsLoading(false);
    }
  }, [availableModels, parentFavoriteProviders, parentFavoriteModels]);

  const loadAgents = useCallback(async () => {
    if (agents.length > 0 && agentsProjectId === projectId) {
      setShowAgentPicker(true);
      return;
    }

    setAgentsLoading(true);
    try {
      const result = await fetchAgents(undefined, projectId);
      setAgents(result);
      setAgentsProjectId(projectId);
      setShowAgentPicker(true);
    } catch (err: any) {
      addToast(err?.message ? `Failed to load agents: ${err.message}` : "Failed to load agents", "error");
      setShowAgentPicker(false);
    } finally {
      setAgentsLoading(false);
    }
  }, [agents.length, agentsProjectId, projectId, addToast]);

  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) : undefined;
  const selectedAgentLabel = selectedAgent?.name ?? selectedAgentId;

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
    <div className={`quick-entry-box ${isDisclosureExpanded ? "quick-entry-box--expanded" : "quick-entry-box--collapsed"}`} data-testid="quick-entry-box">
      <div className="description-with-refine">
        <div className="quick-entry-main-row">
          <div className="quick-entry-textarea-wrap">
            <textarea
              ref={textareaRef}
              className={`quick-entry-input ${isExpanded ? "quick-entry-input--expanded" : ""}`}
              placeholder={isSubmitting ? "Creating..." : "Add a task..."}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={handleFocus}
              onBlur={handleBlur}
              disabled={isSubmitting || isDisabled}
              data-testid="quick-entry-input"
              rows={2}
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
            title={isDisclosureExpanded ? "Collapse" : "Expand"}
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
          <div className="quick-entry-actions" data-testid="quick-entry-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={handlePlanClick}
              onMouseDown={(e) => e.preventDefault()}
              disabled={!description.trim()}
              data-testid="plan-button"
              title="Open planning mode with current description"
            >
              <Lightbulb size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
              Plan
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleSubtaskClick}
              onMouseDown={(e) => e.preventDefault()}
              disabled={!description.trim()}
              data-testid="subtask-button"
              title="Break down into AI-generated subtasks"
            >
              <ListTree size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
              Subtask
            </button>
            <div className="refine-trigger-wrap" ref={refineMenuRef}>
              <button
                type="button"
                className={`btn btn-sm refine-button ${isRefining ? "refine-button--loading" : ""}`}
                onClick={() => {
                  setIsRefineMenuOpen((prev) => {
                    const next = !prev;
                    if (next) {
                      // Compute position synchronously so the portal renders on first paint
                      updateRefineMenuPosition();
                    } else {
                      setRefineMenuPosition(null);
                    }
                    return next;
                  });
                }}
                disabled={!description.trim() || isRefining}
                data-testid="refine-button"
                title="Refine description with AI"
              >
                <Sparkles size={12} style={{ verticalAlign: "middle" }} />
                {isRefining ? "Refining..." : "Refine"}
              </button>
              {isRefineMenuOpen && portalRoot && refineMenuPosition && createPortal(
                <div
                  ref={refineMenuPortalRef}
                  className="refine-menu refine-menu--portal"
                  onMouseDown={(e) => e.preventDefault()}
                  style={{
                    position: "fixed",
                    top: `${refineMenuPosition.top}px`,
                    left: `${refineMenuPosition.left}px`,
                  }}
                >
                  <div
                    className="refine-menu-item"
                    onClick={() => handleRefine("clarify")}
                    data-testid="refine-clarify"
                  >
                    <div className="refine-menu-item-title">Clarify</div>
                    <div className="refine-menu-item-desc">Make the description clearer and more specific</div>
                  </div>
                  <div
                    className="refine-menu-item"
                    onClick={() => handleRefine("add-details")}
                    data-testid="refine-add-details"
                  >
                    <div className="refine-menu-item-title">Add details</div>
                    <div className="refine-menu-item-desc">Add implementation details and context</div>
                  </div>
                  <div
                    className="refine-menu-item"
                    onClick={() => handleRefine("expand")}
                    data-testid="refine-expand"
                  >
                    <div className="refine-menu-item-title">Expand</div>
                    <div className="refine-menu-item-desc">Expand into a more comprehensive description</div>
                  </div>
                  <div
                    className="refine-menu-item"
                    onClick={() => handleRefine("simplify")}
                    data-testid="refine-simplify"
                  >
                    <div className="refine-menu-item-title">Simplify</div>
                    <div className="refine-menu-item-desc">Simplify and make more concise</div>
                  </div>
                </div>,
                portalRoot,
              )}
            </div>

            <div className="dep-trigger-wrap">
              <button
                ref={depTriggerRef}
                type="button"
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
                {dependencies.length > 0 ? `${dependencies.length} deps` : "Deps"}
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
                    placeholder="Search tasks…"
                    autoFocus
                    value={depSearch}
                    onChange={(e) => setDepSearch(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {filtered.length === 0 ? (
                    <div className="dep-dropdown-empty">No existing tasks</div>
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
              type="button"
              className="btn btn-sm"
              data-testid="quick-entry-attach"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={12} style={{ verticalAlign: "middle" }} />
              {pendingImages.length > 0 ? `Attach (${pendingImages.length})` : "Attach"}
            </button>

            <button
              ref={modelTriggerRef}
              type="button"
              className="btn btn-sm"
              data-testid="quick-entry-models"
              onClick={() => {
                setShowDeps(false);
                setShowAgentPicker(false);
                setActiveModelSubmenu(null);
                setIsModelMenuOpen(true);
                updateModelMenuPosition();
              }}
            >
              <Brain size={12} style={{ verticalAlign: "middle" }} />
              {modelMenuLabel}
            </button>

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
                data-testid="quick-entry-agent-button"
              >
                <Bot size={12} style={{ verticalAlign: "middle" }} />
                {selectedAgentLabel ? ` ${selectedAgentLabel}` : " Agent"}
              </button>
              {showAgentPicker && (
                <div className="dep-dropdown agent-picker-dropdown" onMouseDown={(e) => e.preventDefault()}>
                  <div className="dep-dropdown-search-header">Select agent</div>
                  {agentsLoading && <div className="dep-dropdown-empty">Loading agents...</div>}
                  {!agentsLoading && agents.filter((a) => a.state !== "terminated").map((a) => (
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
                  {!agentsLoading && agents.filter((a) => a.state !== "terminated").length === 0 && (
                    <div className="dep-dropdown-empty">No agents available</div>
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
                      <span className="dep-dropdown-title">Clear selection</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              className="btn btn-task-create btn-sm"
              onClick={handleSaveClick}
              onMouseDown={(e) => e.preventDefault()}
              disabled={!description.trim() || isSubmitting}
              data-testid="quick-entry-save"
              title="Create task"
            >
              <Save size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
              Save
            </button>
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
                  title="Remove image"
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
                // Top-level menu with Plan/Executor/Validator choices
                <div className="model-menu-items">
                  <button
                    type="button"
                    className={`model-menu-item ${hasPlanningOverride ? "model-menu-item--active" : ""}`}
                    onClick={() => setActiveModelSubmenu("plan")}
                    data-testid="model-menu-plan"
                  >
                    <span className="model-menu-item-label">
                      <Lightbulb size={12} style={{ verticalAlign: "middle", marginRight: 6 }} />
                      Plan
                    </span>
                    <span className="model-menu-item-value">
                      {hasPlanningOverride
                        ? getModelBadgeLabel(planningProvider, planningModelId)
                        : "Using default"}
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
                      Executor
                    </span>
                    <span className="model-menu-item-value">
                      {hasExecutorOverride
                        ? getModelBadgeLabel(executorProvider, executorModelId)
                        : "Using default"}
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
                      Validator
                    </span>
                    <span className="model-menu-item-value">
                      {hasValidatorOverride
                        ? getModelBadgeLabel(validatorProvider, validatorModelId)
                        : "Using default"}
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
                    Back
                  </button>
                  <div className="model-submenu-header">
                    {activeModelSubmenu === "plan" && "Plan Model"}
                    {activeModelSubmenu === "executor" && "Executor Model"}
                    {activeModelSubmenu === "validator" && "Validator Model"}
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
                    placeholder="Using default"
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
                        Retry
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
        <div className="quick-entry-hint">
          Enter to create · Esc to cancel
        </div>
      </div>
  );
}
