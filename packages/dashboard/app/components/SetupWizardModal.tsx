import { useState, useCallback } from "react";
import { X, Loader2, Sparkles, CheckCircle, ChevronRight } from "lucide-react";
import type { ProjectInfo, ProjectCreateInput } from "../api";
import { registerProject } from "../api";
import { DirectoryPicker } from "./DirectoryPicker";
import { suggestProjectName } from "../utils/projectDetection";
import { useNodes } from "../hooks/useNodes";

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
  manualNodeId: string;
  isRegistering: boolean;
  error: string | null;
}

/**
 * Setup wizard for first-run project registration.
 *
 * Provides a polished onboarding experience with a directory picker
 * for selecting the project directory and auto-name suggestion.
 */
export function SetupWizardModal({
  onProjectRegistered,
  onClose,
}: SetupWizardModalProps) {
  const helpUrl = "https://github.com/runfusion/fusion/discussions";
  const [isOpen, setIsOpen] = useState(true);
  const [state, setState] = useState<WizardState>({
    step: "manual",
    manualPath: "",
    manualName: "",
    manualIsolationMode: "in-process",
    manualNodeId: "",
    isRegistering: false,
    error: null,
  });
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  const { nodes, loading: nodesLoading } = useNodes();
  const localNodeId = nodes.find((n) => n.type === "local")?.id;

  const handleClose = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [onClose]);

  const handlePathChange = useCallback((path: string) => {
    setState((prev) => {
      const updates: Partial<WizardState> = { manualPath: path };
      // Auto-suggest name when path changes and name is empty or was previously auto-suggested
      if (path && (!prev.manualName || prev.manualName === suggestProjectName(prev.manualPath))) {
        updates.manualName = suggestProjectName(path);
      }
      return { ...prev, ...updates };
    });
  }, []);

  const handleManualRegister = useCallback(async () => {
    if (!state.manualPath || !state.manualName) return;

    setState((prev) => ({ ...prev, isRegistering: true, error: null }));

    try {
      const input: ProjectCreateInput = {
        name: state.manualName,
        path: state.manualPath,
        isolationMode: state.manualIsolationMode,
        nodeId: state.manualNodeId || undefined,
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
  }, [state.manualPath, state.manualName, state.manualIsolationMode, state.manualNodeId, onProjectRegistered]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open setup-wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="modal setup-wizard-modal">
        {/* Header */}
        <div className="setup-wizard-header">
          <div className="setup-wizard-heading">
            <div className="setup-wizard-brand" aria-label="Fusion">
              <svg
                className="setup-wizard-brand-logo"
                width={28}
                height={28}
                viewBox="0 0 128 128"
                fill="none"
                aria-label="Fusion logo"
                role="img"
              >
                <circle
                  cx="64"
                  cy="64"
                  r="52"
                  stroke="currentColor"
                  strokeWidth="8"
                />
                <path
                  d="M26 101C44 82 62 64 82 45C90 37 98 30 104 24C96 35 89 47 81 60C70 79 57 95 43 108C38 112 32 108 26 101Z"
                  fill="currentColor"
                />
              </svg>
              <span className="setup-wizard-brand-name">Fusion</span>
            </div>
            <h2 id="wizard-title" className="setup-wizard-title">
              {state.step === "manual" && "Welcome to Fusion"}
              {state.step === "complete" && "Setup Complete!"}
            </h2>
          </div>
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
              <div className="welcome-icon">
                <Sparkles size={32} />
              </div>
              <p className="welcome-text">
                Let&apos;s set up your first project. Browse to your project directory or type the path manually.
              </p>

              <div className="form-group">
                <label htmlFor="project-path">Project Directory</label>
                <DirectoryPicker
                  value={state.manualPath}
                  onChange={handlePathChange}
                  nodeId={state.manualNodeId || undefined}
                  localNodeId={localNodeId}
                  placeholder="/path/to/your/project"
                />
                <p className="form-hint">
                  Select or type the absolute path to your project
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

              <div className="setup-wizard-advanced">
                <button
                  type="button"
                  className="setup-wizard-advanced-toggle"
                  aria-expanded={showAdvancedSettings}
                  onClick={() => setShowAdvancedSettings((prev) => !prev)}
                >
                  <ChevronRight size={16} className="setup-wizard-advanced-chevron" />
                  <span>Advanced settings</span>
                </button>
                {showAdvancedSettings && (
                  <div className="setup-wizard-advanced-panel">
                    <div className="form-group">
                      <div className="project-node-selector">
                        <span className="project-node-selector__label">Runtime Node</span>
                        <select
                          value={state.manualNodeId}
                          onChange={(e) => setState((prev) => ({ ...prev, manualNodeId: e.target.value }))}
                          disabled={nodesLoading || state.isRegistering}
                        >
                          <option value="">Local node</option>
                          {nodes.map((node) => (
                            <option key={node.id} value={node.id}>
                              {node.name} ({node.type})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Isolation Mode</label>
                      <div className="setup-wizard-isolation-options">
                        <label
                          className={`setup-wizard-isolation-option${state.manualIsolationMode === "in-process" ? " selected" : ""}`}
                        >
                          <input
                            type="radio"
                            name="isolation-mode"
                            value="in-process"
                            checked={state.manualIsolationMode === "in-process"}
                            onChange={() =>
                              setState((prev) => ({ ...prev, manualIsolationMode: "in-process" }))
                            }
                          />
                          <div className="setup-wizard-isolation-option-content">
                            <strong>In-Process</strong>
                            <span>Lower overhead, shared memory. Best for most projects.</span>
                            <span className="wizard-option-recommended">Recommended</span>
                          </div>
                        </label>
                        <label
                          className={`setup-wizard-isolation-option${state.manualIsolationMode === "child-process" ? " selected" : ""}`}
                        >
                          <input
                            type="radio"
                            name="isolation-mode"
                            value="child-process"
                            checked={state.manualIsolationMode === "child-process"}
                            onChange={() =>
                              setState((prev) => ({ ...prev, manualIsolationMode: "child-process" }))
                            }
                          />
                          <div className="setup-wizard-isolation-option-content">
                            <strong>Child-Process</strong>
                            <span>Isolated execution with crash containment.</span>
                          </div>
                        </label>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {state.error && (
                <div className="wizard-error" role="alert">
                  {state.error}
                </div>
              )}
            </div>
          )}

          {/* Complete Step */}
          {state.step === "complete" && (
            <div className="setup-wizard-complete">
              <div className="setup-wizard-success-streak" aria-hidden="true">
                <div className="setup-wizard-success-streak-core" />
                <div className="setup-wizard-success-streak-glow" />
              </div>
              <CheckCircle size={64} className="success-icon" />
              <h3>All Set!</h3>
              <p>Your project has been registered successfully.</p>
              <p>You can add more projects anytime from the project overview.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="setup-wizard-footer">
          <a
            className="btn setup-wizard-help-link"
            href={helpUrl}
            target="_blank"
            rel="noreferrer"
          >
            Need help?
          </a>
          {state.step === "manual" && (
            <button
              className="btn btn-primary"
              onClick={handleManualRegister}
              disabled={state.isRegistering || !state.manualPath || !state.manualName}
            >
              {state.isRegistering ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>Registering...</span>
                </>
              ) : (
                <span>Register Project</span>
              )}
            </button>
          )}

          {state.step === "complete" && (
            <button className="btn btn-primary" onClick={handleClose}>
              <CheckCircle size={16} />
              <span>Get Started</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
