import { useState, useCallback, useEffect, useRef } from "react";
import type { Task, TaskCreateInput } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { uploadAttachment, fetchAgents } from "../api";
import type { Agent } from "../api";
import { Bot } from "lucide-react";
import { TaskForm, type PendingImage } from "./TaskForm";

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
  const [description, setDescription] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [executorModel, setExecutorModel] = useState("");
  const [validatorModel, setValidatorModel] = useState("");
  const [planningModel, setPlanningModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<string>("off");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [presetMode, setPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [hasDirtyState, setHasDirtyState] = useState(false);
  const [selectedWorkflowSteps, setSelectedWorkflowSteps] = useState<string[]>([]);
  const [workflowStepsExplicitlySet, setWorkflowStepsExplicitlySet] = useState(false);

  // Agent assignment state
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);

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
    } catch (err: any) {
      addToast(err?.message ? `Failed to load agents: ${err.message}` : "Failed to load agents", "error");
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

  // Track dirty state
  useEffect(() => {
    const isDirty =
      description.trim() !== "" ||
      dependencies.length > 0 ||
      pendingImages.length > 0 ||
      executorModel !== "" ||
      validatorModel !== "" ||
      planningModel !== "" ||
      thinkingLevel !== "off" ||
      selectedWorkflowSteps.length > 0 ||
      selectedAgentId !== null;
    setHasDirtyState(isDirty);
  }, [description, dependencies, pendingImages, executorModel, validatorModel, planningModel, thinkingLevel, selectedWorkflowSteps, selectedAgentId]);

  const handleClose = useCallback(() => {
    if (hasDirtyState) {
      if (!confirm("You have unsaved changes. Discard them?")) return;
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
    setThinkingLevel("off");
    setSelectedPresetId("");
    setPresetMode("default");
    setSelectedWorkflowSteps([]);
    setWorkflowStepsExplicitlySet(false);
    setSelectedAgentId(null);
    setShowAgentPicker(false);
    setHasDirtyState(false);
    onClose();
  }, [hasDirtyState, onClose, pendingImages]);

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
        thinkingLevel: thinkingLevel !== "off" ? thinkingLevel as "minimal" | "low" | "medium" | "high" : undefined,
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
      setThinkingLevel("off");
      setSelectedPresetId("");
      setPresetMode("default");
      setSelectedWorkflowSteps([]);
      setWorkflowStepsExplicitlySet(false);
      setSelectedAgentId(null);
      setShowAgentPicker(false);

      addToast(`Created ${task.id}`, "success");
      onClose();
    } catch (err: any) {
      addToast(err.message || "Failed to create task", "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [description, dependencies, pendingImages, executorModel, validatorModel, planningModel, thinkingLevel, isSubmitting, onCreateTask, addToast, onClose, projectId, presetMode, selectedPresetId, selectedWorkflowSteps, workflowStepsExplicitlySet, selectedAgentId]);

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

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={handleClose} onKeyDown={handleKeyDown}>
      <div 
        className="modal modal-lg new-task-modal" 
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>New Task</h3>
          <button className="modal-close" onClick={handleClose} disabled={isSubmitting}>
            &times;
          </button>
        </div>

        <div className="modal-body">
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
          />

          {/* Agent Assignment */}
          <div className="form-group" style={{ marginTop: "12px" }}>
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
