import "./NewTaskModal.css";
import { useState, useCallback, useEffect, useRef } from "react";
import { DEFAULT_TASK_PRIORITY, type Task, type TaskCreateInput, type TaskPriority } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { uploadAttachment, fetchAgents } from "../api";
import type { Agent } from "../api";
import { Bot } from "lucide-react";
import { useSetupReadiness } from "../hooks/useSetupReadiness";
import { SetupWarningBanner } from "./SetupWarningBanner";
import { TaskForm, type PendingImage } from "./TaskForm";
import { useConfirm } from "../hooks/useConfirm";
import { useNodes } from "../hooks/useNodes";

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  tasks: Task[]; // for dependency selection
  onCreateTask: (input: TaskCreateInput) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
  onPlanningMode?: (initialPlan: string) => void;
  onSubtaskBreakdown?: (description: string) => void;
}

export function NewTaskModal({ isOpen, onClose, projectId, tasks, onCreateTask, addToast, onPlanningMode, onSubtaskBreakdown }: NewTaskModalProps) {
  const { confirm } = useConfirm();
  const [description, setDescription] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [executorModel, setExecutorModel] = useState("");
  const [validatorModel, setValidatorModel] = useState("");
  const [planningModel, setPlanningModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<string>("");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [presetMode, setPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [hasDirtyState, setHasDirtyState] = useState(false);
  const [selectedWorkflowSteps, setSelectedWorkflowSteps] = useState<string[]>([]);
  const [workflowStepsExplicitlySet, setWorkflowStepsExplicitlySet] = useState(false);
  const [reviewLevel, setReviewLevel] = useState<number | undefined>(undefined);
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [nodeId, setNodeId] = useState<string | undefined>(undefined);

  // Agent assignment state
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  // Quick-fields dependency picker state
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const quickFieldsDepRef = useRef<HTMLDivElement>(null);

  const { hasAiProvider, hasGithub, loading: setupReadinessLoading } = useSetupReadiness(projectId);
  const { nodes } = useNodes();

  // Handler for workflow step changes that detects explicit user interaction
  const handleWorkflowStepsChange = useCallback((steps: string[]) => {
    setWorkflowStepsExplicitlySet(true);
    setSelectedWorkflowSteps(steps);
  }, []);

  // Callback when defaultOn steps are auto-applied by TaskForm
  const handleDefaultOnApplied = useCallback(() => {
    // defaultOn auto-selection is not "explicit" user interaction
    setWorkflowStepsExplicitlySet(false);
  }, []);

  // Load agents for agent picker
  const loadAgents = useCallback(async () => {
    if (agents.length > 0) {
      setShowAgentPicker(true);
      return;
    }

    setAgentsLoading(true);
    try {
      const result = await fetchAgents(undefined, projectId);
      setAgents(result);
      setShowAgentPicker(true);
    } catch (err) {
      const msg = getErrorMessage(err);
      addToast(msg ? `Failed to load agents: ${msg}` : "Failed to load agents", "error");
      setShowAgentPicker(false);
    } finally {
      setAgentsLoading(false);
    }
  }, [agents.length, projectId, addToast]);

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

  // Track dirty state
  useEffect(() => {
    const isDirty =
      description.trim() !== "" ||
      dependencies.length > 0 ||
      pendingImages.length > 0 ||
      executorModel !== "" ||
      validatorModel !== "" ||
      planningModel !== "" ||
      thinkingLevel !== "" ||
      selectedWorkflowSteps.length > 0 ||
      selectedAgentId !== null ||
      reviewLevel !== undefined ||
      priority !== DEFAULT_TASK_PRIORITY ||
      nodeId !== undefined;
    setHasDirtyState(isDirty);
  }, [description, dependencies, pendingImages, executorModel, validatorModel, planningModel, thinkingLevel, selectedWorkflowSteps, selectedAgentId, reviewLevel, priority, nodeId]);

  const handleClose = useCallback(async () => {
    if (hasDirtyState) {
      const shouldDiscard = await confirm({
        title: "Discard Changes",
        message: "You have unsaved changes. Discard them?",
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
    setSelectedWorkflowSteps([]);
    setWorkflowStepsExplicitlySet(false);
    setSelectedAgentId(null);
    setShowAgentPicker(false);
    setReviewLevel(undefined);
    setPriority(DEFAULT_TASK_PRIORITY);
    setNodeId(undefined);
    setHasDirtyState(false);
    onClose();
  }, [hasDirtyState, onClose, pendingImages, confirm]);

  const handleSubmit = useCallback(async () => {
    const trimmedDesc = description.trim();
    if (!trimmedDesc || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const executorSlashIdx = executorModel.indexOf("/");
      const validatorSlashIdx = validatorModel.indexOf("/");
      const planningSlashIdx = planningModel.indexOf("/");

      const task = await onCreateTask({
        title: undefined,
        description: trimmedDesc,
        column: "triage",
        dependencies: dependencies.length ? dependencies : undefined,
        // When user explicitly cleared all workflow steps, send empty array to prevent backend re-applying defaults.
        // When user hasn't interacted with workflow steps (or left auto-selected defaults), send undefined to let backend apply defaults.
        enabledWorkflowSteps: workflowStepsExplicitlySet ? (selectedWorkflowSteps.length > 0 ? selectedWorkflowSteps : []) : undefined,
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
        priority,
        nodeId,
      });

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
      setSelectedWorkflowSteps([]);
      setWorkflowStepsExplicitlySet(false);
      setSelectedAgentId(null);
      setShowAgentPicker(false);
      setReviewLevel(undefined);
      setPriority(DEFAULT_TASK_PRIORITY);
      setNodeId(undefined);

      addToast(`Created ${task.id}`, "success");
      onClose();
    } catch (err) {
      addToast(getErrorMessage(err) || "Failed to create task", "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [description, dependencies, pendingImages, executorModel, validatorModel, planningModel, thinkingLevel, isSubmitting, onCreateTask, addToast, onClose, projectId, presetMode, selectedPresetId, selectedWorkflowSteps, workflowStepsExplicitlySet, selectedAgentId, reviewLevel, priority, nodeId]);

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
        <label>Dependencies</label>
        <div className="dep-trigger-wrap" ref={quickFieldsDepRef}>
          <button
            type="button"
            className="btn btn-sm dep-trigger"
            onClick={() => setShowDeps((v) => !v)}
            disabled={isSubmitting}
            data-testid="dep-trigger"
          >
            {dependencies.length > 0 ? `${dependencies.length} selected` : "Add dependencies"}
          </button>
          {showDeps && (
            <div className="dep-dropdown">
              <input
                className="dep-dropdown-search"
                placeholder="Search tasks…"
                autoFocus
                value={depSearch}
                onChange={(e) => setDepSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              {filteredDeps.length === 0 ? (
                <div className="dep-dropdown-empty">No available tasks</div>
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
        <label>Assign Agent</label>
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
            {selectedAgentLabel ? ` ${selectedAgentLabel}` : " Assign agent"}
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
                  data-testid={`agent-option-${a.id}`}
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
      </div>
    </div>
  );

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={handleClose} onKeyDown={handleKeyDown} role="dialog" aria-modal="true">
      <div
        className="modal modal-lg new-task-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>New Task</h3>
          <button className="modal-close" onClick={handleClose} disabled={isSubmitting} aria-label="Close">
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
            selectedWorkflowSteps={selectedWorkflowSteps}
            onWorkflowStepsChange={handleWorkflowStepsChange}
            onDefaultOnApplied={handleDefaultOnApplied}
            pendingImages={pendingImages}
            onImagesChange={setPendingImages}
            tasks={tasks}
            projectId={projectId}
            disabled={isSubmitting}
            addToast={addToast}
            isActive={isOpen}
            onPlanningMode={onPlanningMode}
            onSubtaskBreakdown={onSubtaskBreakdown}
            onClose={handleClose}
            planningModel={planningModel}
            onPlanningModelChange={setPlanningModel}
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={setThinkingLevel}
            reviewLevel={reviewLevel}
            onReviewLevelChange={setReviewLevel}
            priority={priority}
            onPriorityChange={setPriority}
            nodeId={nodeId}
            onNodeIdChange={setNodeId}
            nodeOptions={nodes}
            renderBelowPrimary={quickFields}
            hideDependencies={true}
            autoExpandMoreOptionsOnSelection={false}
          />

        </div>

        <div className="modal-actions">
          <button className="btn btn-sm" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!description.trim() || isSubmitting}
          >
            {isSubmitting ? "Creating..." : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}
