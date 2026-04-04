import { useState, useEffect, useCallback, useRef } from "react";
import { X, Loader2, CheckCircle, Key, Zap } from "lucide-react";
import type { AuthProvider, ModelInfo } from "../api";
import {
  fetchAuthStatus,
  loginProvider,
  logoutProvider,
  saveApiKey,
  clearApiKey,
  fetchModels,
  updateGlobalSettings,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import { CustomModelDropdown } from "./CustomModelDropdown";

export interface ModelOnboardingModalProps {
  /** Called when onboarding is complete or dismissed */
  onComplete: () => void;
  /** Toast helper */
  addToast: (message: string, type?: ToastType) => void;
}

type OnboardingStep = "providers" | "model" | "complete";

/**
 * First-run onboarding modal that guides users through:
 * 1. Provider credential setup (OAuth login or API key entry)
 * 2. Default model selection
 *
 * Dismissing the modal marks onboarding as complete to prevent repeated popups.
 */
export function ModelOnboardingModal({
  onComplete,
  addToast,
}: ModelOnboardingModalProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [step, setStep] = useState<OnboardingStep>("providers");
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [authLoading, setAuthLoading] = useState(true);
  const [authActionInProgress, setAuthActionInProgress] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeyErrors, setApiKeyErrors] = useState<Record<string, string>>({});
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Check if we can skip the providers step (already authenticated)
  const hasAuthenticatedProvider = authProviders.some((p) => p.authenticated);

  // Auto-advance to model step when provider is authenticated
  useEffect(() => {
    if (!authLoading && hasAuthenticatedProvider && step === "providers") {
      // Small delay to let the user see the success state
      const timer = setTimeout(() => setStep("model"), 600);
      return () => clearTimeout(timer);
    }
  }, [authLoading, hasAuthenticatedProvider, step]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

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
  const handleModelSelect = useCallback(
    (value: string) => {
      setSelectedModel(value);
    },
    [],
  );

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
    } catch (err: unknown) {
      addToast(
        err instanceof Error ? err.message : "Failed to save settings",
        "error",
      );
    } finally {
      setSaving(false);
    }
  }, [selectedModel, availableModels, addToast]);

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
            {step === "providers" && (
              <>
                <Zap size={24} /> Set Up AI Provider
              </>
            )}
            {step === "model" && (
              <>
                <Zap size={24} /> Choose Default Model
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

        {/* Step indicator */}
        <div className="model-onboarding-steps">
          <div
            className={`model-onboarding-step-indicator${step === "providers" ? " active" : ""}${step === "model" || step === "complete" ? " done" : ""}`}
          >
            <span className="step-number">1</span>
            <span className="step-label">Connect Provider</span>
          </div>
          <div className="model-onboarding-step-connector" />
          <div
            className={`model-onboarding-step-indicator${step === "model" ? " active" : ""}${step === "complete" ? " done" : ""}`}
          >
            <span className="step-number">2</span>
            <span className="step-label">Select Model</span>
          </div>
        </div>

        {/* Content */}
        <div className="model-onboarding-content">
          {step === "providers" && (
            <div className="model-onboarding-providers">
              <p className="model-onboarding-description">
                Connect at least one AI provider to start running tasks.
                {oauthProviders.length > 0 &&
                  apiKeyProviders.length > 0 &&
                  " OAuth providers open a browser for login; API key providers need a key from the provider's dashboard."}
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
                  {oauthProviders.map((provider) => (
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
                  {apiKeyProviders.map((provider) => (
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
            </div>
          )}

          {step === "model" && (
            <div className="model-onboarding-model">
              <p className="model-onboarding-description">
                Select the default model Fusion will use for AI tasks. You can
                change this later in Settings.
              </p>

              {availableModels.length === 0 ? (
                <div className="model-onboarding-empty">
                  No models available. Please check your provider configuration.
                  <button
                    className="btn btn-sm"
                    style={{ marginTop: 8 }}
                    onClick={() => setStep("providers")}
                  >
                    ← Back to Providers
                  </button>
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
                    {availableModels.find((m) => m.id === selectedModel)?.name ??
                      selectedModel}
                  </small>
                </div>
              )}
            </div>
          )}

          {step === "complete" && (
            <div className="model-onboarding-complete">
              <CheckCircle size={48} className="success-icon" />
              <p>
                You're ready to start using Fusion! You can always change your
                model and provider settings from the Settings panel.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="model-onboarding-footer">
          {step === "providers" && (
            <>
              <button
                className="btn btn-sm"
                onClick={handleDismiss}
                disabled={saving}
              >
                Skip for now
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  // Fetch models now that provider is authenticated
                  loadModels();
                  setStep("model");
                }}
                disabled={!hasAuthenticatedProvider}
              >
                Continue →
              </button>
            </>
          )}

          {step === "model" && (
            <>
              <button
                className="btn btn-sm"
                onClick={() => setStep("providers")}
              >
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
                  "Complete Setup"
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
