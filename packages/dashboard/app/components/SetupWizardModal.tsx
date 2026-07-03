import "./SetupWizardModal.css";
import { lazy, Suspense, useState, useCallback, useMemo, useRef, useEffect, type KeyboardEvent } from "react";
import { X, Loader2, CheckCircle, ChevronRight, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentOnboardingSummary, ProjectInfo, ProjectCreateInput } from "../api";
import { createAgent, registerProject, detectWorkspace } from "../api";
import { DirectoryPicker } from "./DirectoryPicker";
import { suggestProjectName } from "../utils/projectDetection";

/*
FNXC:TaskPrefix 2026-06-24-19:00:
Derive a task prefix from a project name in the browser. Mirrors the logic in
@fusion/core's suggestTaskPrefix: strip non-alpha, uppercase, take 2-4 chars,
fall back to "FN". Duplicated because @fusion/core is server-only.
*/
function suggestTaskPrefixFromName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  if (cleaned.length >= 2 && cleaned.length <= 4) return cleaned;
  if (cleaned.length > 4) return cleaned.slice(0, 4);
  return "FN";
}
import { useNodes } from "../hooks/useNodes";
import { AgentAvatar } from "./AgentAvatar";
import { ErrorBoundary } from "./ErrorBoundary";
import { AGENT_PRESETS, getPresetById } from "./agent-presets";
import {
  buildAgentCreatePayload,
  mapOnboardingSummaryToAgentDraft,
  mapPresetToAgentDraft,
  type AgentDraftValues,
} from "./agent-presets/agentCreatePayload";

const ExperimentalAgentOnboardingModal = lazy(() =>
  import("./ExperimentalAgentOnboardingModal").then((m) => ({ default: m.ExperimentalAgentOnboardingModal })),
);

export interface SetupWizardModalProps {
  /** Called when first-run setup should enter the registered project. */
  onProjectRegistered: (project: ProjectInfo) => void;
  /** Called when wizard is closed (completed or cancelled) */
  onClose?: () => void;
  /** Enables the existing AI interview entry point for first-agent drafting. */
  agentOnboardingEnabled?: boolean;
  /** When false, register the project and return control to a parent onboarding flow. */
  includeAgentStep?: boolean;
}

type WizardStep = "manual" | "agent" | "complete";
type ManualSetupMode = "existing" | "init" | "clone";
type AgentOutcome = "created" | "skipped" | null;

interface WizardState {
  step: WizardStep;
  manualMode: ManualSetupMode;
  manualPath: string;
  manualCloneUrl: string;
  manualName: string;
  manualIsolationMode: "in-process" | "child-process";
  manualNodeId: string;
  manualTaskPrefix: string;
  detectedRepos: string[];
  workspaceMode: boolean;
  isDetectingWorkspace: boolean;
  registeredProject: ProjectInfo | null;
  selectedPresetId: string;
  agentDraft: AgentDraftValues;
  isCreatingAgent: boolean;
  isRegistering: boolean;
  error: string | null;
  agentError: string | null;
  agentOutcome: AgentOutcome;
}

/**
 * Setup wizard for project registration.
 *
 * Provides a focused project-details -> project-agent flow with a directory
 * picker for selecting the project directory and auto-name suggestion.
 */
export function SetupWizardModal({
  onProjectRegistered,
  onClose,
  agentOnboardingEnabled = false,
  includeAgentStep = true,
}: SetupWizardModalProps) {
  const { t } = useTranslation("app");
  const helpUrl = "https://discord.gg/ksrfuy7WYR";
  /*
  FNXC:Onboarding 2026-06-22-03:11:
  New-project setup must collect project details first, then offer a project-specific persistent agent after registration, defaulting to the CEO preset while still letting users choose another template or skip creation.
  The AI interview entry point is feature-flagged by `agentOnboardingEnabled`; preset creation and skip remain available without it.

  FNXC:Onboarding 2026-06-22-05:16:
  Brand-new onboarding already has its own Agent step after AI, GitHub, and Project setup.
  When this wizard is opened as that Project sub-flow, register the project and return immediately so users do not see two agent prompts.
  */
  const ceoPreset = useMemo(
    () => getPresetById("ceo") ?? AGENT_PRESETS[0]!,
    [],
  );
  const [isOpen, setIsOpen] = useState(true);
  const [state, setState] = useState<WizardState>(() => ({
    step: "manual",
    manualMode: "existing",
    manualPath: "",
    manualCloneUrl: "",
    manualName: "",
    manualIsolationMode: "in-process",
    manualNodeId: "",
    manualTaskPrefix: "",
    detectedRepos: [],
    workspaceMode: false,
    isDetectingWorkspace: false,
    registeredProject: null,
    selectedPresetId: ceoPreset.id,
    agentDraft: mapPresetToAgentDraft(ceoPreset),
    isCreatingAgent: false,
    isRegistering: false,
    error: null,
    agentError: null,
    agentOutcome: null,
  }));
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [isInterviewOpen, setIsInterviewOpen] = useState(false);
  const agentErrorRef = useRef<HTMLDivElement | null>(null);

  const { nodes, loading: nodesLoading } = useNodes();
  const localNodeId = nodes.find((n) => n.type === "local")?.id;

  const handleClose = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [onClose]);

  const handleFinish = useCallback(() => {
    if (state.registeredProject) {
      onProjectRegistered(state.registeredProject);
      return;
    }
    handleClose();
  }, [handleClose, onProjectRegistered, state.registeredProject]);

  useEffect(() => {
    if (state.agentError) {
      agentErrorRef.current?.focus();
    }
  }, [state.agentError]);

  const detectWorkspaceRequestId = useRef(0);

  const handlePathChange = useCallback((path: string) => {
    setState((prev) => {
      const updates: Partial<WizardState> = { manualPath: path, detectedRepos: [], workspaceMode: false };
      // Auto-suggest name when path changes and name is empty or was previously auto-suggested
      if (path && (!prev.manualName || prev.manualName === suggestProjectName(prev.manualPath))) {
        updates.manualName = suggestProjectName(path);
      }
      // Auto-suggest prefix when name changes and prefix is empty or was previously auto-suggested
      const suggestedName = updates.manualName ?? prev.manualName;
      if (suggestedName && (!prev.manualTaskPrefix || prev.manualTaskPrefix === suggestTaskPrefixFromName(suggestProjectName(prev.manualPath)))) {
        updates.manualTaskPrefix = suggestTaskPrefixFromName(suggestedName);
      }
      return { ...prev, ...updates };
    });

    /*
    FNXC:Workspace 2026-06-24-21:00:
    Detect workspace sub-repos only in existing-directory mode (clone mode creates a fresh
    directory with a single repo). A monotonic request ID guards against stale responses
    overwriting state from a newer path entry (race condition on rapid typing).
    */
    if (state.manualMode === "existing" && path.trim() && path.trim() !== "/") {
      const requestId = ++detectWorkspaceRequestId.current;
      setState((prev) => ({ ...prev, isDetectingWorkspace: true }));
      detectWorkspace(path.trim())
        .then((result) => {
          if (requestId !== detectWorkspaceRequestId.current) return;
          setState((prev) => ({
            ...prev,
            isDetectingWorkspace: false,
            detectedRepos: result.repos,
            workspaceMode: result.isWorkspace,
          }));
        })
        .catch(() => {
          if (requestId !== detectWorkspaceRequestId.current) return;
          setState((prev) => ({ ...prev, isDetectingWorkspace: false }));
        });
    }
  }, [state.manualMode]);

  const handleSetupModeChange = useCallback((mode: ManualSetupMode) => {
    setState((prev) => ({
      ...prev,
      manualMode: mode,
      manualCloneUrl: mode === "clone" ? prev.manualCloneUrl : "",
      detectedRepos: mode === "existing" ? prev.detectedRepos : [],
      workspaceMode: mode === "existing" ? prev.workspaceMode : false,
      isDetectingWorkspace: false,
      error: null,
    }));
    detectWorkspaceRequestId.current += 1;
  }, []);

  const handleManualRegister = useCallback(async () => {
    const trimmedPath = state.manualPath.trim();
    const trimmedName = state.manualName.trim();
    const trimmedCloneUrl = state.manualCloneUrl.trim();

    if (!trimmedPath || !trimmedName) return;
    if (state.manualMode === "clone" && !trimmedCloneUrl) return;

    setState((prev) => ({ ...prev, isRegistering: true, error: null }));

    try {
      const input: ProjectCreateInput = {
        name: trimmedName,
        path: trimmedPath,
        isolationMode: state.manualIsolationMode,
        nodeId: state.manualNodeId || undefined,
        gitSetupMode: state.manualMode,
        cloneUrl: state.manualMode === "clone" ? trimmedCloneUrl : undefined,
        workspaceMode: state.manualMode === "existing" ? state.workspaceMode : false,
        taskPrefix: state.manualTaskPrefix.trim() || undefined,
      };

      const result = await registerProject(input);

      if (!includeAgentStep) {
        setState((prev) => ({
          ...prev,
          isRegistering: false,
        }));
        onProjectRegistered(result);
        return;
      }

      setState((prev) => ({
        ...prev,
        step: "agent",
        registeredProject: result,
        isRegistering: false,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isRegistering: false,
        error: err instanceof Error ? err.message : "Failed to register project",
      }));
    }
  }, [includeAgentStep, onProjectRegistered, state.manualPath, state.manualName, state.manualCloneUrl, state.manualMode, state.manualIsolationMode, state.manualNodeId, state.workspaceMode, state.manualTaskPrefix]);

  const handlePresetSelect = useCallback((presetId: string) => {
    const preset = getPresetById(presetId);
    if (!preset) return;
    setState((prev) => ({
      ...prev,
      selectedPresetId: preset.id,
      agentDraft: mapPresetToAgentDraft(preset),
      agentError: null,
    }));
  }, []);

  const handlePresetKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, presetId: string) => {
    const currentIndex = AGENT_PRESETS.findIndex((preset) => preset.id === presetId);
    if (currentIndex < 0) return;

    const lastIndex = AGENT_PRESETS.length - 1;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextPreset = AGENT_PRESETS[nextIndex];
    handlePresetSelect(nextPreset.id);
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-agent-preset-id="${nextPreset.id}"]`)?.focus();
    });
  }, [handlePresetSelect]);


  const handleApplyAgentDraft = useCallback((draft: AgentOnboardingSummary) => {
    setState((prev) => ({
      ...prev,
      selectedPresetId: "",
      agentDraft: mapOnboardingSummaryToAgentDraft(draft),
      agentError: null,
    }));
  }, []);

  const handleCreateFirstAgent = useCallback(async () => {
    if (!state.registeredProject || !state.agentDraft.name.trim()) return;
    setState((prev) => ({ ...prev, isCreatingAgent: true, agentError: null }));
    try {
      await createAgent(buildAgentCreatePayload(state.agentDraft), state.registeredProject.id);
      setState((prev) => ({
        ...prev,
        step: "complete",
        isCreatingAgent: false,
        agentOutcome: "created",
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isCreatingAgent: false,
        agentError: err instanceof Error ? err.message : t("setup.firstAgentCreateError", "Failed to create agent"),
      }));
    }
  }, [state.agentDraft, state.registeredProject, t]);

  const handleSkipAgent = useCallback(() => {
    setState((prev) => ({
      ...prev,
      step: "complete",
      agentError: null,
      agentOutcome: "skipped",
    }));
  }, []);

  if (!isOpen) return null;

  const isExistingMode = state.manualMode === "existing";
  const isInitMode = state.manualMode === "init";
  const isCloneMode = state.manualMode === "clone";
  const setupModeSubmitLabel = isCloneMode
    ? t("setup.cloneAndRegisterProject", "Clone and Register Project")
    : isInitMode
      ? t("setup.initializeAndRegisterProject", "Initialize and Register Project")
      : t("setup.registerProject", "Register Project");
  const hasPath = state.manualPath.trim().length > 0;
  const hasName = state.manualName.trim().length > 0;
  const hasCloneUrl = state.manualCloneUrl.trim().length > 0;
  const isRegisterDisabled = state.isRegistering
    || !hasPath
    || !hasName
    || (isCloneMode && !hasCloneUrl);
  const selectedPreset = state.selectedPresetId
    ? getPresetById(state.selectedPresetId)
    : undefined;
  const isAgentActionDisabled = state.isCreatingAgent;
  /*
   FNXC:Onboarding 2026-06-22-06:03:
   AI-generated agent drafts are custom and should not appear selected as a template, but the template radiogroup still needs one tabbable item for keyboard users.
   */
  const agentPresetTabStopId = state.selectedPresetId || ceoPreset.id;
  /*
   FNXC:Onboarding 2026-06-22-05:37:
   The optional project-agent step needs more horizontal room than project details so templates and preview can be compared side by side.
   Keep the wider modal scoped to the agent step so the initial project form stays compact.
   */
  const modalClassName = `modal setup-wizard-modal${state.step === "agent" ? " setup-wizard-modal--agent" : ""}`;

  return (
    <div className="modal-overlay open setup-wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className={modalClassName}>
        {/* Header */}
        <div className="setup-wizard-header">
          <div className="setup-wizard-heading">
            <div className="setup-wizard-brand" aria-label={t("setup.brandName", "Fusion")}>
              <svg
                className="setup-wizard-brand-logo"
                width={28}
                height={28}
                viewBox="0 0 128 128"
                fill="none"
                aria-label={t("setup.brandLogo", "Fusion logo")}
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
              <span className="setup-wizard-brand-name">{t("setup.brandName", "Fusion")}</span>
            </div>
            <h2 id="wizard-title" className="setup-wizard-title">
              {state.step === "manual" && t("setup.welcomeToFusion", "Welcome to Fusion")}
              {state.step === "agent" && t("setup.firstAgentTitle", "Create your first agent")}
              {state.step === "complete" && t("setup.setupCompleteTitle", "Setup Complete!")}
            </h2>
          </div>
          {state.step !== "complete" && state.step !== "agent" && (
            <button
              className="modal-close"
              onClick={handleClose}
              aria-label={t("setup.closeWizard", "Close wizard")}
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
              {/*
                FNXC:Onboarding 2026-07-02-14:30:
                First-run project setup must make existing, init, and clone repository paths visible before path entry.
                The selected mode tells users whether Fusion will register an existing git repo, run server-side `git init`, or `git clone` into an empty destination so non-git folders do not strand onboarding.
              */}
              <section className="setup-wizard-repository-section" aria-labelledby="setup-repository-mode-title">
                <div className="setup-wizard-section-heading">
                  <h3 id="setup-repository-mode-title">{t("setup.repositorySetupTitle", "Repository setup")}</h3>
                  <p>{t("setup.repositorySetupDescription", "Choose how Fusion should prepare the project directory before registration.")}</p>
                </div>
                <fieldset className="setup-wizard-mode-switch" aria-label={t("setup.projectSetupModeAriaLabel", "Project setup mode")}>
                  <legend>{t("setup.setupMode", "Setup Mode")}</legend>
                  <label className={`setup-wizard-mode-option${isExistingMode ? " selected" : ""}`}>
                    <input
                      type="radio"
                      name="setup-mode"
                      value="existing"
                      aria-label={t("setup.useExistingDirectory", "Use Existing Directory")}
                      checked={isExistingMode}
                      onChange={() => handleSetupModeChange("existing")}
                    />
                    <span className="setup-wizard-mode-option-copy">
                      <strong>{t("setup.useExistingDirectory", "Use Existing Directory")}</strong>
                      <span>{t("setup.useExistingDirectoryHint", "Register a folder that is already a git repository or workspace root.")}</span>
                    </span>
                  </label>
                  <label className={`setup-wizard-mode-option${isInitMode ? " selected" : ""}`}>
                    <input
                      type="radio"
                      name="setup-mode"
                      value="init"
                      aria-label={t("setup.initializeNewRepository", "Initialize New Repository")}
                      checked={isInitMode}
                      onChange={() => handleSetupModeChange("init")}
                    />
                    <span className="setup-wizard-mode-option-copy">
                      <strong>{t("setup.initializeNewRepository", "Initialize New Repository")}</strong>
                      <span>{t("setup.initializeNewRepositoryHint", "Register a selected non-git folder and let Fusion run git init on the server.")}</span>
                    </span>
                  </label>
                  <label className={`setup-wizard-mode-option${isCloneMode ? " selected" : ""}`}>
                    <input
                      type="radio"
                      name="setup-mode"
                      value="clone"
                      aria-label={t("setup.cloneGitRepository", "Clone Git Repository")}
                      checked={isCloneMode}
                      onChange={() => handleSetupModeChange("clone")}
                    />
                    <span className="setup-wizard-mode-option-copy">
                      <strong>{t("setup.cloneGitRepository", "Clone Git Repository")}</strong>
                      <span>{t("setup.cloneGitRepositoryHint", "Clone a remote repository into an empty or absent destination folder.")}</span>
                    </span>
                  </label>
                </fieldset>
              </section>

              {/*
                FNXC:Onboarding 2026-07-03-08:20:
                Folder selection comes BEFORE the project name: the name auto-derives from the chosen
                directory, so picking the folder first pre-fills a sensible name (rather than asking for
                a name before there's a folder to base it on).
              */}
              <div className="form-group">
                <label htmlFor="project-path">{isCloneMode ? t("setup.destinationDirectory", "Destination Directory") : isInitMode ? t("setup.newRepositoryDirectory", "New Repository Directory") : t("setup.projectDirectory", "Project Directory")}</label>
                <DirectoryPicker
                  value={state.manualPath}
                  onChange={handlePathChange}
                  nodeId={state.manualNodeId || undefined}
                  localNodeId={localNodeId}
                  placeholder={isCloneMode ? t("setup.clonePathPlaceholder", "/path/for/new-clone") : isInitMode ? t("setup.initPathPlaceholder", "/path/to/new-project") : t("setup.projectPathPlaceholder", "/path/to/your/project")}
                />
                <p className="form-hint">
                  {isCloneMode
                    ? t("setup.clonePathHint", "Select or type an absolute destination path. Fusion will clone into this directory. The destination must be empty or absent.")
                    : isInitMode
                      ? t("setup.initPathHint", "Select or type an absolute path to an empty or non-git folder. Fusion will run git init during registration.")
                      : t("setup.projectPathHint", "Select or type the absolute path to an existing git repository or workspace root.")}
                </p>
              </div>

              <div className="form-group">
                <label htmlFor="project-name">{t("setup.projectName", "Project Name")}</label>
                <input
                  id="project-name"
                  type="text"
                  value={state.manualName}
                  onChange={(e) =>
                    setState((prev) => ({ ...prev, manualName: e.target.value }))
                  }
                  placeholder={t("setup.projectNamePlaceholder", "my-project")}
                />
                <p className="form-hint">
                  {isCloneMode
                    ? t("setup.projectNameHintClone", "By default this follows the destination folder name unless you edit it.")
                    : isInitMode
                      ? t("setup.projectNameHintInit", "By default this follows the folder name Fusion will initialize unless you edit it.")
                      : t("setup.projectNameHintExisting", "By default this follows the selected directory name unless you edit it.")}
                </p>
              </div>

              {isCloneMode && (
                <div className="form-group">
                  <label htmlFor="project-clone-url">{t("setup.repositoryUrl", "Repository URL")}</label>
                  <input
                    id="project-clone-url"
                    type="text"
                    value={state.manualCloneUrl}
                    onChange={(e) => setState((prev) => ({ ...prev, manualCloneUrl: e.target.value, error: null }))}
                    placeholder={t("setup.repositoryUrlPlaceholder", "https://github.com/owner/repo.git")}
                  />
                  <p className="form-hint">
                    {t("setup.cloneGitHint", "Fusion will run git clone into the destination directory, then register that cloned folder.")}
                  </p>
                </div>
              )}

              {/*
                FNXC:Workspace 2026-06-24-19:00:
                Workspace mode detection: when the selected directory contains git sub-repos,
                show a checkbox letting the user opt into workspace mode. In workspace mode,
                tasks run per-sub-repo and no git repo is created at the root.
              */}
              {isExistingMode && state.manualPath.trim() && (
                <div className="form-group">
                  <label htmlFor="workspace-mode" className="checkbox-label">
                    <input
                      id="workspace-mode"
                      type="checkbox"
                      checked={state.workspaceMode}
                      onChange={(e) => setState((prev) => ({ ...prev, workspaceMode: e.target.checked }))}
                    />
                    {t("setup.workspaceMode", "Workspace mode (multi-repo)")}
                  </label>
                  {state.isDetectingWorkspace && (
                    <p className="form-hint">
                      <Loader2 size={12} className="animate-spin setup-wizard-inline-spinner" />
                      {t("setup.detectingWorkspace", "Detecting sub-repositories...")}
                    </p>
                  )}
                  {!state.isDetectingWorkspace && state.detectedRepos.length > 0 && (
                    <p className="form-hint">
                      {t("setup.detectedRepos", "Found {{count}} repositories:", { count: state.detectedRepos.length })}
                      {" "}
                      {state.detectedRepos.join(", ")}
                    </p>
                  )}
                  {!state.isDetectingWorkspace && state.detectedRepos.length === 0 && state.workspaceMode === false && state.manualPath.trim() && (
                    <p className="form-hint">
                      {t("setup.noSubReposDetected", "No sub-repositories detected. Enable if this is a multi-repo workspace.")}
                    </p>
                  )}
                </div>
              )}

              {/*
                FNXC:TaskPrefix 2026-06-24-19:00:
                Task prefix field: auto-derived from the project name. The prefix is used
                for task IDs (e.g. "MYPR-1"). Users can override it.
              */}
              <div className="form-group">
                <label htmlFor="task-prefix">{t("setup.taskPrefix", "Task Prefix")}</label>
                <input
                  id="task-prefix"
                  type="text"
                  value={state.manualTaskPrefix}
                  onChange={(e) => setState((prev) => ({ ...prev, manualTaskPrefix: e.target.value.toUpperCase() }))}
                  placeholder={suggestTaskPrefixFromName(state.manualName || "FN")}
                  maxLength={5}
                />
                <p className="form-hint">
                  {t("setup.taskPrefixHint", "Used for task IDs (e.g. \"{{prefix}}-1\"). Derived from project name.", { prefix: state.manualTaskPrefix || "FN" })}
                </p>
              </div>

              <div className="setup-wizard-advanced">
                <button
                  type="button"
                  className="setup-wizard-advanced-toggle"
                  aria-expanded={showAdvancedSettings}
                  onClick={() => setShowAdvancedSettings((prev) => !prev)}
                >
                  <ChevronRight size={16} className="setup-wizard-advanced-chevron" />
                  <span>{t("setup.advancedSettings", "Advanced settings")}</span>
                </button>
                {showAdvancedSettings && (
                  <div className="setup-wizard-advanced-panel">
                    <div className="form-group">
                      <div className="project-node-selector">
                        <span className="project-node-selector__label">{t("setup.runtimeNode", "Runtime Node")}</span>
                        <select
                          value={state.manualNodeId}
                          onChange={(e) => setState((prev) => ({ ...prev, manualNodeId: e.target.value }))}
                          disabled={nodesLoading || state.isRegistering}
                        >
                          <option value="">{t("setup.localNode", "Local node")}</option>
                          {nodes.map((node) => (
                            <option key={node.id} value={node.id}>
                              {node.name} ({node.type})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="form-group">
                      <label>{t("setup.isolationMode", "Isolation Mode")}</label>
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
                            <strong>{t("setup.inProcess", "In-Process")}</strong>
                            <span>{t("setup.inProcessDesc", "Lower overhead, shared memory. Best for most projects.")}</span>
                            <span className="wizard-option-recommended">{t("setup.recommended", "Recommended")}</span>
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
                            <strong>{t("setup.childProcess", "Child-Process")}</strong>
                            <span>{t("setup.childProcessDesc", "Isolated execution with crash containment.")}</span>
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

          {/* FNXC:Onboarding 2026-06-22-03:11: First-run setup asks for an optional persistent coordinating agent after project registration. Users can skip it because task creation and task execution do not require an assigned persistent agent; Fusion automatically spawns temporary planning, execution, review, and merge agents for task work. */}
          {state.step === "agent" && (
            <div className="setup-wizard-agent-step">
              <p className="setup-wizard-agent-intro">
                {t("setup.firstAgentIntro", "Agents are optional. Fusion can build tasks without one by starting temporary agents for planning, coding, review, and merge. Create an agent only if you want help coordinating tasks and direction.")}
              </p>

              <div className="setup-wizard-agent-layout">
                <section className="setup-wizard-agent-presets" aria-labelledby="setup-first-agent-presets-heading">
                  <div className="setup-wizard-agent-section-heading" id="setup-first-agent-presets-heading">
                    {t("setup.firstAgentTemplates", "Templates")}
                  </div>
                  <div className="setup-wizard-agent-preset-list" role="radiogroup" aria-label={t("setup.firstAgentTemplates", "Templates")}>
                    {AGENT_PRESETS.map((preset) => {
                      const selected = state.selectedPresetId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          className={`setup-wizard-agent-preset${selected ? " selected" : ""}`}
                          role="radio"
                          aria-checked={selected}
                          aria-label={selected ? t("setup.selectedAgentTemplate", "{{name}} selected", { name: preset.name }) : preset.name}
                          tabIndex={preset.id === agentPresetTabStopId ? 0 : -1}
                          data-agent-preset-id={preset.id}
                          disabled={isAgentActionDisabled}
                          onClick={() => handlePresetSelect(preset.id)}
                          onKeyDown={(event) => handlePresetKeyDown(event, preset.id)}
                        >
                          <AgentAvatar agent={{ id: preset.id, icon: preset.icon, name: preset.name }} size={28} />
                          <span className="setup-wizard-agent-preset-copy">
                            <span className="setup-wizard-agent-preset-name">
                              {preset.name}
                              {preset.id === "ceo" && <span className="wizard-option-recommended">{t("setup.recommended", "Recommended")}</span>}
                            </span>
                            <span className="setup-wizard-agent-preset-description">{preset.description}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="setup-wizard-agent-preview" aria-labelledby="setup-first-agent-preview-heading">
                  <div className="setup-wizard-agent-section-heading" id="setup-first-agent-preview-heading">
                    {t("setup.firstAgentPreview", "Preview")}
                  </div>
                  <div className="setup-wizard-agent-preview-card">
                    <div className="setup-wizard-agent-preview-title-row">
                      <AgentAvatar agent={{ id: state.selectedPresetId || "draft", icon: state.agentDraft.icon, name: state.agentDraft.name }} size={36} />
                      <div>
                        <h3>{state.agentDraft.name || t("setup.firstAgentDraftName", "Draft agent")}</h3>
                        <p>{state.agentDraft.title || selectedPreset?.title || t("setup.firstAgentCustomDraft", "Custom agent draft")}</p>
                      </div>
                    </div>
                    <dl className="setup-wizard-agent-preview-list">
                      <div>
                        <dt>{t("agents.fieldRole", "Role")}</dt>
                        <dd>{state.agentDraft.role}</dd>
                      </div>
                      <div>
                        <dt>{t("agents.fieldInstructionsText", "Inline Instructions")}</dt>
                        <dd>{state.agentDraft.instructionsText || t("setup.firstAgentNoInstructions", "No inline instructions yet")}</dd>
                      </div>
                    </dl>
                    {agentOnboardingEnabled && (
                      <button
                        type="button"
                        className="btn setup-wizard-agent-ai-btn"
                        onClick={() => setIsInterviewOpen(true)}
                        disabled={isAgentActionDisabled}
                      >
                        <Sparkles size={16} />
                        <span>{t("agents.aiInterview", "AI Interview")}</span>
                      </button>
                    )}
                  </div>
                </section>
              </div>

              {state.agentError && (
                <div className="wizard-error" role="alert" tabIndex={-1} ref={agentErrorRef}>
                  {state.agentError}
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
              <h3>{t("setup.allSet", "All Set!")}</h3>
              <p>
                {state.agentOutcome === "created"
                  ? t("setup.firstAgentCreatedSuccess", "Your project is registered and your first agent is ready.")
                  : t("setup.projectRegisteredSuccess", "Your project has been registered successfully.")}
              </p>
              <p>
                {state.agentOutcome === "skipped"
                  ? t("setup.firstAgentSkippedHint", "You can create agents later from the Agents view.")
                  : t("setup.addMoreProjectsHint", "You can add more projects anytime from the project overview.")}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="setup-wizard-footer">
          <a
            className="btn setup-wizard-help-link"
            href={helpUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("setup.needHelp", "Need help?")}
          </a>
          {state.step === "manual" && (
            <button
              className="btn btn-primary"
              onClick={handleManualRegister}
              disabled={isRegisterDisabled}
            >
              {state.isRegistering ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>{t("setup.registering", "Registering...")}</span>
                </>
              ) : (
                <span>{setupModeSubmitLabel}</span>
              )}
            </button>
          )}

          {state.step === "agent" && (
            <>
              <button
                className="btn"
                onClick={handleSkipAgent}
                disabled={isAgentActionDisabled}
              >
                {t("setup.skipFirstAgent", "Skip for now")}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void handleCreateFirstAgent()}
                disabled={isAgentActionDisabled || !state.agentDraft.name.trim()}
                aria-busy={state.isCreatingAgent}
              >
                {state.isCreatingAgent ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>{t("setup.creatingFirstAgent", "Creating agent...")}</span>
                  </>
                ) : (
                  <span>{t("setup.createFirstAgent", "Create Agent")}</span>
                )}
              </button>
            </>
          )}

          {state.step === "complete" && (
            <button className="btn btn-primary" onClick={handleFinish}>
              <CheckCircle size={16} />
              <span>{t("setup.getStarted", "Get Started")}</span>
            </button>
          )}
        </div>
      </div>
      {agentOnboardingEnabled && isInterviewOpen && (
        <ErrorBoundary
          level="modal"
          fallback={(
            <div className="wizard-error setup-wizard-agent-interview-error" role="alert">
              <span>{t("setup.firstAgentInterviewLoadError", "AI interview could not load. You can still create an agent from a template or skip this step.")}</span>
              <button type="button" className="btn" onClick={() => setIsInterviewOpen(false)}>
                {t("setup.firstAgentContinueWithTemplates", "Continue with templates")}
              </button>
            </div>
          )}
        >
          <Suspense fallback={(
            <div className="wizard-error setup-wizard-agent-interview-error" role="status">
              {t("setup.firstAgentInterviewLoading", "Loading AI Interview...")}
            </div>
          )}
          >
            <ExperimentalAgentOnboardingModal
              isOpen={isInterviewOpen}
              onClose={() => setIsInterviewOpen(false)}
              onUseDraft={handleApplyAgentDraft}
              projectId={state.registeredProject?.id}
              existingAgents={[]}
              mode="create"
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}
