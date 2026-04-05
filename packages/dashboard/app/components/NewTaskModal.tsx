import { useState, useCallback, useEffect } from "react";
import type { Task, TaskCreateInput } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { uploadAttachment } from "../api";
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
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [presetMode, setPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [hasDirtyState, setHasDirtyState] = useState(false);
  const [selectedWorkflowSteps, setSelectedWorkflowSteps] = useState<string[]>([]);
  const [workflowStepsExplicitlySet, setWorkflowStepsExplicitlySet] = useState(false);

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

  // Track dirty state
  useEffect(() => {
    const isDirty = 
      description.trim() !== "" ||
      dependencies.length > 0 ||
      pendingImages.length > 0 ||
      executorModel !== "" ||
      validatorModel !== "" ||
      selectedWorkflowSteps.length > 0;
    setHasDirtyState(isDirty);
  }, [description, dependencies, pendingImages, executorModel, validatorModel, selectedWorkflowSteps]);

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
    setSelectedPresetId("");
    setPresetMode("default");
    setSelectedWorkflowSteps([]);
    setWorkflowStepsExplicitlySet(false);
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

      const task = await onCreateTask({
        title: undefined,
        description: trimmedDesc,
        column: "triage",
        dependencies: dependencies.length ? dependencies : undefined,
        // When user explicitly cleared all workflow steps, send empty array to prevent backend re-applying defaults.
        // When user hasn't interacted with workflow steps (or left auto-selected defaults), send undefined to let backend apply defaults.
        enabledWorkflowSteps: workflowStepsExplicitlySet ? (selectedWorkflowSteps.length > 0 ? selectedWorkflowSteps : []) : undefined,
        modelPresetId: presetMode === "preset" ? selectedPresetId || undefined : undefined,
        modelProvider: executorModel && executorSlashIdx !== -1 ? executorModel.slice(0, executorSlashIdx) : undefined,
        modelId: executorModel && executorSlashIdx !== -1 ? executorModel.slice(executorSlashIdx + 1) : undefined,
        validatorModelProvider: validatorModel && validatorSlashIdx !== -1 ? validatorModel.slice(0, validatorSlashIdx) : undefined,
        validatorModelId: validatorModel && validatorSlashIdx !== -1 ? validatorModel.slice(validatorSlashIdx + 1) : undefined,
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
      setSelectedPresetId("");
      setPresetMode("default");
      setSelectedWorkflowSteps([]);
      setWorkflowStepsExplicitlySet(false);

      addToast(`Created ${task.id}`, "success");
      onClose();
    } catch (err: any) {
      addToast(err.message || "Failed to create task", "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [description, dependencies, pendingImages, executorModel, validatorModel, isSubmitting, onCreateTask, addToast, onClose, projectId, presetMode, selectedPresetId, selectedWorkflowSteps, workflowStepsExplicitlySet]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    }
  }, [handleClose]);

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
