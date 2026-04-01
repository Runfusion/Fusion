<<<<<<< HEAD
import { useCallback } from "react";
import { X } from "lucide-react";
import { SetupWizard } from "./SetupWizard";
import type { ProjectInfo, ProjectCreateInput } from "../api";

export interface SetupWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (project: ProjectInfo) => void;
  onRegisterProject: (input: ProjectCreateInput) => Promise<ProjectInfo>;
}

/**
 * SetupWizardModal - Modal wrapper for the SetupWizard component
 * 
 * Provides a modal overlay for the setup wizard, suitable for:
 * - First-run experience when no projects exist
 * - "Add Project" button from ProjectOverview
 */
export function SetupWizardModal({
  isOpen,
  onClose,
  onComplete,
  onRegisterProject,
}: SetupWizardModalProps) {
  const handleProjectCreated = useCallback((project: ProjectInfo) => {
    onComplete(project);
  }, [onComplete]);
=======
import { useState, useEffect, useCallback } from "react";
import { X, Loader2, FolderPlus, Search, CheckCircle, ArrowRight, ArrowLeft } from "lucide-react";
import type { ProjectInfo, ProjectCreateInput } from "../api";
import { fetchFirstRunStatus, detectProjects, registerProject } from "../api";
import { ProjectDetectionResults, type SelectedProject } from "./ProjectDetectionResults";
import { scanForProjects } from "../utils/projectDetection";

export interface SetupWizardModalProps {
  /** Called when a single project is registered */
  onProjectRegistered: (project: ProjectInfo) => void;
  /** Called when multiple projects are registered (bulk detection) */
  onProjectsRegistered?: (projects: ProjectInfo[]) => void;
  /** Called when wizard is closed (completed or cancelled) */
  onClose?: () => void;
}

type WizardStep = "welcome" | "detecting" | "review" | "manual" | "complete";

interface WizardState {
  step: WizardStep;
  detectedProjects: SelectedProject[];
  isDetecting: boolean;
  detectError: string | null;
  manualPath: string;
  manualName: string;
  manualIsolationMode: "in-process" | "child-process";
  isRegistering: boolean;
  registeredCount: number;
}

const WIZARD_STATE_KEY = "kb-setup-wizard-state";

/**
 * Setup wizard for first-run project registration.
 * 
 * Provides a multi-step wizard for new users to:
 * 1. Welcome - Introduction to multi-project mode
 * 2. Auto-detect - Scan filesystem for existing kb projects
 * 3. Review - Select which detected projects to register
 * 4. Manual - Add projects manually by path
 * 5. Complete - Summary and get started
 * 
 * Features:
 * - Auto-opens when no projects exist (uses fetchFirstRunStatus)
 * - Persists state to localStorage for resume capability
 * - Bulk registration of selected detected projects
 * - Manual project registration as fallback
 * 
 * @example
 * ```tsx
 * <SetupWizardModal
 *   onProjectRegistered={(project) => console.log(`Registered ${project.name}`)}
 *   onProjectsRegistered={(projects) => console.log(`Registered ${projects.length} projects`)}
 *   onClose={() => setShowWizard(false)}
 * />
 * ```
 */
export function SetupWizardModal({
  onProjectRegistered,
  onProjectsRegistered,
  onClose,
}: SetupWizardModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<WizardState>({
    step: "welcome",
    detectedProjects: [],
    isDetecting: false,
    detectError: null,
    manualPath: "",
    manualName: "",
    manualIsolationMode: "in-process",
    isRegistering: false,
    registeredCount: 0,
  });

  // Check first-run status on mount
  useEffect(() => {
    const checkFirstRun = async () => {
      try {
        const status = await fetchFirstRunStatus();
        
        // Check for saved wizard state (resume capability)
        const savedState = localStorage.getItem(WIZARD_STATE_KEY);
        if (savedState) {
          try {
            const parsed = JSON.parse(savedState);
            if (parsed.inProgress) {
              setIsOpen(true);
              setState((prev) => ({
                ...prev,
                step: parsed.step || "welcome",
                detectedProjects: parsed.detectedProjects || [],
              }));
              return;
            }
          } catch {
            // Invalid saved state, ignore
          }
        }

        // Auto-open if no projects exist
        if (!status.hasProjects) {
          setIsOpen(true);
        }
      } catch {
        // Fail silently - don't auto-open on error
      }
    };

    // Small delay to allow app to fully mount
    const timer = setTimeout(checkFirstRun, 500);
    return () => clearTimeout(timer);
  }, []);

  // Persist wizard state for resume capability
  useEffect(() => {
    if (isOpen && state.step !== "complete") {
      localStorage.setItem(
        WIZARD_STATE_KEY,
        JSON.stringify({
          inProgress: true,
          step: state.step,
          detectedProjects: state.detectedProjects,
        })
      );
    } else if (!isOpen || state.step === "complete") {
      localStorage.removeItem(WIZARD_STATE_KEY);
    }
  }, [isOpen, state.step, state.detectedProjects]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    localStorage.removeItem(WIZARD_STATE_KEY);
    onClose?.();
  }, [onClose]);

  const startDetection = useCallback(async () => {
    setState((prev) => ({
      ...prev,
      step: "detecting",
      isDetecting: true,
      detectError: null,
    }));

    const result = await scanForProjects();

    if (result.error) {
      setState((prev) => ({
        ...prev,
        isDetecting: false,
        detectError: result.error,
      }));
      return;
    }

    // Mark all non-existing projects as selected by default
    const selectedProjects: SelectedProject[] = result.projects.map((p) => ({
      ...p,
      selected: !p.existing,
    }));

    setState((prev) => ({
      ...prev,
      step: "review",
      isDetecting: false,
      detectedProjects: selectedProjects,
    }));
  }, []);

  const handleSelectionChange = useCallback((selected: SelectedProject[]) => {
    setState((prev) => ({
      ...prev,
      detectedProjects: prev.detectedProjects.map((p) => ({
        ...p,
        selected: selected.some((s) => s.path === p.path),
        customName: selected.find((s) => s.path === p.path)?.customName,
      })),
    }));
  }, []);

  const handleRegisterDetected = useCallback(async () => {
    const toRegister = state.detectedProjects.filter((p) => p.selected && !p.existing);
    
    if (toRegister.length === 0) {
      // No projects selected, skip to manual
      setState((prev) => ({ ...prev, step: "manual" }));
      return;
    }

    setState((prev) => ({ ...prev, isRegistering: true }));

    const registered: ProjectInfo[] = [];
    
    for (const project of toRegister) {
      try {
        const input: ProjectCreateInput = {
          name: project.customName || project.suggestedName,
          path: project.path,
          isolationMode: "in-process",
        };
        
        const result = await registerProject(input);
        registered.push(result);
        onProjectRegistered(result);
      } catch (err) {
        // Log error but continue with other projects
        console.error(`Failed to register project at ${project.path}:`, err);
      }
    }

    if (onProjectsRegistered && registered.length > 0) {
      onProjectsRegistered(registered);
    }

    setState((prev) => ({
      ...prev,
      step: "complete",
      isRegistering: false,
      registeredCount: registered.length,
    }));
  }, [state.detectedProjects, onProjectRegistered, onProjectsRegistered]);

  const handleManualRegister = useCallback(async () => {
    if (!state.manualPath || !state.manualName) return;

    setState((prev) => ({ ...prev, isRegistering: true }));

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
        registeredCount: 1,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isRegistering: false,
        detectError: err instanceof Error ? err.message : "Failed to register project",
      }));
    }
  }, [state.manualPath, state.manualName, state.manualIsolationMode, onProjectRegistered]);

  const goToManual = useCallback(() => {
    setState((prev) => ({ ...prev, step: "manual", detectError: null }));
  }, []);

  const goBack = useCallback(() => {
    setState((prev) => {
      switch (prev.step) {
        case "detecting":
          return { ...prev, step: "welcome" };
        case "review":
          return { ...prev, step: "welcome" };
        case "manual":
          return { ...prev, step: "review" };
        default:
          return prev;
      }
    });
  }, []);
>>>>>>> kb/kb-502

  if (!isOpen) return null;

  return (
<<<<<<< HEAD
    <div 
      className="modal-overlay open" 
      onClick={(e) => {
        // Close on overlay click, but not when clicking the modal itself
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      data-testid="setup-wizard-modal-overlay"
    >
      <div 
        className="modal modal-lg" 
        onClick={(e) => e.stopPropagation()}
        data-testid="setup-wizard-modal"
      >
        <div className="modal-header">
          <h3>Add New Project</h3>
          <button 
            className="modal-close" 
            onClick={onClose}
            aria-label="Close"
            data-testid="setup-wizard-modal-close"
          >
            <X size={20} />
          </button>
        </div>
        
        <div className="modal-content-no-padding">
          <SetupWizard
            isOpen={isOpen}
            onClose={onClose}
            onProjectCreated={handleProjectCreated}
            onRegisterProject={onRegisterProject}
          />
=======
    <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="modal setup-wizard-modal">
        {/* Header */}
        <div className="setup-wizard-header">
          <h2 id="wizard-title" className="setup-wizard-title">
            {state.step === "welcome" && "Welcome to kb"}
            {state.step === "detecting" && "Detecting Projects..."}
            {state.step === "review" && "Review Detected Projects"}
            {state.step === "manual" && "Add Project Manually"}
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
          {/* Welcome Step */}
          {state.step === "welcome" && (
            <div className="setup-wizard-welcome">
              <div className="welcome-icon">
                <FolderPlus size={64} />
              </div>
              <p className="welcome-text">
                Let's set up your kb workspace. We can automatically detect existing projects
                on your system, or you can add them manually.
              </p>
              <div className="welcome-actions">
                <button className="btn-primary" onClick={startDetection}>
                  <Search size={18} />
                  <span>Auto-detect Projects</span>
                </button>
                <button className="btn-secondary" onClick={goToManual}>
                  <FolderPlus size={18} />
                  <span>Add Manually</span>
                </button>
              </div>
            </div>
          )}

          {/* Detecting Step */}
          {state.step === "detecting" && (
            <div className="setup-wizard-detecting">
              <Loader2 size={48} className="animate-spin" />
              <p>Scanning your home directory for kb projects...</p>
              <p className="detecting-hint">
                This may take a moment. Looking for <code>.fusion/kb.db</code> files.
              </p>
            </div>
          )}

          {/* Review Step */}
          {state.step === "review" && (
            <div className="setup-wizard-review">
              <ProjectDetectionResults
                projects={state.detectedProjects}
                onSelectionChange={handleSelectionChange}
                isDetecting={false}
              />
              {state.detectError && (
                <div className="error-message">{state.detectError}</div>
              )}
            </div>
          )}

          {/* Manual Step */}
          {state.step === "manual" && (
            <div className="setup-wizard-manual">
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
                  Absolute path to your project directory (must contain .fusion/kb.db)
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

              {state.detectError && (
                <div className="error-message">{state.detectError}</div>
              )}
            </div>
          )}

          {/* Complete Step */}
          {state.step === "complete" && (
            <div className="setup-wizard-complete">
              <CheckCircle size={64} className="success-icon" />
              <h3>All Set!</h3>
              <p>
                {state.registeredCount} project{state.registeredCount !== 1 ? "s" : ""}{" "}
                registered successfully.
              </p>
              <p>You can add more projects anytime from the project overview.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="setup-wizard-footer">
          {state.step !== "welcome" && state.step !== "complete" && (
            <button
              className="btn-secondary"
              onClick={goBack}
              disabled={state.isRegistering}
            >
              <ArrowLeft size={16} />
              <span>Back</span>
            </button>
          )}

          <div className="footer-spacer" />

          {state.step === "review" && (
            <>
              <button
                className="btn-secondary"
                onClick={goToManual}
                disabled={state.isRegistering}
              >
                Skip to Manual
              </button>
              <button
                className="btn-primary"
                onClick={handleRegisterDetected}
                disabled={
                  state.isRegistering ||
                  !state.detectedProjects.some((p) => p.selected && !p.existing)
                }
              >
                {state.isRegistering ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Registering...</span>
                  </>
                ) : (
                  <>
                    <span>Register Selected</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </>
          )}

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
                  <ArrowRight size={16} />
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
>>>>>>> kb/kb-502
        </div>
      </div>
    </div>
  );
}
