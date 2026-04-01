import { useState, useEffect, useCallback } from "react";
import { X, Loader2, FolderPlus, CheckCircle } from "lucide-react";
import type { ProjectInfo, ProjectCreateInput } from "../api";
import { registerProject } from "../api";

export interface SetupWizardModalProps {
  /** Called when a single project is registered */
  onProjectRegistered: (project: ProjectInfo) => void;
  /** Called when wizard is closed (completed or cancelled) */
  onClose?: () => void;
}

type WizardStep = "manual" | "complete";

interface WizardState {
  step: WizardStep;
  manualPath: string;
  manualName: string;
  manualIsolationMode: "in-process" | "child-process";
  isRegistering: boolean;
  error: string | null;
}

/**
 * Setup wizard for first-run project registration.
 * 
 * Provides a wizard for new users to add their first project manually.
 * 
 * @example
 * ```tsx
 * <SetupWizardModal
 *   onProjectRegistered={(project) => console.log(`Registered ${project.name}`)}
 *   onClose={() => setShowWizard(false)}
 * />
 * ```
 */
export function SetupWizardModal({
  onProjectRegistered,
  onClose,
}: SetupWizardModalProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [state, setState] = useState<WizardState>({
    step: "manual",
    manualPath: "",
    manualName: "",
    manualIsolationMode: "in-process",
    isRegistering: false,
    error: null,
  });

  const handleClose = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [onClose]);

  const handleManualRegister = useCallback(async () => {
    if (!state.manualPath || !state.manualName) return;

    setState((prev) => ({ ...prev, isRegistering: true, error: null }));

    try {
      const input: ProjectCreateInput = {
        name: state.manualName,
        path: state.manualPath,
        isolationMode: state.manualIsolationMode,
      };

      const result = await registerProject(input);
      onProjectRegistered(result);

      setState((prev) => ({
        ...prev,
        step: "complete",
        isRegistering: false,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isRegistering: false,
        error: err instanceof Error ? err.message : "Failed to register project",
      }));
    }
  }, [state.manualPath, state.manualName, state.manualIsolationMode, onProjectRegistered]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="modal setup-wizard-modal">
        {/* Header */}
        <div className="setup-wizard-header">
          <h2 id="wizard-title" className="setup-wizard-title">
            {state.step === "manual" && "Welcome to kb"}
            {state.step === "complete" && "Setup Complete!"}
          </h2>
          {state.step !== "complete" && (
            <button
              className="modal-close"
              onClick={handleClose}
              aria-label="Close wizard"
            >
              <X size={20} />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="setup-wizard-content">
          {/* Manual Step */}
          {state.step === "manual" && (
            <div className="setup-wizard-manual">
              <div className="welcome-icon" style={{ marginBottom: "1rem" }}>
                <FolderPlus size={48} />
              </div>
              <p className="welcome-text" style={{ marginBottom: "1.5rem" }}>
                Let's set up your first kb project. Enter the path to your project directory.
              </p>

              <div className="form-group">
                <label htmlFor="project-path">Project Path</label>
                <input
                  id="project-path"
                  type="text"
                  value={state.manualPath}
                  onChange={(e) =>
                    setState((prev) => ({ ...prev, manualPath: e.target.value }))
                  }
                  placeholder="/path/to/your/project"
                />
                <p className="form-hint">
                  Absolute path to your project directory
                </p>
              </div>

              <div className="form-group">
                <label htmlFor="project-name">Project Name</label>
                <input
                  id="project-name"
                  type="text"
                  value={state.manualName}
                  onChange={(e) =>
                    setState((prev) => ({ ...prev, manualName: e.target.value }))
                  }
                  placeholder="my-project"
                />
              </div>

              <div className="form-group">
                <label htmlFor="isolation-mode">Isolation Mode</label>
                <select
                  id="isolation-mode"
                  value={state.manualIsolationMode}
                  onChange={(e) =>
                    setState((prev) => ({
                      ...prev,
                      manualIsolationMode: e.target.value as "in-process" | "child-process",
                    }))
                  }
                >
                  <option value="in-process">In-Process (faster, default)</option>
                  <option value="child-process">Child-Process (isolated)</option>
                </select>
              </div>

              {state.error && (
                <div className="error-message" style={{ marginTop: "1rem" }}>
                  {state.error}
                </div>
              )}
            </div>
          )}

          {/* Complete Step */}
          {state.step === "complete" && (
            <div className="setup-wizard-complete">
              <CheckCircle size={64} className="success-icon" />
              <h3>All Set!</h3>
              <p>
                Your project has been registered successfully.
              </p>
              <p>You can add more projects anytime from the project overview.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="setup-wizard-footer">
          {state.step === "manual" && (
            <button
              className="btn-primary"
              onClick={handleManualRegister}
              disabled={state.isRegistering || !state.manualPath || !state.manualName}
            >
              {state.isRegistering ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>Registering...</span>
                </>
              ) : (
                <>
                  <span>Register Project</span>
                </>
              )}
            </button>
          )}

          {state.step === "complete" && (
            <button className="btn-primary" onClick={handleClose}>
              <CheckCircle size={16} />
              <span>Get Started</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
