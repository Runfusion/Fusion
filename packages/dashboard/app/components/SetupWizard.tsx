import { useState, useCallback, useEffect } from "react";
import { X, ChevronRight, ChevronLeft, Folder, Check, Loader2, AlertCircle } from "lucide-react";
import type { ProjectInfo, ProjectCreateInput } from "../api";

export interface SetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onProjectCreated: (project: ProjectInfo) => void;
  onRegisterProject?: (input: ProjectCreateInput) => Promise<ProjectInfo>;
}

type WizardStep = "directory" | "name" | "isolation" | "validation" | "summary";

interface WizardState {
  step: WizardStep;
  directory: string;
  name: string;
  isolationMode: "in-process" | "child-process";
  isValidating: boolean;
  validationError: string | null;
  hasFusionDir: boolean | null;
  isCreating: boolean;
  createError: string | null;
}

const STEP_ORDER: WizardStep[] = ["directory", "name", "isolation", "validation", "summary"];

function getStepIndex(step: WizardStep): number {
  return STEP_ORDER.indexOf(step);
}

function isLastStep(step: WizardStep): boolean {
  return getStepIndex(step) === STEP_ORDER.length - 1;
}

function isFirstStep(step: WizardStep): boolean {
  return getStepIndex(step) === 0;
}

export function SetupWizard({ isOpen, onClose, onProjectCreated, onRegisterProject }: SetupWizardProps) {
  const [state, setState] = useState<WizardState>({
    step: "directory",
    directory: "",
    name: "",
    isolationMode: "in-process",
    isValidating: false,
    validationError: null,
    hasFusionDir: null,
    isCreating: false,
    createError: null,
  });

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setState({
        step: "directory",
        directory: "",
        name: "",
        isolationMode: "in-process",
        isValidating: false,
        validationError: null,
        hasFusionDir: null,
        isCreating: false,
        createError: null,
      });
    }
  }, [isOpen]);

  // Auto-suggest name from directory
  useEffect(() => {
    if (state.directory && !state.name) {
      const basename = state.directory.split("/").pop() || state.directory.split("\\").pop() || "";
      setState((prev) => ({ ...prev, name: basename }));
    }
  }, [state.directory, state.name]);

  const handleNext = useCallback(() => {
    const currentIndex = getStepIndex(state.step);
    if (currentIndex < STEP_ORDER.length - 1) {
      setState((prev) => ({
        ...prev,
        step: STEP_ORDER[currentIndex + 1],
        validationError: null,
        createError: null,
      }));
    }
  }, [state.step]);

  const handleBack = useCallback(() => {
    const currentIndex = getStepIndex(state.step);
    if (currentIndex > 0) {
      setState((prev) => ({
        ...prev,
        step: STEP_ORDER[currentIndex - 1],
        validationError: null,
        createError: null,
      }));
    }
  }, [state.step]);

  const handleValidate = useCallback(async () => {
    setState((prev) => ({ ...prev, isValidating: true, validationError: null }));

    try {
      // Check if directory exists and has .fusion/ directory
      // In a real implementation, this would call an API endpoint
      // For now, we simulate the check
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      // Simulate validation - assume valid for now
      const hasFusionDir = true; // Would be determined by API call
      
      setState((prev) => ({
        ...prev,
        isValidating: false,
        hasFusionDir,
        step: "summary",
      }));
    } catch (err: any) {
      setState((prev) => ({
        ...prev,
        isValidating: false,
        validationError: err.message || "Validation failed",
      }));
    }
  }, []);

  const handleCreate = useCallback(async () => {
    if (!onRegisterProject) {
      setState((prev) => ({ ...prev, createError: "Project registration not available" }));
      return;
    }

    setState((prev) => ({ ...prev, isCreating: true, createError: null }));

    try {
      const input: ProjectCreateInput = {
        name: state.name,
        path: state.directory,
        isolationMode: state.isolationMode,
      };

      const project = await onRegisterProject(input);
      onProjectCreated(project);
      onClose();
    } catch (err: any) {
      setState((prev) => ({
        ...prev,
        isCreating: false,
        createError: err.message || "Failed to create project",
      }));
    }
  }, [onRegisterProject, state.name, state.directory, state.isolationMode, onProjectCreated, onClose]);

  const canProceed = () => {
    switch (state.step) {
      case "directory":
        return state.directory.trim().length > 0;
      case "name":
        return state.name.trim().length > 0;
      case "isolation":
        return true;
      case "validation":
        return !state.isValidating;
      case "summary":
        return !state.isCreating;
      default:
        return false;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Add New Project</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="wizard-progress">
          {STEP_ORDER.map((step, index) => (
            <div
              key={step}
              className={`wizard-progress-step ${
                index <= getStepIndex(state.step) ? "active" : ""
              } ${step === state.step ? "current" : ""}`}
            >
              <span className="wizard-progress-number">{index + 1}</span>
              <span className="wizard-progress-label">
                {step === "directory" && "Directory"}
                {step === "name" && "Name"}
                {step === "isolation" && "Mode"}
                {step === "validation" && "Validate"}
                {step === "summary" && "Confirm"}
              </span>
            </div>
          ))}
        </div>

        <div className="wizard-content">
          {/* Step 1: Directory Selection */}
          {state.step === "directory" && (
            <div className="wizard-step">
              <h4>Select Project Directory</h4>
              <p className="wizard-description">
                Enter the absolute path to your project directory. This should be the root folder
                containing your project files.
              </p>
              <div className="form-group">
                <label htmlFor="project-directory">
                  Directory Path <span className="required">*</span>
                </label>
                <div className="wizard-input-group">
                  <Folder size={16} className="wizard-input-icon" />
                  <input
                    id="project-directory"
                    type="text"
                    value={state.directory}
                    onChange={(e) =>
                      setState((prev) => ({ ...prev, directory: e.target.value }))
                    }
                    placeholder="/path/to/your/project"
                    autoFocus
                  />
                </div>
              </div>
              <div className="wizard-hint">
                <AlertCircle size={14} />
                <span>
                  The directory must contain a <code>.fusion/</code> folder. If it doesn't exist,
                  you can initialize it in the next step.
                </span>
              </div>
            </div>
          )}

          {/* Step 2: Project Name */}
          {state.step === "name" && (
            <div className="wizard-step">
              <h4>Project Name</h4>
              <p className="wizard-description">
                Give your project a display name. This will be shown in the dashboard.
              </p>
              <div className="form-group">
                <label htmlFor="project-name">
                  Name <span className="required">*</span>
                </label>
                <input
                  id="project-name"
                  type="text"
                  value={state.name}
                  onChange={(e) => setState((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="My Project"
                  autoFocus
                />
              </div>
              <div className="wizard-hint">
                <Check size={14} />
                <span>Suggested from directory name. You can change it if needed.</span>
              </div>
            </div>
          )}

          {/* Step 3: Isolation Mode */}
          {state.step === "isolation" && (
            <div className="wizard-step">
              <h4>Execution Mode</h4>
              <p className="wizard-description">
                Choose how tasks should be executed for this project.
              </p>
              <div className="wizard-options">
                <label
                  className={`wizard-option ${
                    state.isolationMode === "in-process" ? "selected" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="isolation-mode"
                    value="in-process"
                    checked={state.isolationMode === "in-process"}
                    onChange={() =>
                      setState((prev) => ({ ...prev, isolationMode: "in-process" }))
                    }
                  />
                  <div className="wizard-option-content">
                    <strong>In-Process (Default)</strong>
                    <span>Fast, low overhead. Tasks run in the main process.</span>
                    <span className="wizard-option-recommended">Recommended for most projects</span>
                  </div>
                </label>
                <label
                  className={`wizard-option ${
                    state.isolationMode === "child-process" ? "selected" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="isolation-mode"
                    value="child-process"
                    checked={state.isolationMode === "child-process"}
                    onChange={() =>
                      setState((prev) => ({ ...prev, isolationMode: "child-process" }))
                    }
                  />
                  <div className="wizard-option-content">
                    <strong>Child Process (Isolated)</strong>
                    <span>Strong isolation. Tasks run in separate processes.</span>
                    <span className="wizard-option-note">Higher overhead, crash containment</span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Step 4: Validation */}
          {state.step === "validation" && (
            <div className="wizard-step">
              <h4>Validation</h4>
              <p className="wizard-description">
                We're checking the project directory and preparing it for use.
              </p>
              {state.isValidating ? (
                <div className="wizard-loading">
                  <Loader2 size={32} className="animate-spin" />
                  <span>Validating project directory...</span>
                </div>
              ) : state.validationError ? (
                <div className="wizard-error">
                  <AlertCircle size={24} />
                  <span>{state.validationError}</span>
                </div>
              ) : (
                <div className="wizard-validation-success">
                  <Check size={32} />
                  <span>Project directory is valid!</span>
                </div>
              )}
            </div>
          )}

          {/* Step 5: Summary */}
          {state.step === "summary" && (
            <div className="wizard-step">
              <h4>Summary</h4>
              <p className="wizard-description">
                Review your project settings before creating.
              </p>
              <div className="wizard-summary">
                <div className="wizard-summary-row">
                  <span className="wizard-summary-label">Name:</span>
                  <span className="wizard-summary-value">{state.name}</span>
                </div>
                <div className="wizard-summary-row">
                  <span className="wizard-summary-label">Directory:</span>
                  <span className="wizard-summary-value" title={state.directory}>
                    {state.directory}
                  </span>
                </div>
                <div className="wizard-summary-row">
                  <span className="wizard-summary-label">Execution Mode:</span>
                  <span className="wizard-summary-value">
                    {state.isolationMode === "in-process" ? "In-Process" : "Child Process (Isolated)"}
                  </span>
                </div>
              </div>
              {state.createError && (
                <div className="wizard-error">
                  <AlertCircle size={20} />
                  <span>{state.createError}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <div className="modal-actions-left">
            {!isFirstStep(state.step) && (
              <button className="btn btn-secondary" onClick={handleBack} disabled={state.isCreating}>
                <ChevronLeft size={16} />
                Back
              </button>
            )}
          </div>
          <div className="modal-actions-right">
            <button className="btn btn-secondary" onClick={onClose} disabled={state.isCreating}>
              Cancel
            </button>
            {state.step === "validation" ? (
              <button
                className="btn btn-primary"
                onClick={handleValidate}
                disabled={state.isValidating || !!state.validationError}
              >
                {state.isValidating ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Validating...
                  </>
                ) : (
                  <>
                    Validate
                    <ChevronRight size={16} />
                  </>
                )}
              </button>
            ) : isLastStep(state.step) ? (
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={state.isCreating || !canProceed()}
              >
                {state.isCreating ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    Create Project
                    <Check size={16} />
                  </>
                )}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={handleNext}
                disabled={!canProceed()}
              >
                Next
                <ChevronRight size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
