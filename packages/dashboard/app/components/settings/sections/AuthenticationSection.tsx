import type { Dispatch, SetStateAction } from "react";
import type { AuthProvider, ManualOAuthCodeInfo, OAuthDeviceCodeInfo } from "../../../api";
import type { ToastType } from "../../../hooks/useToast";
import { useTranslation } from "react-i18next";
import { ClaudeCliProviderCard } from "../../ClaudeCliProviderCard";
import { CursorCliProviderCard } from "../../CursorCliProviderCard";
import { GrokCliProviderCard } from "../../GrokCliProviderCard";
import { LlamaCppProviderCard } from "../../LlamaCppProviderCard";
import { ProviderIcon } from "../../ProviderIcon";
import { PluginSlot } from "../../PluginSlot";
import { LoginInstructions } from "../../LoginInstructions";
import { LoadingSpinner } from "../../LoadingSpinner";
import { OAuthManualCodeForm } from "../../OAuthManualCodeForm";
import { CustomProvidersSection } from "../../CustomProvidersSection";
import { copyTextToClipboard } from "../../../utils/copyToClipboard";
import { appendTokenQuery } from "../../../auth";
import { refreshModelsCache } from "../../../hooks/useModelsCache";
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
const ANTHROPIC_AUTH_PROVIDER_PRIORITY: Record<string, number> = {
    "claude-cli": 0,
    "anthropic-subscription": 1,
    "anthropic-api-key": 2,
    anthropic: 3,
};
const getAuthProviderPriority = (provider: AuthProvider) => ANTHROPIC_AUTH_PROVIDER_PRIORITY[provider.id] ?? Number.POSITIVE_INFINITY;
/*
FNXC:ProviderAuth 2026-07-02-11:26:
Settings groups Anthropic-family auth surfaces near the top so the Claude CLI, subscription OAuth, and API-key paths stay discoverable after the provider split while each Authenticated/Available group keeps its own boundary.
*/
const compareAuthProviderDisplayOrder = (a: AuthProvider, b: AuthProvider) => {
    if (a.authenticated !== b.authenticated) {
        return a.authenticated ? -1 : 1;
    }
    const aPriority = getAuthProviderPriority(a);
    const bPriority = getAuthProviderPriority(b);
    if (aPriority !== bPriority) {
        return aPriority - bPriority;
    }
    const nameDelta = a.name.localeCompare(b.name);
    if (nameDelta !== 0) {
        return nameDelta;
    }
    return a.id.localeCompare(b.id);
};
export function AuthenticationSection({ auth }: AuthenticationSectionProps) {
    const { t } = useTranslation("app");
    const { projectId, addToast, authProviders, authLoading, authActionInProgress, apiKeyInputs, setApiKeyInputs, apiKeyErrors, opencodeApiKeyRefreshStatus, deviceCodes, loginInstructions, manualCodeConfigs, manualCodeInputs, setManualCodeInputs, manualCodeSubmitInProgress, loadAuthStatus, handleLogin, handleLogout, handleCancelLogin, handleSaveApiKey, handleClearApiKey, handleSubmitManualCode, onReopenOnboarding, } = auth;
    const hasSeparatedAnthropicProvider = authProviders.some((p) => p.id === "anthropic-subscription" || p.id === "anthropic-api-key");
    /*
    FNXC:ProviderAuth 2026-06-29-23:50:
    Settings must render Anthropic subscription OAuth and raw Anthropic API-key auth as separate cards; when a mixed/legacy status payload includes the old `anthropic` OAuth id alongside separated cards, hide the legacy card so users never see two OAuth-looking Anthropic entries or a resurrected dual-card surface.
    */
    const visibleAuthProviders = hasSeparatedAnthropicProvider
        ? authProviders.filter((p) => p.id !== "anthropic")
        : authProviders;
    const isSupportedCliProvider = (provider: AuthProvider) => provider.id === "claude-cli" || provider.id === "cursor-cli" || provider.id === "grok-cli" || provider.id === "llama-cpp";
    /*
    FNXC:ProviderAuth 2026-07-02-12:20:
    Authentication ordering must sort supported CLI and non-CLI provider cards in one list so Cursor CLI or llama.cpp cannot split Claude CLI from Anthropic subscription/API-key entries.
    */
    const sortedProviders = [...visibleAuthProviders]
        .filter((p) => p.type !== "cli" || isSupportedCliProvider(p))
        .sort(compareAuthProviderDisplayOrder);
    const authenticatedProviders = sortedProviders.filter((p) => p.authenticated);
    const unauthenticatedProviders = sortedProviders.filter((p) => !p.authenticated);
    /*
    FNXC:ModelCatalog 2026-07-08-00:00:
    FN-7710: A CLI provider toggle (Cursor, Grok, Claude CLI, llama.cpp) must refresh the
    shared model catalog so newly-enabled/disabled `*-cli` models appear in — or disappear
    from — every live picker (Quick Entry, Task Detail, New Agent, Workflow editor, etc.)
    without the user needing to navigate to Settings. `onToggled` previously only called
    `loadAuthStatus()`, which refreshes this panel's own provider list but never touches the
    shared `useModelsCache()` cache other pickers read from. All four CLI cards share this one
    `onToggled` handler so the fix applies uniformly — no per-card duplication — and both the
    enable and disable transitions call it (the cards invoke `onToggled` on every toggle result).
    */
    const handleCliProviderToggled = () => {
        void loadAuthStatus();
        void refreshModelsCache();
    };
    const renderCliProviderCard = (provider: AuthProvider) => {
        if (provider.id === "claude-cli") {
            return (<ClaudeCliProviderCard key={provider.id} compact authenticated={provider.authenticated} onToggled={handleCliProviderToggled}/>);
        }
        if (provider.id === "cursor-cli") {
            return (<CursorCliProviderCard key={provider.id} compact authenticated={provider.authenticated} onToggled={handleCliProviderToggled}/>);
        }
        if (provider.id === "grok-cli") {
            return (<GrokCliProviderCard key={provider.id} compact authenticated={provider.authenticated} onToggled={handleCliProviderToggled}/>);
        }
        return (<LlamaCppProviderCard key={provider.id} compact authenticated={provider.authenticated} onToggled={handleCliProviderToggled}/>);
    };
    const showAuthenticatedGroup = authenticatedProviders.length > 0;
    const showAvailableGroup = unauthenticatedProviders.length > 0;
    const providerSupportsApiKey = (provider: AuthProvider) => provider.type === "api_key";
    const renderApiKeySection = (provider: AuthProvider) => (<div className="auth-apikey-section">
      <div className="auth-apikey-input-row">
        <input type="password" className="auth-apikey-input" placeholder={t("settings.authentication.enterAPIKey", "Enter API key")} value={apiKeyInputs[provider.id] ?? ""} onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))} disabled={authActionInProgress === provider.id}/>
        {provider.keyHint && !apiKeyInputs[provider.id] ? (<button className="btn btn-sm" onClick={() => handleClearApiKey(provider.id)} disabled={authActionInProgress === provider.id}>
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
    </div>);
    const renderAuthenticatedOAuthActions = (provider: AuthProvider) => (<div>
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
    </div>);
    const renderAvailableOAuthActions = (provider: AuthProvider) => (<div>
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
      {manualCodeConfigs[provider.id] && (provider.loginInProgress || authActionInProgress === provider.id) && (<OAuthManualCodeForm value={manualCodeInputs[provider.id] ?? ""} onChange={(value) => setManualCodeInputs((prev) => ({ ...prev, [provider.id]: value }))} onSubmit={() => void handleSubmitManualCode(provider.id)} prompt={manualCodeConfigs[provider.id].prompt} placeholder={manualCodeConfigs[provider.id].placeholder} helpText={manualCodeConfigs[provider.id].helpText} disabled={manualCodeSubmitInProgress === provider.id} submitLabel={manualCodeSubmitInProgress === provider.id ? "Submitting…" : "Submit code"} data-testid={`auth-manual-code-${provider.id}`}/>)}</div>);
    /*
    FNXC:ProviderAuth 2026-06-29-22:18:
    Settings must render Anthropic subscription OAuth and raw Anthropic API-key auth as separate provider cards.
    Only `type: "api_key"` cards show key controls so OAuth logout never looks like it will clear `ANTHROPIC_API_KEY`.
    */
    return (<>
      <h4 className="settings-section-heading">{t("settings.auth.title", "Authentication")}</h4>
      {authLoading ? (<div className="settings-empty-state"><LoadingSpinner label={t("settings.auth.loadingStatus", "Loading authentication status…")} /></div>) : authProviders.length === 0 ? (<div className="settings-empty-state settings-muted">
          {t("settings.auth.noProviders", "No providers available")}
        </div>) : (<div className="auth-panel-body">
          <PluginSlot slotId="settings-provider-card" projectId={projectId} renderPlaceholder={false} actions={{ refreshAuthProviders: () => { void loadAuthStatus(); } }}/>
          <PluginSlot slotId="settings-integration-card" projectId={projectId} renderPlaceholder={false} actions={{ refreshAuthProviders: () => { void loadAuthStatus(); } }}/>
          {!showAuthenticatedGroup && (<div className="auth-section-hint">
              {t("settings.auth.signInHint", "Sign in to at least one provider to get started with AI models.")}
            </div>)}
          {showAuthenticatedGroup && (<div className="auth-provider-group">
              <div className="auth-group-label">{t("settings.auth.groupAuthenticated", "Authenticated")}</div>
              {authenticatedProviders.map((provider) => provider.type === "cli" ? renderCliProviderCard(provider) : (<div key={provider.id} className="auth-provider-card auth-provider-card--authenticated">
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
                    {provider.type !== "api_key" && renderAuthenticatedOAuthActions(provider)}
                    {providerSupportsApiKey(provider) && renderApiKeySection(provider)}
                  </div>
                </div>))}
            </div>)}
          {showAvailableGroup && (<div className="auth-provider-group">
              <div className="auth-group-label">{t("settings.auth.groupAvailable", "Available")}</div>
              {unauthenticatedProviders.map((provider) => provider.type === "cli" ? renderCliProviderCard(provider) : (<div key={provider.id} className="auth-provider-card">
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
                      {provider.keyHint && (<span className="auth-key-hint">{t("settings.authentication.key", "Key: ")}{provider.keyHint}</span>)}
                    </div>
                    {provider.type !== "api_key" && renderAvailableOAuthActions(provider)}
                    {providerSupportsApiKey(provider) && renderApiKeySection(provider)}
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
