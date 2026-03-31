import { useState, useCallback } from "react";
import { Plus, Trash2, ChevronUp, ChevronDown, Pencil, GripVertical } from "lucide-react";
import type { AutomationStep, AutomationStepType } from "@kb/core";
import { StepTypeBadge } from "./StepTypeBadge";

interface ScheduleStepsEditorProps {
  steps: AutomationStep[];
  onChange: (steps: AutomationStep[]) => void;
}

function generateStepId(): string {
  return crypto.randomUUID();
}

function createEmptyStep(type: AutomationStepType): AutomationStep {
  return {
    id: generateStepId(),
    type,
    name: type === "command" ? "New Command Step" : "New AI Prompt Step",
    command: type === "command" ? "" : undefined,
    prompt: type === "ai-prompt" ? "" : undefined,
    continueOnFailure: false,
  };
}

interface StepEditorProps {
  step: AutomationStep;
  onSave: (step: AutomationStep) => void;
  onCancel: () => void;
}

function StepEditor({ step, onSave, onCancel }: StepEditorProps) {
  const [name, setName] = useState(step.name);
  const [type, setType] = useState<AutomationStepType>(step.type);
  const [command, setCommand] = useState(step.command ?? "");
  const [prompt, setPrompt] = useState(step.prompt ?? "");
  const [modelProvider, setModelProvider] = useState(step.modelProvider ?? "");
  const [modelId, setModelId] = useState(step.modelId ?? "");
  const [timeoutMs, setTimeoutMs] = useState<number | undefined>(step.timeoutMs);
  const [continueOnFailure, setContinueOnFailure] = useState(step.continueOnFailure ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = useCallback((): boolean => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Step name is required";
    if (type === "command" && !command.trim()) e.command = "Command is required";
    if (type === "ai-prompt" && !prompt.trim()) e.prompt = "Prompt is required";
    if (timeoutMs !== undefined && timeoutMs < 1000) {
      e.timeoutMs = "Timeout must be at least 1 second (1000ms)";
    }
    if ((modelProvider && !modelId) || (!modelProvider && modelId)) {
      e.model = "Both model provider and model ID must be set, or both empty";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }, [name, type, command, prompt, timeoutMs, modelProvider, modelId]);

  const handleSave = useCallback(() => {
    if (!validate()) return;
    onSave({
      ...step,
      name: name.trim(),
      type,
      command: type === "command" ? command.trim() : undefined,
      prompt: type === "ai-prompt" ? prompt.trim() : undefined,
      modelProvider: type === "ai-prompt" && modelProvider ? modelProvider.trim() : undefined,
      modelId: type === "ai-prompt" && modelId ? modelId.trim() : undefined,
      timeoutMs: timeoutMs || undefined,
      continueOnFailure,
    });
  }, [validate, onSave, step, name, type, command, prompt, modelProvider, modelId, timeoutMs, continueOnFailure]);

  return (
    <div className="step-editor">
      <div className="form-group">
        <label htmlFor={`step-name-${step.id}`}>Step Name</label>
        <input
          id={`step-name-${step.id}`}
          type="text"
          placeholder="e.g. Run tests"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!errors.name}
        />
        {errors.name && <small className="field-error">{errors.name}</small>}
      </div>

      <div className="form-group">
        <label htmlFor={`step-type-${step.id}`}>Step Type</label>
        <select
          id={`step-type-${step.id}`}
          value={type}
          onChange={(e) => setType(e.target.value as AutomationStepType)}
        >
          <option value="command">Command</option>
          <option value="ai-prompt">AI Prompt</option>
        </select>
      </div>

      {type === "command" && (
        <div className="form-group">
          <label htmlFor={`step-command-${step.id}`}>Command</label>
          <textarea
            id={`step-command-${step.id}`}
            placeholder="e.g. npm test"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={2}
            aria-invalid={!!errors.command}
          />
          {errors.command && <small className="field-error">{errors.command}</small>}
        </div>
      )}

      {type === "ai-prompt" && (
        <>
          <div className="form-group">
            <label htmlFor={`step-prompt-${step.id}`}>Prompt</label>
            <textarea
              id={`step-prompt-${step.id}`}
              placeholder="e.g. Summarize the test results and highlight any failures"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              aria-invalid={!!errors.prompt}
            />
            {errors.prompt && <small className="field-error">{errors.prompt}</small>}
          </div>

          <div className="form-group form-group-row">
            <div className="form-group">
              <label htmlFor={`step-provider-${step.id}`}>Model Provider (optional)</label>
              <input
                id={`step-provider-${step.id}`}
                type="text"
                placeholder="e.g. anthropic"
                value={modelProvider}
                onChange={(e) => setModelProvider(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor={`step-model-${step.id}`}>Model ID (optional)</label>
              <input
                id={`step-model-${step.id}`}
                type="text"
                placeholder="e.g. claude-sonnet-4-5"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              />
            </div>
          </div>
          {errors.model && <small className="field-error">{errors.model}</small>}
        </>
      )}

      <div className="form-group">
        <label htmlFor={`step-timeout-${step.id}`}>Timeout (ms, optional)</label>
        <input
          id={`step-timeout-${step.id}`}
          type="number"
          min={1000}
          step={1000}
          placeholder="Override schedule timeout"
          value={timeoutMs ?? ""}
          onChange={(e) => setTimeoutMs(e.target.value ? Number(e.target.value) : undefined)}
          aria-invalid={!!errors.timeoutMs}
        />
        {errors.timeoutMs && <small className="field-error">{errors.timeoutMs}</small>}
      </div>

      <div className="form-group">
        <label htmlFor={`step-continue-${step.id}`} className="checkbox-label">
          <input
            id={`step-continue-${step.id}`}
            type="checkbox"
            checked={continueOnFailure}
            onChange={(e) => setContinueOnFailure(e.target.checked)}
          />
          Continue on failure
        </label>
        <small>If checked, the next step will run even if this one fails</small>
      </div>

      <div className="step-editor-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSave}>
          Save Step
        </button>
      </div>
    </div>
  );
}

export function ScheduleStepsEditor({ steps, onChange }: ScheduleStepsEditorProps) {
  const [editingStepId, setEditingStepId] = useState<string | null>(null);

  const handleAddStep = useCallback((type: AutomationStepType) => {
    const newStep = createEmptyStep(type);
    onChange([...steps, newStep]);
    setEditingStepId(newStep.id);
  }, [steps, onChange]);

  const handleDeleteStep = useCallback((stepId: string) => {
    onChange(steps.filter((s) => s.id !== stepId));
    if (editingStepId === stepId) setEditingStepId(null);
  }, [steps, onChange, editingStepId]);

  const handleMoveStep = useCallback((stepId: string, direction: "up" | "down") => {
    const index = steps.findIndex((s) => s.id === stepId);
    if (index < 0) return;
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= steps.length) return;
    const newSteps = [...steps];
    [newSteps[index], newSteps[newIndex]] = [newSteps[newIndex], newSteps[index]];
    onChange(newSteps);
  }, [steps, onChange]);

  const handleSaveStep = useCallback((updatedStep: AutomationStep) => {
    onChange(steps.map((s) => (s.id === updatedStep.id ? updatedStep : s)));
    setEditingStepId(null);
  }, [steps, onChange]);

  return (
    <div className="steps-editor">
      <div className="steps-editor-header">
        <span className="steps-editor-title">Steps ({steps.length})</span>
      </div>

      {steps.length === 0 && (
        <div className="steps-empty-state">
          <p>No steps added yet. Add a command or AI prompt step to get started.</p>
        </div>
      )}

      <div className="steps-list">
        {steps.map((step, index) => (
          <div key={step.id} className="step-card">
            {editingStepId === step.id ? (
              <StepEditor
                step={step}
                onSave={handleSaveStep}
                onCancel={() => setEditingStepId(null)}
              />
            ) : (
              <div className="step-card-row">
                <div className="step-card-drag">
                  <GripVertical size={14} />
                </div>
                <span className="step-card-index">{index + 1}</span>
                <StepTypeBadge type={step.type} />
                <span className="step-card-name">{step.name}</span>
                {step.continueOnFailure && (
                  <span className="step-card-flag" title="Continues on failure">⚡</span>
                )}
                <div className="step-card-actions">
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => handleMoveStep(step.id, "up")}
                    disabled={index === 0}
                    title="Move up"
                    aria-label={`Move ${step.name} up`}
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => handleMoveStep(step.id, "down")}
                    disabled={index === steps.length - 1}
                    title="Move down"
                    aria-label={`Move ${step.name} down`}
                  >
                    <ChevronDown size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => setEditingStepId(step.id)}
                    title="Edit"
                    aria-label={`Edit ${step.name}`}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => handleDeleteStep(step.id)}
                    title="Delete"
                    aria-label={`Delete ${step.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="steps-add-buttons">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => handleAddStep("command")}
        >
          <Plus size={14} />
          Add Command Step
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => handleAddStep("ai-prompt")}
        >
          <Plus size={14} />
          Add AI Prompt Step
        </button>
      </div>
    </div>
  );
}
