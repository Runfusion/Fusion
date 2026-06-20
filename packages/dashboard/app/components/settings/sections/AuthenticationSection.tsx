import type { Dispatch, SetStateAction } from "react";
import type { AuthProvider, ManualOAuthCodeInfo, OAuthDeviceCodeInfo } from "../../../api";
import type { ToastType } from "../../../hooks/useToast";
import { useTranslation } from "react-i18next";
import { ClaudeCliProviderCard } from "../../ClaudeCliProviderCard";
import { CursorCliProviderCard } from "../../CursorCliProviderCard";
import { LlamaCppProviderCard } from "../../LlamaCppProviderCard";
import { ProviderIcon } from "../../ProviderIcon";
import { PluginSlot } from "../../PluginSlot";
import { LoginInstructions } from "../../LoginInstructions";
import { OAuthManualCodeForm } from "../../OAuthManualCodeForm";
import { CustomProvidersSection } from "../../CustomProvidersSection";
import { copyTextToClipboard } from "../../../utils/copyToClipboard";
import { appendTokenQuery } from "../../../auth";
export interface AuthenticationSectionData {
    projectId?: string;
    addToast: (message: string, type?: ToastType) => void;
    authProviders: AuthProvider[];
    authLoading: boolean;
    authActionInProgress: string | null;
    apiKeyInputs: Record<string, string>;
    setApiKeyInputs: Dispatch<SetStateAction<Record<string, string>>>;
    apiKeyErrors: Record<string, string>;
    opencodeApiKeyRefreshStatus: Record<string, {
        tone: "success" | "error";
        message: string;
    }>;
    deviceCodes: Record<string, OAuthDeviceCodeInfo>;
    loginInstructions: Record<string, string>;
    manualCodeConfigs: Record<string, ManualOAuthCodeInfo>;
    manualCodeInputs: Record<string, string>;
    setManualCodeInputs: Dispatch<SetStateAction<Record<string, string>>>;
    manualCodeSubmitInProgress: string | null;
    loadAuthStatus: () => void | Promise<void>;
    handleLogin: (providerId: string) => void;
    handleLogout: (providerId: string) => void;
    handleCancelLogin: (providerId: string) => void;
    handleSaveApiKey: (providerId: string) => void;
    handleClearApiKey: (providerId: string) => void;
    handleSubmitManualCode: (providerId: string) => void | Promise<void>;
    onReopenOnboarding?: () => void;
}
export interface AuthenticationSectionProps {
    auth: AuthenticationSectionData;
}
export function AuthenticationSection({ auth }: AuthenticationSectionProps) {
    const { t } = useTranslation("app");
    const { projectId, addToast, authProviders, authLoading, authActionInProgress, apiKeyInputs, setApiKeyInputs, apiKeyErrors, opencodeApiKeyRefreshStatus, deviceCodes, loginInstructions, manualCodeConfigs, manualCodeInputs, setManualCodeInputs, manualCodeSubmitInProgress, loadAuthStatus, handleLogin, handleLogout, handleCancelLogin, handleSaveApiKey, handleClearApiKey, handleSubmitManualCode, onReopenOnboarding, } = auth;
    // CLI-backed providers render their own compact card; filter them out of the
    // standard OAuth/API-key sort and render alongside.
    const cliAuthProviders = authProviders.filter((p) => p.type === "cli");
    const nonCliProviders = authProviders.filter((p) => p.type !== "cli");
    const sortedProviders = [...nonCliProviders].sort((a, b) => {
        if (a.authenticated !== b.authenticated) {
            return a.authenticated ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
    const authenticatedProviders = sortedProviders.filter((p) => p.authenticated);
    const unauthenticatedProviders = sortedProviders.filter((p) => !p.authenticated);
    const claudeCliProvider = cliAuthProviders.find((p) => p.id === "claude-cli");
    const cursorCliProvider = cliAuthProviders.find((p) => p.id === "cursor-cli");
    const llamaCppProvider = cliAuthProviders.find((p) => p.id === "llama-cpp");
    const claudeCliCard = claudeCliProvider ? (<ClaudeCliProviderCard compact authenticated={claudeCliProvider.authenticated} onToggled={() => {
            void loadAuthStatus();
        }}/>) : null;
    const cursorCliCard = cursorCliProvider ? (<CursorCliProviderCard compact authenticated={cursorCliProvider.authenticated} onToggled={() => {
            void loadAuthStatus();
        }}/>) : null;
    const llamaCppCard = llamaCppProvider ? (<LlamaCppProviderCard compact authenticated={llamaCppProvider.authenticated} onToggled={() => {
            void loadAuthStatus();
        }}/>) : null;
    const showAuthenticatedGroup = authenticatedProviders.length > 0 ||
        (claudeCliProvider?.authenticated ?? false) ||
        (cursorCliProvider?.authenticated ?? false) ||
        (llamaCppProvider?.authenticated ?? false);
    const showAvailableGroup = unauthenticatedProviders.length > 0 ||
        (claudeCliProvider && !claudeCliProvider.authenticated) ||
        (cursorCliProvider && !cursorCliProvider.authenticated) ||
        (llamaCppProvider && !llamaCppProvider.authenticated);
    return (<>
      <h4 className="settings-section-heading">{t("settings.auth.title", "Authentication")}</h4>
      {authLoading ? (<div className="settings-empty-state">{t("settings.auth.loadingStatus", "Loading authentication status…")}</div>) : authProviders.length === 0 ? (<div className="settings-empty-state settings-muted">
          {t("settings.auth.noProviders", "No providers available")}
        </div>) : (<div className="auth-panel-body">
          <PluginSlot slotId="settings-provider-card" projectId={projectId} renderPlaceholder={false} actions={{ refreshAuthProviders: () => { void loadAuthStatus(); } }}/>
          <PluginSlot slotId="settings-integration-card" projectId={projectId} renderPlaceholder={false} actions={{ refreshAuthProviders: () => { void loadAuthStatus(); } }}/>
          {!showAuthenticatedGroup && (<div className="auth-section-hint">
              {t("settings.auth.signInHint", "Sign in to at least one provider to get started with AI models.")}
            </div>)}
          {showAuthenticatedGroup && (<div className="auth-provider-group">
              <div className="auth-group-label">{t("settings.auth.groupAuthenticated", "Authenticated")}</div>
              {claudeCliProvider?.authenticated && claudeCliCard}
              {cursorCliProvider?.authenticated && cursorCliCard}
              {llamaCppProvider?.authenticated && llamaCppCard}
              {authenticatedProviders.map((provider) => (<div key={provider.id} className="auth-provider-card auth-provider-card--authenticated">
                  <div className="auth-provider-header">
                    <div className="auth-provider-info">
                      {/* Stable icon wrapper contract for auth card tests: auth-provider-icon-<providerId> */}
                      <span className="auth-provider-icon-slot" data-testid={`auth-provider-icon-${provider.id}`} aria-hidden="true">
                        <ProviderIcon provider={provider.id} size="md"/>
                      </span>
                      <strong>{provider.name}</strong>
                      <span data-testid={`auth-status-${provider.id}`} className={`auth-status-badge ${provider.authenticated ? "authenticated" : "not-authenticated"}`}>
                        {t("settings.auth.statusActive", "✓ Active")}
                      </span>
                      {provider.authenticated && provider.keyHint && (<span className="auth-key-hint">{t("settings.authentication.key", "Key: ")}{provider.keyHint}</span>)}
                    </div>
                    {provider.type === "api_key" ? (<div className="auth-apikey-section">
                        <div className="auth-apikey-input-row">
                          <input type="password" className="auth-apikey-input" placeholder={t("settings.authentication.enterAPIKey", "Enter API key")} value={apiKeyInputs[provider.id] ?? ""} onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))} disabled={authActionInProgress === provider.id}/>
                          {provider.authenticated && !apiKeyInputs[provider.id] ? (<button className="btn btn-sm" onClick={() => handleClearApiKey(provider.id)} disabled={authActionInProgress === provider.id}>
                              {t("settings.auth.clearKey", "Clear")}
                            </button>) : (<button className="btn btn-primary btn-sm" onClick={() => handleSaveApiKey(provider.id)} disabled={authActionInProgress === provider.id}>
                              {t("settings.actions.save", "Save")}
                            </button>)}
                        </div>
                        {authActionInProgress === provider.id && (<small className="auth-apikey-progress">{t("settings.auth.savingKey", "Saving…")}</small>)}
                        {apiKeyErrors[provider.id] && (<small className="auth-apikey-error">{apiKeyErrors[provider.id]}</small>)}
                        {(provider.id === "opencode" || provider.id === "opencode-go") && opencodeApiKeyRefreshStatus[provider.id] && (<small className={opencodeApiKeyRefreshStatus[provider.id].tone === "error" ? "form-error" : "text-muted"}>
                            {opencodeApiKeyRefreshStatus[provider.id].message}
                          </small>)}
                      </div>) : (<div>
                        {authActionInProgress === provider.id ? (<button className="btn btn-sm" disabled>
                            {t("settings.auth.loggingOut", "Logging out…")}
                          </button>) : provider.loginInProgress ? (<div className="auth-provider-actions-row">
                            <button className="btn btn-sm" disabled>
                              {t("settings.auth.waitingForLogin", "Waiting for login…")}
                            </button>
                            <button className="btn btn-sm" onClick={() => handleCancelLogin(provider.id)}>
                              {t("settings.actions.cancel", "Cancel")}
                            </button>
                          </div>) : (<button className="btn btn-sm" onClick={() => handleLogout(provider.id)}>
                            {t("settings.auth.logout", "Logout")}
                          </button>)}
                      </div>)}
                  </div>
                </div>))}
            </div>)}
          {showAvailableGroup && (<div className="auth-provider-group">
              <div className="auth-group-label">{t("settings.auth.groupAvailable", "Available")}</div>
              {claudeCliProvider && !claudeCliProvider.authenticated && claudeCliCard}
              {cursorCliProvider && !cursorCliProvider.authenticated && cursorCliCard}
              {llamaCppProvider && !llamaCppProvider.authenticated && llamaCppCard}
              {unauthenticatedProviders.map((provider) => (<div key={provider.id} className="auth-provider-card">
                  <div className="auth-provider-header">
                    <div className="auth-provider-info">
                      {/* Stable icon wrapper contract for auth card tests: auth-provider-icon-<providerId> */}
                      <span className="auth-provider-icon-slot" data-testid={`auth-provider-icon-${provider.id}`} aria-hidden="true">
                        <ProviderIcon provider={provider.id} size="md"/>
                      </span>
                      <strong>{provider.name}</strong>
                      <span data-testid={`auth-status-${provider.id}`} className={`auth-status-badge ${provider.authenticated ? "authenticated" : "not-authenticated"}`}>
                        {t("settings.auth.statusNotConnected", "✗ Not connected")}
                      </span>
                    </div>
                    {provider.type === "api_key" ? (<div className="auth-apikey-section">
                        <div className="auth-apikey-input-row">
                          <input type="password" className="auth-apikey-input" placeholder={t("settings.authentication.enterAPIKey", "Enter API key")} value={apiKeyInputs[provider.id] ?? ""} onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))} disabled={authActionInProgress === provider.id}/>
                          <button className="btn btn-primary btn-sm" onClick={() => handleSaveApiKey(provider.id)} disabled={authActionInProgress === provider.id}>
                            {t("settings.actions.save", "Save")}
                          </button>
                        </div>
                        {authActionInProgress === provider.id && (<small className="auth-apikey-progress">{t("settings.auth.savingKey", "Saving…")}</small>)}
                        {apiKeyErrors[provider.id] && (<small className="auth-apikey-error">{apiKeyErrors[provider.id]}</small>)}
                        {(provider.id === "opencode" || provider.id === "opencode-go") && opencodeApiKeyRefreshStatus[provider.id] && (<small className={opencodeApiKeyRefreshStatus[provider.id].tone === "error" ? "form-error" : "text-muted"}>
                            {opencodeApiKeyRefreshStatus[provider.id].message}
                          </small>)}
                      </div>) : (<div>
                        {authActionInProgress === provider.id ? (<button className="btn btn-sm" disabled>
                            {t("settings.auth.waitingForLogin", "Waiting for login…")}
                          </button>) : provider.loginInProgress ? (<div className="auth-provider-actions-row">
                            <button className="btn btn-sm" disabled>
                              {t("settings.auth.waitingForLogin", "Waiting for login…")}
                            </button>
                            <button className="btn btn-sm" onClick={() => handleCancelLogin(provider.id)}>
                              {t("settings.actions.cancel", "Cancel")}
                            </button>
                          </div>) : (<button className="btn btn-primary btn-sm" onClick={() => handleLogin(provider.id)}>
                            {t("settings.auth.login", "Login")}
                          </button>)}
                        {provider.id === "github-copilot" && deviceCodes[provider.id] && (provider.loginInProgress || authActionInProgress === provider.id) && (<div className="auth-device-code-panel" data-testid={`auth-device-code-${provider.id}`}>
                            <strong>{t("settings.auth.enterCodeOnGitHub", "Enter this code on GitHub")}</strong>
                            <div className="auth-device-code-pill">{deviceCodes[provider.id].userCode}</div>
                            <div className="auth-provider-actions-row">
                              <button className="btn btn-sm" onClick={() => {
                                void (async () => {
                                    const copied = await copyTextToClipboard(deviceCodes[provider.id].userCode);
                                    if (copied) {
                                        addToast(t("settings.auth.copiedCodeToClipboard", "Copied code to clipboard"), "success");
                                        return;
                                    }
                                    addToast(t("settings.auth.failedToCopyCode", "Failed to copy code — copy it manually from the box above"), "error");
                                })();
                            }}>
                                {t("settings.auth.copyCode", "Copy code")}
                              </button>
                              <button className="btn btn-sm" onClick={() => window.open(appendTokenQuery(deviceCodes[provider.id].verificationUri), "_blank")}>
                                {t("settings.auth.openGitHub", "Open GitHub")}
                              </button>
                            </div>
                          </div>)}
                        {loginInstructions[provider.id] && (provider.loginInProgress || authActionInProgress === provider.id) && (<LoginInstructions instructions={loginInstructions[provider.id]} data-testid={`auth-login-instructions-${provider.id}`}/>)}
                        {manualCodeConfigs[provider.id] && (provider.loginInProgress || authActionInProgress === provider.id) && (<OAuthManualCodeForm value={manualCodeInputs[provider.id] ?? ""} onChange={(value) => setManualCodeInputs((prev) => ({ ...prev, [provider.id]: value }))} onSubmit={() => void handleSubmitManualCode(provider.id)} prompt={manualCodeConfigs[provider.id].prompt} placeholder={manualCodeConfigs[provider.id].placeholder} helpText={manualCodeConfigs[provider.id].helpText} disabled={manualCodeSubmitInProgress === provider.id} submitLabel={manualCodeSubmitInProgress === provider.id ? "Submitting…" : "Submit code"} data-testid={`auth-manual-code-${provider.id}`}/>)}
                      </div>)}
                  </div>
                </div>))}
            </div>)}
        </div>)}
      <small className="auth-hint">
        {t("settings.auth.hint", "Authentication changes take effect immediately — no need to save.")}
      </small>
      {onReopenOnboarding && (<div className="form-group" style={{ marginTop: "var(--space-md)" }}>
          <button type="button" className="btn btn-sm" onClick={onReopenOnboarding}>
            {t("settings.auth.reopenOnboarding", "Reopen onboarding guide")}
          </button>
          <small className="settings-muted">
            {t("settings.auth.reopenOnboardingHint", "Re-run the setup wizard to review or update your AI provider and model configuration.")}
          </small>
        </div>)}

      <CustomProvidersSection />
    </>);
}
export default AuthenticationSection;
