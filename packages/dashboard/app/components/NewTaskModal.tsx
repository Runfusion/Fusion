import "./NewTaskModal.css";
import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_TASK_PRIORITY, type Task, type TaskCreateInput, type TaskPriority } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { uploadAttachment } from "../api";
import { Bot } from "lucide-react";
import { useSetupReadiness } from "../hooks/useSetupReadiness";
import { SetupWarningBanner } from "./SetupWarningBanner";
import { TaskForm, type BranchSelectionMode, type PendingImage } from "./TaskForm";
import { REPO_OVERRIDE_RE } from "./githubTracking";
import { useConfirm } from "../hooks/useConfirm";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useNodes } from "../hooks/useNodes";
import { useViewportMode } from "../hooks/useViewportMode";
import { useAgentsMapCache } from "../hooks/useAgentsMapCache";

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  tasks: Task[]; // for dependency selection
  onCreateTask: (input: TaskCreateInput) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
  initialDescription?: string;
}

export function NewTaskModal({ isOpen, onClose, projectId, tasks, onCreateTask, addToast, initialDescription = "" }: NewTaskModalProps) {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  const viewportMode = useViewportMode();
  useMobileScrollLock(isOpen);
  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } = useMobileKeyboard({
    enabled: viewportMode === "mobile",
  });
  const keyboardStyle: React.CSSProperties = keyboardOpen
    ? ({
        "--keyboard-overlap": `${keyboardOverlap}px`,
        "--vv-offset-top": `${viewportOffsetTop}px`,
        ...(viewportHeight !== null ? { "--vv-height": `${viewportHeight}px` } : {}),
      } as React.CSSProperties)
    : {};
  const [description, setDescription] = useState("");
  const wasOpenRef = useRef(false);
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [branchMode, setBranchMode] = useState<BranchSelectionMode>("project-default");
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [executorModel, setExecutorModel] = useState("");
  const [validatorModel, setValidatorModel] = useState("");
  const [planningModel, setPlanningModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<string>("");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [presetMode, setPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [hasDirtyState, setHasDirtyState] = useState(false);
  // U6/R3: tri-state workflow selection. `undefined` = inherit project default,
  // `null` = explicit "No workflow", `string` = a specific workflow. Materialized
  // atomically at create time via the `workflowId` create parameter.
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null | undefined>(undefined);
  const [reviewLevel, setReviewLevel] = useState<number | undefined>(undefined);
  const [autoMerge, setAutoMerge] = useState<boolean | undefined>(undefined);
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [nodeId, setNodeId] = useState<string | undefined>(undefined);
  const [githubTrackingEnabled, setGithubTrackingEnabled] = useState(false);
  const [githubRepoOverride, setGithubRepoOverride] = useState("");

  // Agent assignment state
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const { agents, loading: agentsLoading } = useAgentsMapCache(projectId);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  // Quick-fields dependency picker state
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const quickFieldsDepRef = useRef<HTMLDivElement>(null);

  const { hasAiProvider, hasGithub, loading: setupReadinessLoading } = useSetupReadiness(projectId);
  const { nodes } = useNodes();

  /**
   * FNXC:SelectionComment 2026-06-16-23:58:
   * Selection comments open the normal New Task dialog with a prefilled description; seed only on the closed→open transition so rerenders do not overwrite user edits.
   */
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setDescription(initialDescription);
    }
    wasOpenRef.current = isOpen;
  }, [initialDescription, isOpen]);

  // Load agents for agent picker
  const loadAgents = useCallback(() => {
    setShowAgentPicker(true);
  }, []);

  // Close agent picker when clicking outside
  useEffect(() => {
    if (!showAgentPicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setShowAgentPicker(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showAgentPicker]);

  // Close quick-fields dep dropdown when clicking outside
  useEffect(() => {
    if (!showDeps) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (quickFieldsDepRef.current && !quickFieldsDepRef.current.contains(e.target as Node)) {
        setShowDeps(false);
        setDepSearch("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showDeps]);

  // Compute available deps for quick-fields picker (same logic as TaskForm)
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

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  const githubRepoOverrideTrimmed = githubRepoOverride.trim();
  const githubRepoOverrideInvalid = githubRepoOverrideTrimmed.length > 0 && !REPO_OVERRIDE_RE.test(githubRepoOverrideTrimmed);
  const isBranchNameRequired = branchMode === "existing" || branchMode === "custom-new" || branchMode === "shared-group";
  const hasInvalidBranchSelection = isBranchNameRequired && !branch.trim();

  // Track dirty state
  useEffect(() => {
    const isDirty =
      description.trim() !== "" ||
      dependencies.length > 0 ||
      pendingImages.length > 0 ||
      selectedWorkflowId !== undefined ||
      executorModel !== "" ||
      validatorModel !== "" ||
      planningModel !== "" ||
      thinkingLevel !== "" ||
      selectedAgentId !== null ||
      reviewLevel !== undefined ||
      autoMerge !== undefined ||
      priority !== DEFAULT_TASK_PRIORITY ||
      nodeId !== undefined ||
      branchMode !== "project-default" ||
      branch !== "" ||
      baseBranch !== "" ||
      githubTrackingEnabled ||
      githubRepoOverrideTrimmed !== "";
    setHasDirtyState(isDirty);
  }, [description, dependencies, pendingImages, selectedWorkflowId, executorModel, validatorModel, planningModel, thinkingLevel, selectedAgentId, reviewLevel, autoMerge, priority, nodeId, branchMode, branch, baseBranch, githubTrackingEnabled, githubRepoOverrideTrimmed]);

  const handleClose = useCallback(async () => {
    if (hasDirtyState) {
      const shouldDiscard = await confirm({
        title: t("newTaskModal.discardChanges", "Discard Changes"),
        message: t("newTaskModal.unsavedChanges", "You have unsaved changes. Discard them?"),
        danger: true,
      });
      if (!shouldDiscard) return;
    }
    // Clean up object URLs
    pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    // Reset form
    setPendingImages([]);
    setDescription("");
    setDependencies([]);
    setExecutorModel("");
    setValidatorModel("");
    setPlanningModel("");
    setThinkingLevel("");
    setSelectedPresetId("");
    setPresetMode("default");
    setSelectedWorkflowId(undefined);
    setSelectedAgentId(null);
    setShowAgentPicker(false);
    setReviewLevel(undefined);
    setAutoMerge(undefined);
    setPriority(DEFAULT_TASK_PRIORITY);
    setNodeId(undefined);
    setBranchMode("project-default");
    setBranch("");
    setBaseBranch("");
    setHasDirtyState(false);
    setGithubTrackingEnabled(false);
    setGithubRepoOverride("");
    onClose();
  }, [hasDirtyState, onClose, pendingImages, confirm, t]);

  const handleSubmit = useCallback(async () => {
    const trimmedDesc = description.trim();
    if (!trimmedDesc || isSubmitting || githubRepoOverrideInvalid || hasInvalidBranchSelection) return;

    setIsSubmitting(true);
    try {
      const executorSlashIdx = executorModel.indexOf("/");
      const validatorSlashIdx = validatorModel.indexOf("/");
      const planningSlashIdx = planningModel.indexOf("/");

      const createInput: TaskCreateInput & {
        branchSelection?: {
          mode: BranchSelectionMode;
          branchName?: string;
          baseBranch?: string;
        };
      } = {
        title: undefined,
        description: trimmedDesc,
        column: "triage",
        dependencies: dependencies.length ? dependencies : undefined,
        // U6/R3: forward the workflow selection only when the user changed it.
        //  - undefined → omit (store inherits the project default, today's behavior)
        //  - null      → explicit "No workflow" (store skips default materialization)
        //  - string    → that workflow, materialized atomically at create time.
        ...(selectedWorkflowId !== undefined ? { workflowId: selectedWorkflowId } : {}),
        ...(selectedAgentId ? { assignedAgentId: selectedAgentId } : {}),
        modelPresetId: presetMode === "preset" ? selectedPresetId || undefined : undefined,
        modelProvider: executorModel && executorSlashIdx !== -1 ? executorModel.slice(0, executorSlashIdx) : undefined,
        modelId: executorModel && executorSlashIdx !== -1 ? executorModel.slice(executorSlashIdx + 1) : undefined,
        validatorModelProvider: validatorModel && validatorSlashIdx !== -1 ? validatorModel.slice(0, validatorSlashIdx) : undefined,
        validatorModelId: validatorModel && validatorSlashIdx !== -1 ? validatorModel.slice(validatorSlashIdx + 1) : undefined,
        planningModelProvider: planningModel && planningSlashIdx !== -1 ? planningModel.slice(0, planningSlashIdx) : undefined,
        planningModelId: planningModel && planningSlashIdx !== -1 ? planningModel.slice(planningSlashIdx + 1) : undefined,
        thinkingLevel: thinkingLevel !== "" ? thinkingLevel as "minimal" | "low" | "medium" | "high" : undefined,
        reviewLevel,
        ...(autoMerge !== undefined ? { autoMerge } : {}),
        priority,
        nodeId,
        branchSelection: {
          mode: branchMode,
          ...(isBranchNameRequired && branch.trim() ? { branchName: branch.trim() } : {}),
          ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
        },
        ...(githubTrackingEnabled || githubRepoOverrideTrimmed !== ""
          ? {
              githubTracking: {
                enabled: githubTrackingEnabled,
                ...(githubRepoOverrideTrimmed !== "" ? { repoOverride: githubRepoOverrideTrimmed } : {}),
              },
            }
          : {}),
      };

      // U6/R3: the workflow is now materialized atomically inside createTask via
      // the `workflowId` parameter — no post-create selectTaskWorkflow call, so
      // the executor can never observe the task with the wrong step set.
      const task = await onCreateTask(createInput);

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
          addToast(t("newTaskModal.failedToUpload", "Failed to upload: {{files}}", { files: failures.join(", ") }), "error");
        }
      }

      // Clean up
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setPendingImages([]);
      setDescription("");
      setDependencies([]);
      setExecutorModel("");
      setValidatorModel("");
      setPlanningModel("");
      setThinkingLevel("");
      setSelectedPresetId("");
      setPresetMode("default");
      setSelectedWorkflowId(undefined);
      setSelectedAgentId(null);
      setShowAgentPicker(false);
      setReviewLevel(undefined);
      setAutoMerge(undefined);
      setPriority(DEFAULT_TASK_PRIORITY);
      setNodeId(undefined);
      setBranchMode("project-default");
      setBranch("");
      setBaseBranch("");

      addToast(t("newTaskModal.taskCreated", "Created {{taskId}}", { taskId: task.id }), "success");
      onClose();
    } catch (err) {
      addToast(getErrorMessage(err) || t("newTaskModal.failedToCreate", "Failed to create task"), "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [description, dependencies, pendingImages, executorModel, validatorModel, planningModel, thinkingLevel, isSubmitting, githubRepoOverrideInvalid, hasInvalidBranchSelection, onCreateTask, addToast, onClose, projectId, presetMode, selectedPresetId, selectedWorkflowId, selectedAgentId, reviewLevel, autoMerge, priority, nodeId, branchMode, isBranchNameRequired, branch, baseBranch, githubTrackingEnabled, githubRepoOverrideTrimmed, t]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    }
  }, [handleClose]);

  // Compute selected agent label for display
  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) : undefined;
  const selectedAgentLabel = selectedAgent?.name ?? selectedAgentId;

  // Quick fields: promoted dependencies and agent assignment
  const quickFields = (
    <div className="new-task-quick-fields">
      {/* Dependencies field */}
      <div className="form-group">
        <label>{t("newTaskModal.dependencies", "Dependencies")}</label>
        <div className="dep-trigger-wrap" ref={quickFieldsDepRef}>
          <button
            type="button"
            className="btn btn-sm dep-trigger"
            onClick={() => setShowDeps((v) => !v)}
            disabled={isSubmitting}
            data-testid="dep-trigger"
          >
            {dependencies.length > 0 ? t("newTaskModal.selectedCount", "{{count}} selected", { count: dependencies.length }) : t("newTaskModal.addDependencies", "Add dependencies")}
          </button>
          {showDeps && (
            <div className="dep-dropdown">
              <input
                className="dep-dropdown-search"
                placeholder={t("newTaskModal.searchTasks", "Search tasks…")}
                autoFocus
                value={depSearch}
                onChange={(e) => setDepSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              {filteredDeps.length === 0 ? (
                <div className="dep-dropdown-empty">{t("newTaskModal.noAvailableTasks", "No available tasks")}</div>
              ) : (
                filteredDeps.map((t) => (
                  <div
                    key={t.id}
                    className={`dep-dropdown-item${dependencies.includes(t.id) ? " selected" : ""}`}
                    onClick={() => {
                      setDependencies(
                        dependencies.includes(t.id) ? dependencies.filter((d) => d !== t.id) : [...dependencies, t.id],
                      );
                      setShowDeps(false);
                      setDepSearch("");
                    }}
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
                  onClick={() => setDependencies(dependencies.filter((d) => d !== depId))}
                  disabled={isSubmitting}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Agent Assignment */}
      <div className="form-group">
        <label>{t("newTaskModal.assignAgent", "Assign Agent")}</label>
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
            disabled={isSubmitting}
            data-testid="new-task-agent-button"
          >
            <Bot size={12} style={{ verticalAlign: "middle" }} />
            {selectedAgentLabel ? ` ${selectedAgentLabel}` : ` ${t("newTaskModal.assignAgentButton", "Assign agent")}`}
          </button>
          {showAgentPicker && (
            <div className="dep-dropdown agent-picker-dropdown" onMouseDown={(e) => e.preventDefault()}>
              <div className="dep-dropdown-search-header">{t("newTaskModal.selectAgent", "Select agent")}</div>
              {agentsLoading && <div className="dep-dropdown-empty">{t("newTaskModal.loadingAgents", "Loading agents...")}</div>}
              {!agentsLoading && agents.map((a) => (
                <div
                  key={a.id}
                  className={`dep-dropdown-item${selectedAgentId === a.id ? " selected" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSelectedAgentId(a.id === selectedAgentId ? null : a.id);
                    setShowAgentPicker(false);
                  }}
                  data-testid={`agent-option-${a.id}`}
                >
                  <Bot size={12} style={{ marginRight: 6 }} />
                  <span className="dep-dropdown-id">{a.role}</span>
                  <span className="dep-dropdown-title">{a.name}</span>
                </div>
              ))}
              {!agentsLoading && agents.length === 0 && (
                <div className="dep-dropdown-empty">{t("newTaskModal.noAgentsAvailable", "No agents available")}</div>
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
                  <span className="dep-dropdown-title">{t("newTaskModal.clearSelection", "Clear selection")}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* U6/R3: the workflow picker now lives inside TaskForm (a whole-workflow
          dropdown materialized atomically at create time), replacing the prior
          standalone WorkflowSelector + post-create selectTaskWorkflow flow. */}
    </div>
  );

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={handleClose} onKeyDown={handleKeyDown} role="dialog" aria-modal="true">
      <div
        className="modal modal-lg new-task-modal"
        onClick={(e) => e.stopPropagation()}
        style={keyboardStyle}
      >
        <div className="modal-header">
          <h3>{t("newTaskModal.title", "New Task")}</h3>
          <button className="modal-close" onClick={handleClose} disabled={isSubmitting} aria-label={t("actions.close", "Close")}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          {!setupReadinessLoading && (
            <SetupWarningBanner
              hasAiProvider={hasAiProvider}
              hasGithub={hasGithub}
            />
          )}

          <TaskForm
            mode="create"
            description={description}
            onDescriptionChange={setDescription}
            dependencies={dependencies}
            onDependenciesChange={setDependencies}
            executorModel={executorModel}
            onExecutorModelChange={setExecutorModel}
            validatorModel={validatorModel}
            onValidatorModelChange={setValidatorModel}
            presetMode={presetMode}
            onPresetModeChange={setPresetMode}
            selectedPresetId={selectedPresetId}
            onSelectedPresetIdChange={setSelectedPresetId}
            selectedWorkflowId={selectedWorkflowId}
            onWorkflowIdChange={setSelectedWorkflowId}
            pendingImages={pendingImages}
            onImagesChange={setPendingImages}
            tasks={tasks}
            projectId={projectId}
            disabled={isSubmitting}
            addToast={addToast}
            isActive={isOpen}
            onClose={handleClose}
            planningModel={planningModel}
            onPlanningModelChange={setPlanningModel}
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={setThinkingLevel}
            reviewLevel={reviewLevel}
            onReviewLevelChange={setReviewLevel}
            autoMerge={autoMerge}
            onAutoMergeChange={setAutoMerge}
            priority={priority}
            onPriorityChange={setPriority}
            branch={branch}
            onBranchChange={setBranch}
            branchMode={branchMode}
            onBranchModeChange={setBranchMode}
            baseBranch={baseBranch}
            onBaseBranchChange={setBaseBranch}
            nodeId={nodeId}
            onNodeIdChange={setNodeId}
            nodeOptions={nodes}
            githubTrackingEnabled={githubTrackingEnabled}
            onGithubTrackingEnabledChange={setGithubTrackingEnabled}
            githubRepoOverride={githubRepoOverride}
            onGithubRepoOverrideChange={setGithubRepoOverride}
            renderBelowPrimary={quickFields}
            hideDependencies={true}
            autoExpandMoreOptionsOnSelection={false}
          />

        </div>

        {hasInvalidBranchSelection && (
          <div className="form-error new-task-branch-error">{t("newTaskModal.branchRequired", "Branch name is required for this branch strategy.")}</div>
        )}

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={handleClose} disabled={isSubmitting}>
            {t("actions.cancel", "Cancel")}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!description.trim() || isSubmitting || githubRepoOverrideInvalid || hasInvalidBranchSelection}
          >
            {isSubmitting ? t("newTaskModal.creating", "Creating...") : t("newTaskModal.createTask", "Create Task")}
          </button>
        </div>
      </div>
    </div>
  );
}
