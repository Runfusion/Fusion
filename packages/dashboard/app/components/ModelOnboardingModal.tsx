import { useState, useEffect, useCallback, useRef } from "react";
import { X, Loader2, CheckCircle, Key, Zap, GitPullRequest, Rocket, Plus } from "lucide-react";
import type { AuthProvider, ModelInfo } from "../api";
import {
  fetchAuthStatus,
  fetchGlobalSettings,
  loginProvider,
  logoutProvider,
  saveApiKey,
  clearApiKey,
  fetchModels,
  updateGlobalSettings,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import { CustomModelDropdown } from "./CustomModelDropdown";
import {
  getOnboardingState,
  saveOnboardingState,
  clearOnboardingState,
  type OnboardingStep,
} from "./model-onboarding-state";
import type { SectionId } from "./SettingsModal";

export interface ModelOnboardingModalProps {
  /** Called when onboarding is complete or dismissed */
  onComplete: () => void;
  /** Toast helper */
  addToast: (message: string, type?: ToastType) => void;
  /** Optional callback when user wants to open new task creation */
  onOpenNewTask?: () => void;
  /** Optional callback when user wants to open GitHub import */
  onOpenGitHubImport?: () => void;
}



/**
 * Multi-step onboarding modal that guides users through:
 * 1. AI Setup - Provider credential setup (OAuth login or API key entry) and default model selection
 * 2. GitHub (Optional) - GitHub connection status and login
 * 3. First Task - CTA to create first task or import from GitHub
 *
 * Dismissing the modal marks onboarding as complete to prevent repeated popups.
 */
export function ModelOnboardingModal({
  onComplete,
  addToast,
  onOpenNewTask,
  onOpenGitHubImport,
}: ModelOnboardingModalProps) {
  // Initialize from persisted state if available (allows resume from last step)
  const persistedState = getOnboardingState();
  const initialStep: OnboardingStep = persistedState && persistedState.currentStep !== "complete"
    ? persistedState.currentStep as OnboardingStep
    : "ai-setup";

  const [isOpen, setIsOpen] = useState(true);
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [authLoading, setAuthLoading] = useState(true);
  const [authActionInProgress, setAuthActionInProgress] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeyErrors, setApiKeyErrors] = useState<Record<string, string>>({});
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Step definitions for progress indicator
  const steps = [
    { key: "ai-setup" as const, label: "AI Setup" },
    { key: "github" as const, label: "GitHub" },
    { key: "first-task" as const, label: "First Task" },
  ];

  // Get current step index for progress indicator
  const currentStepIndex = steps.findIndex((s) => s.key === step);

  // Persist step state whenever it changes (for resume functionality)
  useEffect(() => {
    if (step !== "complete") {
      saveOnboardingState(step);
    }
  }, [step]);

  // Load auth providers
  const loadAuthStatus = useCallback(async () => {
    try {
      const { providers } = await fetchAuthStatus();
      setAuthProviders(providers);
    } catch {
      // Silently fail
    }
  }, []);

  // Load models
  const loadModels = useCallback(async () => {
    try {
      const response = await fetchModels();
      setAvailableModels(response.models);
    } catch {
      // Silently fail
    }
  }, []);

  // Initial data load
  useEffect(() => {
    Promise.all([loadAuthStatus(), loadModels()]).finally(() =>
      setAuthLoading(false),
    );
  }, [loadAuthStatus, loadModels]);

  // Check if we have GitHub provider
  const githubProvider = authProviders.find((p) => p.id === "github");
  const hasGithubProvider = !!githubProvider;
  const isGithubAuthenticated = githubProvider?.authenticated ?? false;

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // Navigate to next step
  const handleNext = useCallback(() => {
    if (step === "ai-setup") {
      setStep("github");
    } else if (step === "github") {
      setStep("first-task");
    }
  }, [step]);

  // Navigate to previous step
  const handleBack = useCallback(() => {
    if (step === "github") {
      setStep("ai-setup");
    } else if (step === "first-task") {
      setStep("github");
    }
  }, [step]);

  // OAuth login handler
  const handleLogin = useCallback(
    async (providerId: string) => {
      setAuthActionInProgress(providerId);
      try {
        const { url } = await loginProvider(providerId);
        window.open(url, "_blank");

        // Poll for auth completion
        pollIntervalRef.current = setInterval(async () => {
          try {
            const { providers } = await fetchAuthStatus();
            setAuthProviders(providers);
            const provider = providers.find((p) => p.id === providerId);
            if (provider?.authenticated) {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setAuthActionInProgress(null);
              addToast("Login successful", "success");
            }
          } catch {
            // Continue polling
          }
        }, 2000);
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : "Login failed",
          "error",
        );
        setAuthActionInProgress(null);
      }
    },
    [addToast],
  );

  // API key save handler
  const handleSaveApiKey = useCallback(
    async (providerId: string) => {
      const key = apiKeyInputs[providerId]?.trim();
      if (!key) {
        setApiKeyErrors((prev) => ({
          ...prev,
          [providerId]: "API key is required",
        }));
        return;
      }
      setAuthActionInProgress(providerId);
      setApiKeyErrors((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      try {
        await saveApiKey(providerId, key);
        await loadAuthStatus();
        setApiKeyInputs((prev) => {
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
        addToast("API key saved", "success");
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : "Failed to save API key",
          "error",
        );
      } finally {
        setAuthActionInProgress(null);
      }
    },
    [apiKeyInputs, addToast, loadAuthStatus],
  );

  // API key clear handler
  const handleClearApiKey = useCallback(
    async (providerId: string) => {
      setAuthActionInProgress(providerId);
      try {
        await clearApiKey(providerId);
        await loadAuthStatus();
        addToast("API key removed", "success");
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : "Failed to clear API key",
          "error",
        );
      } finally {
        setAuthActionInProgress(null);
      }
    },
    [addToast, loadAuthStatus],
  );

  // Logout handler (for OAuth providers that are authenticated)
  const handleLogout = useCallback(
    async (providerId: string) => {
      setAuthActionInProgress(providerId);
      try {
        await logoutProvider(providerId);
        await loadAuthStatus();
        addToast("Logged out", "success");
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : "Logout failed",
          "error",
        );
      } finally {
        setAuthActionInProgress(null);
      }
    },
    [addToast, loadAuthStatus],
  );

  // Handle model selection from CustomModelDropdown
  const handleModelSelect = useCallback((value: string) => {
    setSelectedModel(value);
  }, []);

  // Complete onboarding
  const handleComplete = useCallback(async () => {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {
        modelOnboardingComplete: true,
      };

      // If a model was selected, persist it as the default
      if (selectedModel) {
        // Parse the provider/modelId format from CustomModelDropdown
        const slashIdx = selectedModel.indexOf("/");
        const provider =
          slashIdx !== -1 ? selectedModel.slice(0, slashIdx) : undefined;
        const modelId =
          slashIdx !== -1 ? selectedModel.slice(slashIdx + 1) : selectedModel;

        const model = availableModels.find((m) => m.id === modelId);
        if (model) {
          updates.defaultProvider = model.provider;
          updates.defaultModelId = model.id;
        } else if (provider && modelId) {
          // Fallback: use parsed values even if not in the model list
          updates.defaultProvider = provider;
          updates.defaultModelId = modelId;
        }
      }

      await updateGlobalSettings(updates);
      setStep("complete");
      // Clear persisted onboarding state now that onboarding is complete
      clearOnboardingState();
    } catch (err: unknown) {
      addToast(
        err instanceof Error ? err.message : "Failed to save settings",
        "error",
      );
    } finally {
      setSaving(false);
    }
  }, [selectedModel, availableModels, addToast]);

  // Handle first task CTA - mark complete, close modal, then open new task
  const handleOpenNewTask = useCallback(async () => {
    // First complete the onboarding
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {
        modelOnboardingComplete: true,
      };

      // If a model was selected, persist it as the default
      if (selectedModel) {
        const slashIdx = selectedModel.indexOf("/");
        const provider =
          slashIdx !== -1 ? selectedModel.slice(0, slashIdx) : undefined;
        const modelId =
          slashIdx !== -1 ? selectedModel.slice(slashIdx + 1) : selectedModel;

        const model = availableModels.find((m) => m.id === modelId);
        if (model) {
          updates.defaultProvider = model.provider;
          updates.defaultModelId = model.id;
        } else if (provider && modelId) {
          updates.defaultProvider = provider;
          updates.defaultModelId = modelId;
        }
      }

      await updateGlobalSettings(updates);
      // Clear persisted onboarding state now that onboarding is complete
      clearOnboardingState();
    } catch {
      // Best-effort: continue even if save fails
    } finally {
      setSaving(false);
    }

    // Close modal and trigger callback
    setIsOpen(false);
    onComplete();
    onOpenNewTask?.();
  }, [selectedModel, availableModels, onComplete, onOpenNewTask]);

  // Handle GitHub import CTA - mark complete, close modal, then open GitHub import
  const handleOpenGitHubImport = useCallback(async () => {
    // First complete the onboarding
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {
        modelOnboardingComplete: true,
      };

      // If a model was selected, persist it as the default
      if (selectedModel) {
        const slashIdx = selectedModel.indexOf("/");
        const provider =
          slashIdx !== -1 ? selectedModel.slice(0, slashIdx) : undefined;
        const modelId =
          slashIdx !== -1 ? selectedModel.slice(slashIdx + 1) : selectedModel;

        const model = availableModels.find((m) => m.id === modelId);
        if (model) {
          updates.defaultProvider = model.provider;
          updates.defaultModelId = model.id;
        } else if (provider && modelId) {
          updates.defaultProvider = provider;
          updates.defaultModelId = modelId;
        }
      }

      await updateGlobalSettings(updates);
      // Clear persisted onboarding state now that onboarding is complete
      clearOnboardingState();
    } catch {
      // Best-effort: continue even if save fails
    } finally {
      setSaving(false);
    }

    // Close modal and trigger callback
    setIsOpen(false);
    onComplete();
    onOpenGitHubImport?.();
  }, [selectedModel, availableModels, onComplete, onOpenGitHubImport]);

  // Dismiss without completing (still marks onboarding complete)
  const handleDismiss = useCallback(async () => {
    setSaving(true);
    try {
      await updateGlobalSettings({ modelOnboardingComplete: true });
    } catch {
      // Best-effort: still close even if save fails
    }
    setIsOpen(false);
    onComplete();
  }, [onComplete]);

  // Close from the completion step
  const handleFinish = useCallback(() => {
    setIsOpen(false);
    onComplete();
  }, [onComplete]);

  if (!isOpen) return null;

  const oauthProviders = authProviders.filter(
    (p) => !p.type || p.type === "oauth",
  );
  const apiKeyProviders = authProviders.filter((p) => p.type === "api_key");

  // Filter out GitHub from AI providers list
  const aiOauthProviders = oauthProviders.filter((p) => p.id !== "github");
  const aiApiKeyProviders = apiKeyProviders.filter((p) => p.id !== "github");

  return (
    <div
      className="modal-overlay open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="modal model-onboarding-modal">
        {/* Header */}
        <div className="model-onboarding-header">
          <h2 id="onboarding-title" className="model-onboarding-title">
            {step === "ai-setup" && (
              <>
                <Zap size={24} /> Set Up AI
              </>
            )}
            {step === "github" && (
              <>
                <GitPullRequest size={24} /> Connect GitHub
              </>
            )}
            {step === "first-task" && (
              <>
                <Rocket size={24} /> Create Your First Task
              </>
            )}
            {step === "complete" && (
              <>
                <CheckCircle size={24} /> All Set!
              </>
            )}
          </h2>
          {step !== "complete" && (
            <button
              className="modal-close"
              onClick={handleDismiss}
              aria-label="Skip onboarding"
              title="Skip for now"
            >
              <X size={20} />
            </button>
          )}
        </div>

        {/* Step indicator - 3 progress steps + complete */}
        <div className="model-onboarding-steps">
          {steps.map((s, index) => (
            <div key={s.key} className="onboarding-step-wrapper">
              {index > 0 && (
                <div
                  className={`model-onboarding-step-connector ${
                    index <= currentStepIndex ? "done" : ""
                  }`}
                />
              )}
              <div
                className={`model-onboarding-step-indicator ${
                  step === s.key ? "active" : ""
                } ${currentStepIndex > index ? "done" : ""}`}
              >
                <span className="step-number">
                  {currentStepIndex > index ? (
                    <CheckCircle size={14} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="step-label">{s.label}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="model-onboarding-content">
          {step === "ai-setup" && (
            <div className="model-onboarding-ai-setup">
              <p className="model-onboarding-description">
                Connect an AI provider and choose a default model. You can
                authenticate via OAuth or enter an API key.
              </p>

              {authLoading ? (
                <div className="model-onboarding-loading">
                  <Loader2 size={24} className="animate-spin" />
                  <span>Loading providers…</span>
                </div>
              ) : authProviders.length === 0 ? (
                <div className="model-onboarding-empty">
                  No AI providers are configured. Please check your Fusion
                  configuration.
                </div>
              ) : (
                <>
                  {/* OAuth Providers */}
                  {aiOauthProviders.map((provider) => (
                    <div key={provider.id} className="onboarding-provider-row">
                      <div className="onboarding-provider-info">
                        <strong>{provider.name}</strong>
                        <span
                          data-testid={`onboarding-auth-status-${provider.id}`}
                          className={`auth-status-badge ${provider.authenticated ? "authenticated" : "not-authenticated"}`}
                        >
                          {provider.authenticated
                            ? "✓ Authenticated"
                            : "✗ Not authenticated"}
                        </span>
                      </div>
                      <div>
                        {authActionInProgress === provider.id ? (
                          <button className="btn btn-sm" disabled>
                            {provider.authenticated
                              ? "Logging out…"
                              : "Waiting for login…"}
                          </button>
                        ) : provider.authenticated ? (
                          <button
                            className="btn btn-sm"
                            onClick={() => handleLogout(provider.id)}
                          >
                            Logout
                          </button>
                        ) : (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => handleLogin(provider.id)}
                          >
                            Login
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* API Key Providers */}
                  {aiApiKeyProviders.map((provider) => (
                    <div key={provider.id} className="onboarding-provider-row">
                      <div className="onboarding-provider-info">
                        <strong>
                          <Key size={14} style={{ marginRight: 4 }} />
                          {provider.name}
                        </strong>
                        <span
                          data-testid={`onboarding-auth-status-${provider.id}`}
                          className={`auth-status-badge ${provider.authenticated ? "authenticated" : "not-authenticated"}`}
                        >
                          {provider.authenticated
                            ? "✓ Key saved"
                            : "✗ No API key"}
                        </span>
                      </div>
                      <div className="onboarding-apikey-actions">
                        {provider.authenticated ? (
                          <button
                            className="btn btn-sm"
                            onClick={() => handleClearApiKey(provider.id)}
                            disabled={authActionInProgress === provider.id}
                          >
                            {authActionInProgress === provider.id
                              ? "Removing…"
                              : "Remove Key"}
                          </button>
                        ) : (
                          <div className="onboarding-apikey-input-row">
                            <input
                              type="password"
                              className="onboarding-apikey-input"
                              placeholder={`Enter ${provider.name} API key`}
                              value={apiKeyInputs[provider.id] ?? ""}
                              onChange={(e) =>
                                setApiKeyInputs((prev) => ({
                                  ...prev,
                                  [provider.id]: e.target.value,
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  handleSaveApiKey(provider.id);
                                }
                              }}
                              data-testid={`onboarding-apikey-input-${provider.id}`}
                            />
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => handleSaveApiKey(provider.id)}
                              disabled={
                                authActionInProgress === provider.id ||
                                !apiKeyInputs[provider.id]?.trim()
                              }
                              data-testid={`onboarding-apikey-save-${provider.id}`}
                            >
                              {authActionInProgress === provider.id
                                ? "Saving…"
                                : "Save"}
                            </button>
                          </div>
                        )}
                        {apiKeyErrors[provider.id] && (
                          <small className="field-error">
                            {apiKeyErrors[provider.id]}
                          </small>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {/* Model Selection */}
              <div className="onboarding-model-section">
                <h3 className="onboarding-section-title">
                  Default Model (Optional)
                </h3>
                <p className="model-onboarding-description">
                  Select a default model for AI tasks. You can change this later
                  in Settings.
                </p>

                {availableModels.length === 0 ? (
                  <div className="model-onboarding-empty">
                    No models available. Please configure a provider first.
                  </div>
                ) : (
                  <div className="onboarding-model-selector">
                    <CustomModelDropdown
                      models={availableModels}
                      value={selectedModel}
                      onChange={handleModelSelect}
                      placeholder="Select a default model…"
                      label="Default model"
                    />
                  </div>
                )}

                {selectedModel && (
                  <div className="onboarding-model-preview">
                    <small className="settings-muted">
                      Selected:{" "}
                      {availableModels.find((m) => m.id === selectedModel)
                        ?.name ?? selectedModel}
                    </small>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === "github" && (
            <div className="model-onboarding-github">
              <p className="model-onboarding-description">
                Connect GitHub to import issues and manage pull requests. This is
                optional — you can still use Fusion without GitHub.
              </p>

              {!hasGithubProvider ? (
                <div className="model-onboarding-github-optional">
                  <GitPullRequest size={48} className="optional-icon" />
                  <p>
                    GitHub integration is not configured. You can set it up later
                    in Settings → Authentication.
                  </p>
                  <button
                    className="btn btn-sm"
                    onClick={() => setStep("first-task")}
                  >
                    Continue without GitHub →
                  </button>
                </div>
              ) : (
                <div className="onboarding-provider-row">
                  <div className="onboarding-provider-info">
                    <strong>
                      <GitPullRequest size={16} style={{ marginRight: 8 }} />
                      GitHub
                    </strong>
                    <span
                      data-testid="onboarding-auth-status-github"
                      className={`auth-status-badge ${isGithubAuthenticated ? "authenticated" : "not-authenticated"}`}
                    >
                      {isGithubAuthenticated
                        ? "✓ Connected"
                        : "✗ Not connected"}
                    </span>
                  </div>
                  <div>
                    {authActionInProgress === "github" ? (
                      <button className="btn btn-sm" disabled>
                        {isGithubAuthenticated
                          ? "Logging out…"
                          : "Waiting for login…"}
                      </button>
                    ) : isGithubAuthenticated ? (
                      <button
                        className="btn btn-sm"
                        onClick={() => handleLogout("github")}
                      >
                        Disconnect
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleLogin("github")}
                      >
                        Connect
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "first-task" && (
            <div className="model-onboarding-first-task">
              <p className="model-onboarding-description">
                You're all set! What would you like to do first?
              </p>

              <div className="onboarding-cta-options">
                <button
                  className="onboarding-cta-card primary"
                  onClick={handleOpenNewTask}
                  disabled={saving}
                >
                  <div className="cta-icon">
                    <Plus size={24} />
                  </div>
                  <div className="cta-content">
                    <strong>Create a New Task</strong>
                    <span>Describe a task and let AI handle the rest</span>
                  </div>
                </button>

                <button
                  className="onboarding-cta-card"
                  onClick={handleOpenGitHubImport}
                  disabled={saving}
                >
                  <div className="cta-icon">
                    <GitPullRequest size={24} />
                  </div>
                  <div className="cta-content">
                    <strong>Import from GitHub</strong>
                    <span>Bring in issues from your repositories</span>
                  </div>
                </button>
              </div>

              <p className="onboarding-skip-note">
                You can always create tasks later from the board or use{" "}
                <code>fn task create</code> from the CLI.
              </p>
            </div>
          )}

          {step === "complete" && (
            <div className="model-onboarding-complete">
              <CheckCircle size={48} className="success-icon" />
              <p>
                You're ready to start using Fusion! Check out the dashboard to
                create your first task.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="model-onboarding-footer">
          {step === "ai-setup" && (
            <>
              <button
                className="btn btn-sm"
                onClick={handleDismiss}
                disabled={saving}
              >
                Skip for now
              </button>
              <button className="btn btn-primary" onClick={handleNext}>
                Next →
              </button>
            </>
          )}

          {step === "github" && (
            <>
              <button className="btn btn-sm" onClick={handleBack}>
                ← Back
              </button>
              <button className="btn btn-primary" onClick={handleNext}>
                Next →
              </button>
            </>
          )}

          {step === "first-task" && (
            <>
              <button className="btn btn-sm" onClick={handleBack}>
                ← Back
              </button>
              <button
                className="btn btn-primary"
                onClick={handleComplete}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Saving…</span>
                  </>
                ) : (
                  "Finish Setup"
                )}
              </button>
            </>
          )}

          {step === "complete" && (
            <button className="btn btn-primary" onClick={handleFinish}>
              <CheckCircle size={16} />
              <span>Get Started</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

import type { ProjectInfo } from "../api";
import type { ColorTheme, Column, MergeResult, Task, ThemeMode } from "@fusion/core";
import type { UseProjectActionsResult } from "../hooks/useProjectActions";
import type { ModalManager } from "../hooks/useModalManager";
import type { UseTaskHandlersResult } from "../hooks/useTaskHandlers";
import type { Toast } from "../hooks/useToast";
import { ModalErrorBoundary } from "./ErrorBoundary";
import { TaskDetailModal } from "./TaskDetailModal";
import { SettingsModal } from "./SettingsModal";
import { GitHubImportModal } from "./GitHubImportModal";
import { PlanningModeModal } from "./PlanningModeModal";
import { SubtaskBreakdownModal } from "./SubtaskBreakdownModal";
import { TerminalModal } from "./TerminalModal";
import { ScriptsModal } from "./ScriptsModal";
import { FileBrowserModal } from "./FileBrowserModal";
import { UsageIndicator } from "./UsageIndicator";
import { ScheduledTasksModal } from "./ScheduledTasksModal";
import { NewTaskModal } from "./NewTaskModal";
import { ActivityLogModal } from "./ActivityLogModal";
import { GitManagerModal } from "./GitManagerModal";
import { WorkflowStepManager } from "./WorkflowStepManager";
import { AgentListModal } from "./AgentListModal";
import { MailboxModal } from "./MailboxModal";
import { SetupWizardModal } from "./SetupWizardModal";
import { ToastContainer } from "./ToastContainer";

interface AppModalsProps {
  projectId?: string;
  tasks: Task[];
  projects: ProjectInfo[];
  currentProject: ProjectInfo | null;
  addToast: (message: string, type?: ToastType) => void;
  toasts: Toast[];
  removeToast: (id: number) => void;
  modalManager: ModalManager;
  projectActions: Pick<UseProjectActionsResult, "handleSetupComplete" | "handleModelOnboardingComplete">;
  taskHandlers: Pick<UseTaskHandlersResult, "handleModalCreate" | "handlePlanningTaskCreated" | "handlePlanningTasksCreated" | "handleSubtaskTasksCreated" | "handleGitHubImport">;
  taskOperations: {
    moveTask: (taskId: string, column: Column, position?: number) => Promise<Task>;
    deleteTask: (taskId: string) => Promise<Task>;
    mergeTask: (taskId: string) => Promise<MergeResult>;
    retryTask: (taskId: string) => Promise<Task>;
    duplicateTask: (taskId: string) => Promise<Task>;
  };
  deepLink: {
    handleDetailClose: () => void;
  };
  settings: {
    githubTokenConfigured: boolean;
    themeMode: ThemeMode;
    colorTheme: ColorTheme;
    setThemeMode: (mode: ThemeMode) => void;
    setColorTheme: (theme: ColorTheme) => void;
  };
  /** Optional override for the settings modal close handler. When provided, this is called instead of modalManager.closeSettings. */
  onSettingsClose?: () => void;
}

export function AppModals({
  projectId,
  tasks,
  projects,
  currentProject,
  addToast,
  toasts,
  removeToast,
  modalManager,
  projectActions,
  taskHandlers,
  taskOperations,
  deepLink,
  settings,
  onSettingsClose,
}: AppModalsProps) {
  // Use the override handler if provided, otherwise fall back to modalManager.closeSettings
  const handleSettingsClose = onSettingsClose ?? modalManager.closeSettings;

  // Handlers for onboarding CTAs
  const handleOpenNewTask = useCallback(() => {
    modalManager.openNewTask();
  }, [modalManager]);

  const handleOpenGitHubImport = useCallback(() => {
    modalManager.openGitHubImport();
  }, [modalManager]);

  return (
    <>
      {modalManager.detailTask && (
        <ModalErrorBoundary>
          <TaskDetailModal
            task={modalManager.detailTask}
            projectId={projectId}
            tasks={tasks}
            onClose={deepLink.handleDetailClose}
            onOpenDetail={modalManager.openDetailTask}
            onMoveTask={taskOperations.moveTask}
            onDeleteTask={taskOperations.deleteTask}
            onMergeTask={taskOperations.mergeTask}
            onRetryTask={taskOperations.retryTask}
            onDuplicateTask={taskOperations.duplicateTask}
            onTaskUpdated={modalManager.updateDetailTask}
            addToast={addToast}
            githubTokenConfigured={settings.githubTokenConfigured}
            initialTab={modalManager.detailTaskInitialTab}
          />
        </ModalErrorBoundary>
      )}

      {modalManager.settingsOpen && (
        <ModalErrorBoundary>
          <SettingsModal
            onClose={handleSettingsClose}
            addToast={addToast}
            initialSection={modalManager.settingsInitialSection}
            projectId={projectId}
            themeMode={settings.themeMode}
            colorTheme={settings.colorTheme}
            onThemeModeChange={settings.setThemeMode}
            onColorThemeChange={settings.setColorTheme}
          />
        </ModalErrorBoundary>
      )}

      <GitHubImportModal
        isOpen={modalManager.githubImportOpen}
        onClose={modalManager.closeGitHubImport}
        onImport={taskHandlers.handleGitHubImport}
        tasks={tasks}
        projectId={projectId}
      />

      <ModalErrorBoundary>
        <PlanningModeModal
          isOpen={modalManager.isPlanningOpen}
          onClose={modalManager.closePlanning}
          onTaskCreated={taskHandlers.handlePlanningTaskCreated}
          onTasksCreated={taskHandlers.handlePlanningTasksCreated}
          tasks={tasks}
          initialPlan={modalManager.planningInitialPlan ?? undefined}
          projectId={projectId}
          resumeSessionId={modalManager.planningResumeSessionId}
        />
      </ModalErrorBoundary>

      <ModalErrorBoundary>
        <SubtaskBreakdownModal
          isOpen={modalManager.isSubtaskOpen}
          onClose={modalManager.closeSubtask}
          initialDescription={modalManager.subtaskInitialDescription ?? ""}
          onTasksCreated={taskHandlers.handleSubtaskTasksCreated}
          projectId={projectId}
          resumeSessionId={modalManager.subtaskResumeSessionId}
        />
      </ModalErrorBoundary>

      <TerminalModal
        isOpen={modalManager.terminalOpen}
        onClose={modalManager.closeTerminal}
        initialCommand={modalManager.terminalInitialCommand}
        projectId={projectId}
      />

      <ScriptsModal
        isOpen={modalManager.scriptsOpen}
        onClose={modalManager.closeScripts}
        addToast={addToast}
        onRunScript={modalManager.runScript}
        projectId={projectId}
      />

      {modalManager.filesOpen && (
        <FileBrowserModal
          initialWorkspace={modalManager.fileBrowserWorkspace}
          isOpen={true}
          onClose={modalManager.closeFiles}
          onWorkspaceChange={modalManager.setFileWorkspace}
          projectId={projectId}
        />
      )}

      <UsageIndicator
        isOpen={modalManager.usageOpen}
        onClose={modalManager.closeUsage}
        projectId={projectId}
      />

      {modalManager.schedulesOpen && (
        <ScheduledTasksModal
          onClose={modalManager.closeSchedules}
          addToast={addToast}
        />
      )}

      <ModalErrorBoundary>
        <NewTaskModal
          isOpen={modalManager.newTaskModalOpen}
          onClose={modalManager.closeNewTask}
          tasks={tasks}
          onCreateTask={taskHandlers.handleModalCreate}
          addToast={addToast}
          projectId={projectId}
          onPlanningMode={modalManager.openPlanningWithInitialPlan}
          onSubtaskBreakdown={modalManager.openSubtaskBreakdown}
        />
      </ModalErrorBoundary>

      <ActivityLogModal
        isOpen={modalManager.activityLogOpen}
        onClose={modalManager.closeActivityLog}
        tasks={tasks}
        projectId={projectId}
        projects={projects}
        currentProject={currentProject}
        onOpenTaskDetail={(taskId) => {
          const task = tasks.find((candidate) => candidate.id === taskId);
          if (task) {
            modalManager.openDetailTask(task);
          }
        }}
      />

      <ModalErrorBoundary>
        <GitManagerModal
          isOpen={modalManager.gitManagerOpen}
          onClose={modalManager.closeGitManager}
          tasks={tasks}
          addToast={addToast}
          projectId={projectId}
        />
      </ModalErrorBoundary>

      <ModalErrorBoundary>
        <WorkflowStepManager
          isOpen={modalManager.workflowStepsOpen}
          onClose={modalManager.closeWorkflowSteps}
          addToast={addToast}
          projectId={projectId}
        />
      </ModalErrorBoundary>

      <AgentListModal
        isOpen={modalManager.agentsOpen}
        onClose={modalManager.closeAgents}
        addToast={addToast}
        projectId={projectId}
      />

      <MailboxModal
        isOpen={modalManager.mailboxOpen}
        onClose={modalManager.closeMailbox}
        projectId={projectId}
        addToast={addToast}
        agents={modalManager.mailboxAgents}
      />

      {modalManager.setupWizardOpen && (
        <SetupWizardModal
          onProjectRegistered={projectActions.handleSetupComplete}
          onClose={modalManager.closeSetupWizard}
        />
      )}

      {modalManager.modelOnboardingOpen && (
        <ModelOnboardingModal
          onComplete={projectActions.handleModelOnboardingComplete}
          addToast={addToast}
          onOpenNewTask={handleOpenNewTask}
          onOpenGitHubImport={handleOpenGitHubImport}
        />
      )}

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </>
  );
}

export interface UseAuthOnboardingOptions {
  projectId?: string;
  openModelOnboarding: () => void;
  openSettings: (section?: SectionId) => void;
}

/**
 * Runs auth/onboarding checks and opens the appropriate setup modal.
 *
 * This hook implements a one-shot guard: the auto-trigger logic runs at most
 * once per hook instance (regardless of effect re-runs due to dependency changes).
 * This prevents repeat auto-opens on incidental rerenders or project context churn.
 *
 * Trigger behavior:
 * - First-run (onboarding incomplete): opens model onboarding wizard
 * - Completed onboarding + unauthenticated providers: opens Settings → Authentication
 * - Already configured: no auto-open
 */
export function useAuthOnboarding({
  projectId,
  openModelOnboarding,
  openSettings,
}: UseAuthOnboardingOptions): void {
  // One-shot guard: prevents the auto-trigger logic from running more than once
  // per hook instance, even if the effect re-runs due to dependency changes.
  const hasTriggeredRef = useRef(false);

  useEffect(() => {
    // Skip if we've already triggered (one-shot guard)
    if (hasTriggeredRef.current) return;
    // Mark as triggered immediately to prevent any race condition on re-runs
    hasTriggeredRef.current = true;

    let shouldOpenOnboarding = false;
    let shouldOpenSettings = false;

    fetchAuthStatus()
      .then(({ providers }) => {
        const hasAuthenticatedProvider = providers.some((provider) => provider.authenticated);
        const needsSetup = providers.length > 0 && !hasAuthenticatedProvider;

        if (needsSetup || (providers.length > 0 && hasAuthenticatedProvider)) {
          return fetchGlobalSettings()
            .then((globalSettings) => {
              const hasDefaultModel = !!(
                globalSettings.defaultProvider && globalSettings.defaultModelId
              );
              // Explicit first-run detection: onboarding is incomplete when
              // modelOnboardingComplete is false or undefined
              const onboardingIncomplete =
                globalSettings.modelOnboardingComplete === false ||
                globalSettings.modelOnboardingComplete === undefined;
              const setupIncomplete = !hasAuthenticatedProvider || !hasDefaultModel;

              if (onboardingIncomplete && setupIncomplete) {
                shouldOpenOnboarding = true;
              } else if (!hasAuthenticatedProvider) {
                // Completed onboarding but no authenticated provider → fallback
                // to Settings Authentication section
                shouldOpenSettings = true;
              }
            });
        }
      })
      .then(() => {
        // Execute after the promise chain resolves
        if (shouldOpenOnboarding) {
          openModelOnboarding();
        } else if (shouldOpenSettings) {
          openSettings("authentication");
        }
      })
      .catch(() => {
        // Fail silently - non-blocking behavior preserves dashboard usability.
        // Onboarding can be manually triggered later via Settings if needed.
      });
  }, [projectId, openModelOnboarding, openSettings]);
}
