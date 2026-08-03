import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { formatProviderInstanceKey, removeProviderInstance, renameProviderInstance, setProviderDefaultInstance, newProviderInstanceId } from "../../../api";
import type { AuthProvider, ManualOAuthCodeInfo, OAuthDeviceCodeInfo, ProviderCredentialInstance } from "../../../api";
import type { ToastType } from "../../../hooks/useToast";
import { useTranslation } from "react-i18next";
import { ClaudeCliProviderCard } from "../../ClaudeCliProviderCard";
import { CursorCliProviderCard } from "../../CursorCliProviderCard";
import { GrokCliProviderCard } from "../../GrokCliProviderCard";
import { OmpCliProviderCard } from "../../OmpCliProviderCard";
import { LlamaCppProviderCard } from "../../LlamaCppProviderCard";
import { ProviderIcon } from "../../ProviderIcon";
import { PluginSlot } from "../../PluginSlot";
import { LoginInstructions } from "../../LoginInstructions";
import { LoadingSpinner } from "../../LoadingSpinner";
import { OAuthManualCodeForm } from "../../OAuthManualCodeForm";
import { CustomProvidersSection } from "../../CustomProvidersSection";
import { SettingsHelpTip } from "../SettingsHelpTip";
import { SettingsSelectRow } from "../SettingsSelectRow";
import type { SectionBaseProps } from "./context";
import { copyTextToClipboard } from "../../../utils/copyToClipboard";
import { appendTokenQuery } from "../../../auth";
import { openExternalUrl } from "../../../utils/open-external";
import { refreshModelsCache } from "../../../hooks/useModelsCache";
import "./AuthenticationSection.css";
export interface AuthenticationSectionData {
    projectId?: string;
    addToast: (message: string, type?: ToastType) => void;
    authProviders: AuthProvider[];
    authLoading: boolean;
    authActionInProgress: string | null | Record<string, boolean>;
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
    handleLogin: (providerId: string, instanceId?: string, label?: string) => void;
    handleLogout: (providerId: string, instanceId?: string) => void;
    handleCancelLogin: (providerId: string, instanceId?: string) => void;
    handleSaveApiKey: (providerId: string, instanceId?: string, label?: string) => void;
    handleClearApiKey: (providerId: string, instanceId?: string) => void;
    handleSubmitManualCode: (providerId: string, instanceId?: string) => void | Promise<void>;
    onReopenOnboarding?: () => void;
}
export interface AuthenticationSectionProps {
    auth: AuthenticationSectionData;
    /** Shell-owned settings form; used only for the Anthropic credential-precedence row. */
    form?: SectionBaseProps["form"];
    setForm?: SectionBaseProps["setForm"];
}
const ANTHROPIC_API_KEY_PROVIDER_ID = "anthropic-api-key";
const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";
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
export function AuthenticationSection({ auth, form, setForm }: AuthenticationSectionProps) {
    const { t } = useTranslation("app");
    const { projectId, addToast, authProviders, authLoading, authActionInProgress, apiKeyInputs, setApiKeyInputs, apiKeyErrors, opencodeApiKeyRefreshStatus, deviceCodes, loginInstructions, manualCodeConfigs, manualCodeInputs, setManualCodeInputs, manualCodeSubmitInProgress, loadAuthStatus, handleLogin, handleLogout, handleCancelLogin, handleSaveApiKey, handleClearApiKey, handleSubmitManualCode, onReopenOnboarding, } = auth;
    const [pendingInstances, setPendingInstances] = useState<Record<string, { instanceId: string; label: string }>>({});
    const isAuthActionActive = (stateKey: string) => typeof authActionInProgress === "string"
        ? authActionInProgress === stateKey
        : Boolean(authActionInProgress?.[stateKey]);
    const hasSeparatedAnthropicProvider = authProviders.some((p) => p.id === "anthropic-subscription" || p.id === "anthropic-api-key");
    /*
    FNXC:ProviderAuth 2026-06-29-23:50:
    Settings must render Anthropic subscription OAuth and raw Anthropic API-key auth as separate cards; when a mixed/legacy status payload includes the old `anthropic` OAuth id alongside separated cards, hide the legacy card so users never see two OAuth-looking Anthropic entries or a resurrected dual-card surface.
    */
    const visibleAuthProviders = hasSeparatedAnthropicProvider
        ? authProviders.filter((p) => p.id !== "anthropic")
        : authProviders;
    // FNXC:OmpAcp 2026-07-13-22:50: include omp-cli among supported CLI auth cards.
    const isSupportedCliProvider = (provider: AuthProvider) => provider.id === "claude-cli" || provider.id === "cursor-cli" || provider.id === "grok-cli" || provider.id === "omp-cli" || provider.id === "llama-cpp";
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
        if (provider.id === "omp-cli") {
            return (<OmpCliProviderCard key={provider.id} compact authenticated={provider.authenticated} onToggled={handleCliProviderToggled}/>);
        }
        return (<LlamaCppProviderCard key={provider.id} compact authenticated={provider.authenticated} onToggled={handleCliProviderToggled}/>);
    };
    /*
    FNXC:ProviderAuth 2026-07-24-17:05:
    Anthropic is the one provider an operator can hold two live credentials for at once — a
    raw API key AND a Claude subscription OAuth login. Runtime auth has to pick one, and the
    choice was previously invisible: a saved key silently won, so an operator who logged in
    with their subscription but still had a stale/revoked key stored got `401 invalid
    x-api-key` from lanes that call the Anthropic endpoint directly, with nothing on this
    screen explaining why. Surface the conflict where the credentials are managed and let the
    operator pick. The row renders only when BOTH are actually connected — with one credential
    there is nothing to disambiguate and the control would be noise.
    */
    const anthropicApiKeyConnected = authProviders.some((p) => p.id === ANTHROPIC_API_KEY_PROVIDER_ID && p.authenticated);
    const anthropicSubscriptionConnected = authProviders.some((p) => p.id === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID && p.authenticated);
    const showAnthropicPrecedence = Boolean(form && setForm) && anthropicApiKeyConnected && anthropicSubscriptionConnected;
    const anthropicAuthPreference = form?.anthropicAuthPreference === "subscription" ? "subscription" : "api-key";
    const preferenceIsInEffect = (providerId: string) => showAnthropicPrecedence
        && (anthropicAuthPreference === "subscription"
            ? providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID
            : providerId === ANTHROPIC_API_KEY_PROVIDER_ID);
    /*
    Live state, not description: which of two connected credentials the engine will actually
    send. Rendered on the card itself so the answer is where the operator is looking.
    */
    const renderAnthropicPrecedenceBadge = (provider: AuthProvider) => {
        if (!showAnthropicPrecedence) {
            return null;
        }
        if (provider.id !== ANTHROPIC_API_KEY_PROVIDER_ID && provider.id !== ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
            return null;
        }
        return preferenceIsInEffect(provider.id)
            ? (<span className="auth-status-badge authenticated" data-testid={`auth-precedence-active-${provider.id}`}>
          {t("settings.auth.credentialInUse", "In use")}
        </span>)
            : (<span className="auth-key-hint" data-testid={`auth-precedence-overridden-${provider.id}`}>
          {t("settings.auth.credentialOverridden", "Overridden below")}
        </span>);
    };
    const renderAnthropicPrecedenceRow = () => showAnthropicPrecedence
        ? (<SettingsSelectRow descriptor={{
                key: "anthropicAuthPreference",
                label: t("settings.auth.anthropicPreferenceLabel", "Anthropic credential to use"),
                help: t("settings.auth.anthropicPreferenceHint", "You have both an Anthropic API key and a Claude subscription connected. Choose which one Fusion sends when a lane calls Anthropic directly. Default: API key."),
                scope: "global",
                options: [
                    { value: "api-key", label: t("settings.auth.anthropicPreferenceApiKey", "API key") },
                    { value: "subscription", label: t("settings.auth.anthropicPreferenceSubscription", "Claude subscription") },
                ],
            }} value={anthropicAuthPreference} onChange={(value) => setForm?.((f) => ({
                ...f,
                anthropicAuthPreference: value === "subscription" ? "subscription" : "api-key",
            }))}/>)
        : null;
    const showAuthenticatedGroup = authenticatedProviders.length > 0;
    const showAvailableGroup = unauthenticatedProviders.length > 0;
    const providerSupportsApiKey = (provider: AuthProvider) => provider.type === "api_key";
    /*
    FNXC:ProviderAuth 2026-08-01-06:25:
    Keep single and empty cards free of instance-list chrome. Extra account controls appear only
    after a second credential exists; client-generated ids are opaque and labels remain display-only.
    */
    const hasMultipleInstances = (provider: AuthProvider) => (provider.instances?.length ?? 0) > 1;
    const instanceProvider = (provider: AuthProvider, instance: ProviderCredentialInstance): AuthProvider => ({
        ...provider,
        authenticated: instance.authenticated,
        expired: instance.expired,
        keyHint: instance.keyHint,
        instanceId: instance.instanceId,
        type: instance.type ?? provider.type,
        // A provider-level status can only say that some account is logging in; a row is active
        // only when its instance-keyed local state says so.
        loginInProgress: false,
    });
    /*
    FNXC:ProviderAuth 2026-08-01-06:57:
    Multi-account cards render credential actions inside their matching instance row. This prevents
    a legacy provider-level Save, Cancel, or manual-code control from silently targeting default.
    Single and empty cards deliberately retain the existing provider-level markup and behavior.
    */
    const renderInstanceControls = (provider: AuthProvider) => {
        if (provider.type === "cli") return null;
        const instances = provider.instances ?? [];
        const pending = pendingInstances[provider.id];
        const add = () => setPendingInstances((current) => ({
            ...current,
            [provider.id]: { instanceId: newProviderInstanceId(instances.map((item) => item.instanceId)), label: "" },
        }));
        const discard = () => setPendingInstances((current) => {
            const next = { ...current };
            delete next[provider.id];
            return next;
        });
        return <div className="auth-instance-controls">
          {instances.length > 1 && <div className="auth-instance-list" data-testid={`auth-instances-${provider.id}`}>
            {instances.map((item: ProviderCredentialInstance) => {
              const rowProvider = instanceProvider(provider, item);
              return <div className="auth-instance-row" key={item.instanceId}>
                <span>{item.label || item.instanceId}{item.isDefault ? ` (${t("settings.auth.default", "Default")})` : ""}</span>
                {!item.isDefault && <button className="btn btn-sm" onClick={() => void setProviderDefaultInstance(provider.id, item.instanceId).then(loadAuthStatus)}>{t("settings.auth.makeDefault", "Make default")}</button>}
                <button className="btn btn-sm" onClick={() => {
                  const label = window.prompt(t("settings.auth.renameAccount", "Account name"), item.label || "");
                  if (label !== null) void renameProviderInstance(provider.id, item.instanceId, label).then(loadAuthStatus);
                }}>{t("settings.actions.rename", "Rename")}</button>
                <button className="btn btn-sm" onClick={() => void removeProviderInstance(provider.id, item.instanceId).then(loadAuthStatus)}>{t("settings.actions.remove", "Remove")}</button>
                {providerSupportsApiKey(rowProvider)
                  ? renderApiKeySection(rowProvider, item.instanceId)
                  : item.authenticated
                    ? renderAuthenticatedOAuthActions(rowProvider, item.instanceId)
                    : renderAvailableOAuthActions(rowProvider, item.instanceId)}
              </div>;
            })}
          </div>}
          {pending && <div className="auth-instance-pending" data-testid={`auth-pending-instance-${provider.id}`}>
            {/*
            FNXC:ProviderAuth 2026-08-02-05:27:
            Each pending credential needs a visible Account name label associated with its provider-specific input. The padded field keeps its purpose separate from credential actions at desktop and mobile widths without changing instance identity or save/login payloads.
            */}
            <div className="auth-pending-instance-field">
              <label className="auth-pending-instance-label" htmlFor={`auth-pending-instance-${provider.id}-label`}>
                {t("settings.auth.accountLabel", "Account name")}
              </label>
              <input id={`auth-pending-instance-${provider.id}-label`} className="input" value={pending.label} onChange={(event) => setPendingInstances((current) => ({ ...current, [provider.id]: { ...pending, label: event.target.value } }))} />
            </div>
            {providerSupportsApiKey(provider)
              ? renderApiKeySection(provider, pending.instanceId, pending.label, true)
              : renderAvailableOAuthActions(provider, pending.instanceId, pending.label || undefined)}
            <button className="btn btn-sm" onClick={discard}>{t("settings.actions.cancel", "Cancel")}</button>
          </div>}
          {!pending && <button className="btn btn-sm" onClick={add}>{t("settings.auth.addAnotherAccount", "Add another account")}</button>}
        </div>;
    };
    /*
    FNXC:ProviderAuth 2026-07-14-15:54:
    Provider authentication failures must remain visible on the affected card. Toasts are transient and can fire while Settings is closed, so render the server's loginError beside the provider actions as the durable re-auth remediation.
    */
    const renderProviderAuthError = (provider: AuthProvider) => provider.loginError
        ? (<small className="form-error" role="alert">{provider.loginError}</small>)
        : null;
    const renderApiKeySection = (provider: AuthProvider, selectedInstanceId?: string, pendingLabel?: string, isPending = false) => {
      const instanceId = selectedInstanceId ?? provider.instanceId;
      const stateKey = formatProviderInstanceKey({ providerId: provider.id, instanceId: instanceId ?? "default" });
      return <div className="auth-apikey-section">
        <div className="auth-apikey-input-row">
          <input type="password" className="auth-apikey-input" placeholder={t("settings.authentication.enterAPIKey", "Enter API key")} value={apiKeyInputs[stateKey] ?? ""} onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [stateKey]: e.target.value }))} disabled={isAuthActionActive(stateKey)}/>
          {provider.keyHint && !isPending && !apiKeyInputs[stateKey] ? <button className="btn btn-sm" onClick={() => instanceId ? handleClearApiKey(provider.id, instanceId) : handleClearApiKey(provider.id)} disabled={isAuthActionActive(stateKey)}>{t("settings.auth.clearKey", "Clear")}</button> : <button className="btn btn-primary btn-sm" onClick={() => instanceId ? handleSaveApiKey(provider.id, instanceId, pendingLabel || undefined) : handleSaveApiKey(provider.id)} disabled={isAuthActionActive(stateKey)}>{t("settings.actions.save", "Save")}</button>}
        </div>
        {isAuthActionActive(stateKey) && <small className="auth-apikey-progress">{t("settings.auth.savingKey", "Saving…")}</small>}
        {apiKeyErrors[stateKey] && <small className="auth-apikey-error">{apiKeyErrors[stateKey]}</small>}
        {(provider.id === "opencode" || provider.id === "opencode-go") && opencodeApiKeyRefreshStatus[stateKey] && <small className={opencodeApiKeyRefreshStatus[stateKey].tone === "error" ? "form-error" : "text-muted"}>{opencodeApiKeyRefreshStatus[stateKey].message}</small>}
      </div>;
    };
    const renderAuthenticatedOAuthActions = (provider: AuthProvider, selectedInstanceId?: string) => {
      const instanceId = selectedInstanceId ?? provider.instanceId;
      const stateKey = formatProviderInstanceKey({ providerId: provider.id, instanceId: instanceId ?? "default" });
      return <div>
        {isAuthActionActive(stateKey) ? <button className="btn btn-sm" disabled>{t("settings.auth.loggingOut", "Logging out…")}</button>
          : provider.loginInProgress ? <div className="auth-provider-actions-row"><button className="btn btn-sm" disabled>{t("settings.auth.waitingForLogin", "Waiting for login…")}</button><button className="btn btn-sm" onClick={() => instanceId ? handleCancelLogin(provider.id, instanceId) : handleCancelLogin(provider.id)}>{t("settings.actions.cancel", "Cancel")}</button></div>
            : <button className="btn btn-sm" onClick={() => instanceId ? handleLogout(provider.id, instanceId) : handleLogout(provider.id)}>{t("settings.auth.logout", "Logout")}</button>}
      </div>;
    };
    const renderAvailableOAuthActions = (provider: AuthProvider, selectedInstanceId?: string, pendingLabel?: string) => {
      const instanceId = selectedInstanceId ?? provider.instanceId;
      const stateKey = formatProviderInstanceKey({ providerId: provider.id, instanceId: instanceId ?? "default" });
      const isActive = provider.loginInProgress || isAuthActionActive(stateKey);
      return <div>
        {isAuthActionActive(stateKey) ? <div className="auth-provider-actions-row"><button className="btn btn-sm" disabled>{t("settings.auth.waitingForLogin", "Waiting for login…")}</button><button className="btn btn-sm" onClick={() => instanceId ? handleCancelLogin(provider.id, instanceId) : handleCancelLogin(provider.id)}>{t("settings.actions.cancel", "Cancel")}</button></div>
          : provider.loginInProgress ? <div className="auth-provider-actions-row"><button className="btn btn-sm" disabled>{t("settings.auth.waitingForLogin", "Waiting for login…")}</button><button className="btn btn-sm" onClick={() => instanceId ? handleCancelLogin(provider.id, instanceId) : handleCancelLogin(provider.id)}>{t("settings.actions.cancel", "Cancel")}</button></div>
            : <button className="btn btn-primary btn-sm" onClick={() => instanceId ? handleLogin(provider.id, instanceId, pendingLabel) : handleLogin(provider.id)}>{t("settings.auth.login", "Login")}</button>}
        {provider.id === "github-copilot" && deviceCodes[stateKey] && isActive && <div className="auth-device-code-panel" data-testid={`auth-device-code-${stateKey}`}>
          <strong>{t("settings.auth.enterCodeOnGitHub", "Enter this code on GitHub")}</strong>
          <div className="auth-device-code-pill">{deviceCodes[stateKey].userCode}</div>
          <div className="auth-provider-actions-row">
            <button className="btn btn-sm" onClick={() => void copyTextToClipboard(deviceCodes[stateKey].userCode).then((copied) => addToast(copied ? t("settings.auth.copiedCodeToClipboard", "Copied code to clipboard") : t("settings.auth.failedToCopyCode", "Failed to copy code — copy it manually from the box above"), copied ? "success" : "error"))}>{t("settings.auth.copyCode", "Copy code")}</button>
            <button className="btn btn-sm" onClick={() => openExternalUrl(appendTokenQuery(deviceCodes[stateKey].verificationUri))}>{t("settings.auth.openGitHub", "Open GitHub")}</button>
          </div>
        </div>}
        {loginInstructions[stateKey] && isActive && <LoginInstructions instructions={loginInstructions[stateKey]} data-testid={`auth-login-instructions-${stateKey}`}/>}
        {manualCodeConfigs[stateKey] && isActive && <OAuthManualCodeForm value={manualCodeInputs[stateKey] ?? ""} onChange={(value) => setManualCodeInputs((prev) => ({ ...prev, [stateKey]: value }))} onSubmit={() => void handleSubmitManualCode(provider.id, instanceId)} prompt={manualCodeConfigs[stateKey].prompt} placeholder={manualCodeConfigs[stateKey].placeholder} helpText={manualCodeConfigs[stateKey].helpText} disabled={manualCodeSubmitInProgress === stateKey} submitLabel={manualCodeSubmitInProgress === stateKey ? "Submitting…" : "Submit code"} data-testid={`auth-manual-code-${stateKey}`}/>}
      </div>;
    };
    /*
    FNXC:ProviderAuth 2026-06-29-22:18:
    Settings must render Anthropic subscription OAuth and raw Anthropic API-key auth as separate provider cards.
    Only `type: "api_key"` cards show key controls so OAuth logout never looks like it will clear `ANTHROPIC_API_KEY`.
    */
    return (<>
      {/* FNXC:SettingsHelp 2026-07-16-12:45: Inline help moved behind the shared "?" affordance — operator requirement: no inline description paragraphs in Settings. The panel-level "changes take effect immediately" blurb now hangs off the section heading. */}
      <div className="settings-field-label-row">
        <h4 className="settings-section-heading">{t("settings.auth.title", "Authentication")}</h4>
        <SettingsHelpTip settingKey="auth-section">{t("settings.auth.hint", "Authentication changes take effect immediately — no need to save.")}</SettingsHelpTip>
      </div>
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
                      {renderAnthropicPrecedenceBadge(provider)}
                      {provider.authenticated && provider.keyHint && (<span className="auth-key-hint">{t("settings.authentication.key", "Key: ")}{provider.keyHint}</span>)}
                    </div>
                    {provider.type !== "api_key" && !hasMultipleInstances(provider) && <div>{renderAuthenticatedOAuthActions(provider)}{renderProviderAuthError(provider)}</div>}
                    {providerSupportsApiKey(provider) && !hasMultipleInstances(provider) && renderApiKeySection(provider)}
                  </div>
                  {renderInstanceControls(provider)}
                </div>))}
              {renderAnthropicPrecedenceRow()}
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
                    {provider.type !== "api_key" && !hasMultipleInstances(provider) && <div>{renderAvailableOAuthActions(provider)}{renderProviderAuthError(provider)}</div>}
                    {providerSupportsApiKey(provider) && !hasMultipleInstances(provider) && renderApiKeySection(provider)}
                  </div>
                  {renderInstanceControls(provider)}
                </div>))}
            </div>)}
        </div>)}
      {/*
      FNXC:SettingsHelp 2026-07-16-12:45:
      The provider cards' `<small>`s stay inline: they are all live state (save progress, key errors, provider loginError, OpenCode refresh status) that must stay visible where the operator is acting. The two DESCRIPTIVE blurbs this section carried — the panel-level "changes take effect immediately" hint and the reopen-onboarding hint — moved behind the shared "?" affordance per the operator requirement that no inline description paragraphs remain in Settings.
      */}
      {onReopenOnboarding && (<div className="form-group" style={{ marginTop: "var(--space-md)" }}>
          <div className="settings-field-label-row">
            <button type="button" className="btn btn-sm" onClick={onReopenOnboarding}>
              {t("settings.auth.reopenOnboarding", "Reopen onboarding guide")}
            </button>
            <SettingsHelpTip settingKey="reopen-onboarding">
              {t("settings.auth.reopenOnboardingHint", "Re-run the setup wizard to review or update your AI provider and model configuration.")}
            </SettingsHelpTip>
          </div>
        </div>)}

      <CustomProvidersSection />
    </>);
}
export default AuthenticationSection;
