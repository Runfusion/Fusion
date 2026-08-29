import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addCustomProvider,
  deleteCustomProvider,
  fetchCustomProviders,
  probeProviderModels,
  refreshProviderModels,
  updateCustomProvider,
  type CustomProvider,
} from "../api";
import { AlertCircle, Loader2, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { OnboardingDisclosure } from "./OnboardingDisclosure";
import "./CustomProvidersSection.css";

type ProviderApiType = CustomProvider["apiType"];

const API_TYPES: ProviderApiType[] = ["openai-compatible", "openai-responses", "anthropic-compatible", "google-generative-ai"];

type LegacyProvider = {
  id: string;
  name?: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  apiKey?: string;
  anthropicPromptCaching?: boolean;
  models?: Array<{ id: string; name?: string }>;
};

function normalizeProviders(result: Awaited<ReturnType<typeof fetchCustomProviders>>): CustomProvider[] {
  const providerRecords: Array<CustomProvider | LegacyProvider> = Array.isArray(result)
    ? (result as Array<CustomProvider | LegacyProvider>)
    : ((result as { providers?: Array<CustomProvider | LegacyProvider> }).providers ?? []);

  return providerRecords.map((provider) => {
    if ("apiType" in provider) {
      return provider;
    }

    return {
      id: provider.id,
      name: provider.name?.trim() || provider.id,
      apiType: provider.api === "anthropic-messages" ? "anthropic-compatible"
        : provider.api === "openai-responses" ? "openai-responses"
        : provider.api === "google-generative-ai" ? "google-generative-ai"
        : "openai-compatible",
      baseUrl: provider.baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.anthropicPromptCaching ? { anthropicPromptCaching: true } : {}),
      models: (provider.models ?? []).map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
      })),
    } satisfies CustomProvider;
  });
}

function parseModels(modelsInput: string): { id: string; name: string }[] {
  return modelsInput
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
    .map((model) => ({ id: model, name: model }));
}

interface CustomProvidersSectionProps {
  embedded?: boolean;
  onProviderChange?: () => void;
}

export function CustomProvidersSection({ embedded = false, onProviderChange }: CustomProvidersSectionProps) {
  const { t } = useTranslation("app");
  const [providers, setProviders] = useState<CustomProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<CustomProvider | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [apiType, setApiType] = useState<ProviderApiType>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  // FNXC:ProviderAuth 2026-07-08-00:00:
  // FN-7689: opt-in for Anthropic-style prompt caching on openai-compatible/openai-responses
  // custom gateways that proxy an Anthropic backend. Shown only for those two apiTypes —
  // anthropic-compatible already auto-caches and google-generative-ai has no cache_control concept.
  const [anthropicPromptCaching, setAnthropicPromptCaching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<{ providerId: string; type: "success" | "error"; message: string } | null>(null);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchCustomProviders();
      setProviders(normalizeProviders(response));
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("providers.failedLoad", "Failed to load custom providers."));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const handleDisclosureToggle = useCallback(
    (isOpen: boolean) => {
      if (isOpen && !loaded && !loading) {
        void loadProviders();
      }
    },
    [loaded, loading, loadProviders],
  );

  useEffect(() => {
    if (embedded && !loaded && !loading) {
      void loadProviders();
    }
  }, [embedded, loaded, loading, loadProviders]);

  const resetForm = useCallback(() => {
    setEditingProvider(null);
    setName("");
    setApiType("openai-compatible");
    setBaseUrl("");
    setApiKey("");
    setModels("");
    setAnthropicPromptCaching(false);
    setFormError(null);
    setDetectError(null);
    setDetecting(false);
    setIsFormOpen(false);
  }, []);

  const openAddForm = useCallback(() => {
    setEditingProvider(null);
    setName("");
    setApiType("openai-compatible");
    setBaseUrl("");
    setApiKey("");
    setModels("");
    setAnthropicPromptCaching(false);
    setFormError(null);
    setDetectError(null);
    setDetecting(false);
    setIsFormOpen(true);
  }, []);

  const openEditForm = useCallback((provider: CustomProvider) => {
    setEditingProvider(provider);
    setName(provider.name);
    setApiType(provider.apiType);
    setBaseUrl(provider.baseUrl);
    // The loaded provider's apiKey is masked (e.g. "abc•••••wxyz") for display.
    // Never seed the editable field with the mask — echoing it back would send a
    // masked value to save/probe (which the server rejects). Start empty; an
    // unchanged blank field leaves the stored key untouched on save.
    setApiKey("");
    setModels((provider.models ?? []).map((model) => model.id).join(", "));
    setAnthropicPromptCaching(provider.anthropicPromptCaching === true);
    setFormError(null);
    setDetectError(null);
    setDetecting(false);
    setIsFormOpen(true);
  }, []);

  const validateForm = useCallback((): string | null => {
    if (!name.trim()) {
      return t("providers.nameRequired", "Provider name is required.");
    }

    if (!baseUrl.trim()) {
      return t("providers.urlRequired", "Base URL is required.");
    }

    let validProtocol = false;
    try {
      const parsed = new URL(baseUrl.trim());
      validProtocol = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      validProtocol = false;
    }

    if (!validProtocol) {
      return t("providers.urlInvalid", "Base URL must be a valid http/https URL.");
    }

    if (!API_TYPES.includes(apiType)) {
      return t("providers.apiTypeInvalid", "API type is invalid.");
    }

    return null;
  }, [apiType, baseUrl, name, t]);

  // Detect Models is available for all API types that expose a /models endpoint
  const handleDetectModels = useCallback(async () => {
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) {
      setDetectError(t("providers.urlRequiredForDetect", "Base URL is required to detect models."));
      return;
    }

    setDetecting(true);
    setDetectError(null);

    try {
      const result = await probeProviderModels({
        baseUrl: trimmedBaseUrl,
        apiKey: apiKey.trim() || undefined,
        apiType,
      });

      if (result.models.length > 0) {
        setModels((prev) => {
          const existingIds = new Set(
            prev.split(",").map((s) => s.trim()).filter(Boolean),
          );
          const newIds = result.models
            .map((m) => m.id.trim())
            .filter((id) => !existingIds.has(id));
          if (newIds.length === 0) return prev;
          const existing = prev.trim();
          return newIds.join(", ") + (existing ? ", " + existing : "");
        });
      } else {
        setDetectError(t("providers.noModelsFound", "No models found. The provider may require an API key."));
      }
    } catch (err) {
      setDetectError(
        err instanceof Error ? err.message : t("providers.failedDetect", "Failed to detect models"),
      );
    } finally {
      setDetecting(false);
    }
  }, [baseUrl, apiKey, apiType, t]);

  const handleSave = useCallback(async () => {
    const validationError = validateForm();
    setFormError(validationError);
    if (validationError) return;

    const parsedModels = parseModels(models);
    const payload: Omit<CustomProvider, "id"> = {
      name: name.trim(),
      apiType,
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(parsedModels.length > 0 ? { models: parsedModels } : {}),
      // FNXC:ProviderAuth 2026-07-08-00:00: only send the caching opt-in for apiTypes where it
      // applies (openai-compatible/openai-responses); anthropic-compatible/google-generative-ai
      // never surface the checkbox so this is always false for them.
      ...(anthropicPromptCaching ? { anthropicPromptCaching: true } : {}),
    };

    setSaving(true);
    setError(null);

    try {
      if (editingProvider) {
        await updateCustomProvider(editingProvider.id, payload);
      } else {
        await addCustomProvider(payload);
      }
      await loadProviders();
      onProviderChange?.();
      resetForm();
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : t("providers.failedSave", "Failed to save provider."));
    } finally {
      setSaving(false);
    }
  }, [anthropicPromptCaching, apiKey, apiType, baseUrl, editingProvider, loadProviders, models, name, resetForm, validateForm, t]);

  const handleDelete = useCallback(
    async (provider: CustomProvider) => {
      if (!window.confirm(t("providers.deleteConfirm", `Delete custom provider "{{name}}"?`, { name: provider.name }))) return;

      setError(null);
      try {
        await deleteCustomProvider(provider.id);
        await loadProviders();
        onProviderChange?.();
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : t("providers.failedDelete", "Failed to delete provider."));
      }
    },
    [loadProviders, onProviderChange, t],
  );

  const handleRefreshProviderModels = useCallback(
    async (provider: CustomProvider) => {
      setRefreshingProviderId(provider.id);
      setRefreshStatus(null);
      setError(null);
      try {
        const result = await refreshProviderModels(provider.id);
        setProviders((current) => current.map((candidate) => (
          candidate.id === provider.id ? result.provider : candidate
        )));
        if (editingProvider?.id === provider.id) {
          /*
          FNXC:CustomProviders 2026-06-30-00:00:
          Manual refresh can run while a provider edit form is open. Keep that form's model input synchronized with the persisted refresh result so saving unrelated edits cannot overwrite newly discovered models with the pre-refresh list.
          */
          const refreshedModels = (result.provider.models ?? []).map((model) => model.id).join(", ");
          setModels(refreshedModels);
          setEditingProvider((current) => current?.id === provider.id
            ? { ...current, models: result.provider.models ?? [] }
            : current);
        }
        onProviderChange?.();
        setRefreshStatus({
          providerId: provider.id,
          type: "success",
          message: t("providers.refreshModelsSuccess", "Refreshed {{count}} model(s).", { count: result.modelsRefreshed }),
        });
      } catch (refreshError) {
        setRefreshStatus({
          providerId: provider.id,
          type: "error",
          message: refreshError instanceof Error ? refreshError.message : t("providers.refreshModelsFailed", "Failed to refresh models."),
        });
      } finally {
        setRefreshingProviderId(null);
      }
    },
    [editingProvider?.id, onProviderChange, t],
  );

  const sectionContent = (
    <>
      {embedded ? null : loading ? (
        <div className="custom-provider-empty" role="status">
          <Loader2 aria-hidden="true" className="custom-provider-spin" /> {t("providers.loading", "Loading custom providers…")}
        </div>
      ) : null}

      {embedded ? null : !loading && error ? (
        <div className="custom-provider-form-error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      
      {!loading && providers.length > 0 ? (
        <div className="custom-provider-list">
          {providers.map((provider) => {
            const isEditingThisProvider = isFormOpen && editingProvider?.id === provider.id;
            const isRefreshingThisProvider = refreshingProviderId === provider.id;
            const providerRefreshStatus = refreshStatus?.providerId === provider.id ? refreshStatus : null;

            return (
              <div key={provider.id}>
                <div className="auth-provider-card custom-provider-item">
                  <div className="custom-provider-item-info">
                    <div className="custom-provider-item-name">{provider.name}</div>
                    <div className="custom-provider-item-meta">
                      <span className="custom-provider-badge">{provider.apiType}</span> {provider.baseUrl}
                    </div>
                  </div>
                  <div className="custom-provider-item-actions">
                    <button
                      type="button"
                      className="btn btn-sm custom-provider-refresh-btn"
                      onClick={() => void handleRefreshProviderModels(provider)}
                      disabled={isRefreshingThisProvider}
                      aria-label={t("providers.refreshModelsLabel", "Refresh models for {{name}}", { name: provider.name })}
                    >
                      {isRefreshingThisProvider ? <Loader2 aria-hidden="true" className="custom-provider-spin" /> : <RefreshCw aria-hidden="true" />}
                      <span>{isRefreshingThisProvider ? t("providers.refreshingModels", "Refreshing…") : t("providers.refreshModels", "Refresh Models")}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => openEditForm(provider)}
                      aria-label={t("providers.editLabel", "Edit {{name}}", { name: provider.name })}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => void handleDelete(provider)}
                      aria-label={t("providers.deleteLabel", "Delete {{name}}", { name: provider.name })}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {providerRefreshStatus ? (
                  <div className={`custom-provider-row-message custom-provider-row-message--${providerRefreshStatus.type}`} role={providerRefreshStatus.type === "error" ? "alert" : "status"}>
                    {providerRefreshStatus.type === "error" ? <AlertCircle aria-hidden="true" /> : null}
                    <span>{providerRefreshStatus.message}</span>
                  </div>
                ) : null}

                {isEditingThisProvider ? (
                  <div className="custom-provider-form custom-provider-item-edit-form">
                    <div className="form-group custom-provider-form-row">
                      <label htmlFor="custom-provider-name">{t("providers.nameLabel", "Provider name")}</label>
                      <input
                        id="custom-provider-name"
                        className="input"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        disabled={saving}
                      />
                    </div>

                    <div className="form-group custom-provider-form-row">
                      <label htmlFor="custom-provider-api-type">{t("providers.apiTypeLabel", "API type")}</label>
                      <select
                        id="custom-provider-api-type"
                        className="select"
                        value={apiType}
                        onChange={(event) => setApiType(event.target.value as ProviderApiType)}
                        disabled={saving}
                      >
                        <option value="openai-compatible">{t("providers.apiTypeOpenAi", "OpenAI-compatible")}</option>
                        <option value="openai-responses">{t("providers.apiTypeOpenAiResp", "OpenAI Responses")}</option>
                        <option value="anthropic-compatible">{t("providers.apiTypeAnthropic", "Anthropic-compatible")}</option>
                        <option value="google-generative-ai">{t("providers.apiTypeGoogle", "Google Generative AI")}</option>
                      </select>
                    </div>

                    {apiType === "openai-compatible" || apiType === "openai-responses" ? (
                      <div className="form-group custom-provider-form-row custom-provider-form-checkbox-row">
                        <label htmlFor="custom-provider-anthropic-caching">
                          <input
                            id="custom-provider-anthropic-caching"
                            type="checkbox"
                            checked={anthropicPromptCaching}
                            onChange={(event) => setAnthropicPromptCaching(event.target.checked)}
                            disabled={saving}
                          />{" "}
                          {t("providers.anthropicPromptCaching", "Enable Anthropic-style prompt caching")}
                        </label>
                        <p className="custom-provider-form-hint">
                          {t(
                            "providers.anthropicPromptCachingHint",
                            "Enable if this gateway proxies an Anthropic model (e.g. Claude via a custom router). Reduces re-billing the full context every turn.",
                          )}
                        </p>
                      </div>
                    ) : null}

                    <div className="form-group custom-provider-form-row">
                      <label htmlFor="custom-provider-base-url">{t("providers.baseUrlLabel", "Base URL")}</label>
                      <input
                        id="custom-provider-base-url"
                        className="input"
                        placeholder="https://api.example.com/v1"
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        disabled={saving}
                      />
                    </div>

                    <div className="form-group custom-provider-form-row">
                      <label htmlFor="custom-provider-api-key">{t("providers.apiKeyLabel", "API key")}</label>
                      <input
                        id="custom-provider-api-key"
                        type="password"
                        className="input"
                        placeholder={editingProvider?.apiKey
                          ? t("providers.apiKeyKeepPlaceholder", "Leave blank to keep current key")
                          : undefined}
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        disabled={saving}
                      />
                    </div>

                    <div className="form-group custom-provider-form-row">
                      <label htmlFor="custom-provider-models">{t("providers.modelsLabel", "Available models")}</label>
                      <input
                        id="custom-provider-models"
                        className="input"
                        placeholder="e.g., gpt-4, gpt-3.5-turbo"
                        value={models}
                        onChange={(event) => setModels(event.target.value)}
                        disabled={saving}
                      />
                    </div>

                    <div className="custom-provider-detect-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void handleDetectModels()}
                        disabled={saving || detecting || !baseUrl.trim()}
                        title={t("providers.detectTitle", "Auto-detect models from the provider's /models endpoint")}
                      >
                        {detecting ? (
                          <>
                            <Loader2 className="custom-provider-spin" size={14} /> {t("providers.detecting", "Detecting…")}
                          </>
                        ) : (
                          <>
                            <Search size={14} /> {t("providers.detectModels", "Detect Models")}
                          </>
                        )}
                      </button>
                    </div>
                    {detectError ? <div className="custom-provider-form-error">{detectError}</div> : null}

                    {formError ? <div className="custom-provider-form-error">{formError}</div> : null}

                    <div className="custom-provider-form-actions">
                      <button type="button" className="btn btn-sm" onClick={resetForm} disabled={saving}>
                        {t("actions.cancel", "Cancel")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void handleSave()}
                        disabled={saving}
                      >
                        {saving ? t("providers.saving", "Saving…") : t("providers.saveChanges", "Save Changes")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {!loading && providers.length === 0 && !error ? (
        <div className="custom-provider-empty">{t("providers.noneConfigured", "No custom providers configured.")}</div>
      ) : null}

      <button type="button" className="btn btn-sm custom-provider-add-btn" onClick={openAddForm}>
        <Plus aria-hidden="true" /> {t("providers.addCustom", "Add Custom Provider")}
      </button>

      {isFormOpen && !editingProvider ? (
        <div className="custom-provider-form">
          <div className="form-group custom-provider-form-row">
            <label htmlFor="custom-provider-name">{t("providers.nameLabel", "Provider name")}</label>
            <input
              id="custom-provider-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
            />
          </div>

          <div className="form-group custom-provider-form-row">
            <label htmlFor="custom-provider-api-type">{t("providers.apiTypeLabel", "API type")}</label>
            <select
              id="custom-provider-api-type"
              className="select"
              value={apiType}
              onChange={(event) => setApiType(event.target.value as ProviderApiType)}
              disabled={saving}
            >
              <option value="openai-compatible">{t("providers.apiTypeOpenAi", "OpenAI-compatible")}</option>
              <option value="openai-responses">{t("providers.apiTypeOpenAiResp", "OpenAI Responses")}</option>
              <option value="anthropic-compatible">{t("providers.apiTypeAnthropic", "Anthropic-compatible")}</option>
              <option value="google-generative-ai">{t("providers.apiTypeGoogle", "Google Generative AI")}</option>
            </select>
          </div>

          {apiType === "openai-compatible" || apiType === "openai-responses" ? (
            <div className="form-group custom-provider-form-row custom-provider-form-checkbox-row">
              <label htmlFor="custom-provider-anthropic-caching-new">
                <input
                  id="custom-provider-anthropic-caching-new"
                  type="checkbox"
                  checked={anthropicPromptCaching}
                  onChange={(event) => setAnthropicPromptCaching(event.target.checked)}
                  disabled={saving}
                />{" "}
                {t("providers.anthropicPromptCaching", "Enable Anthropic-style prompt caching")}
              </label>
              <p className="custom-provider-form-hint">
                {t(
                  "providers.anthropicPromptCachingHint",
                  "Enable if this gateway proxies an Anthropic model (e.g. Claude via a custom router). Reduces re-billing the full context every turn.",
                )}
              </p>
            </div>
          ) : null}

          <div className="form-group custom-provider-form-row">
            <label htmlFor="custom-provider-base-url">{t("providers.baseUrlLabel", "Base URL")}</label>
            <input
              id="custom-provider-base-url"
              className="input"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={saving}
            />
          </div>

          <div className="form-group custom-provider-form-row">
            <label htmlFor="custom-provider-api-key">{t("providers.apiKeyLabel", "API key")}</label>
            <input
              id="custom-provider-api-key"
              type="password"
              className="input"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={saving}
            />
          </div>

          <div className="form-group custom-provider-form-row">
            <label htmlFor="custom-provider-models">{t("providers.modelsLabel", "Available models")}</label>
            <input
              id="custom-provider-models"
              className="input"
              placeholder="e.g., gpt-4, gpt-3.5-turbo"
              value={models}
              onChange={(event) => setModels(event.target.value)}
              disabled={saving}
            />
          </div>

          <div className="custom-provider-detect-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void handleDetectModels()}
              disabled={saving || detecting || !baseUrl.trim()}
              title={t("providers.detectTitle", "Auto-detect models from the provider's /models endpoint")}
            >
              {detecting ? (
                <>
                  <Loader2 className="custom-provider-spin" size={14} /> {t("providers.detecting", "Detecting…")}
                </>
              ) : (
                <>
                  <Search size={14} /> {t("providers.detectModels", "Detect Models")}
                </>
              )}
            </button>
          </div>
          {detectError ? <div className="custom-provider-form-error">{detectError}</div> : null}

          {formError ? <div className="custom-provider-form-error">{formError}</div> : null}

          <div className="custom-provider-form-actions">
            <button type="button" className="btn btn-sm" onClick={resetForm} disabled={saving}>
              {t("actions.cancel", "Cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? t("providers.saving", "Saving…") : t("providers.saveProvider", "Save Provider")}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="custom-providers-section">
      {embedded ? sectionContent : (
        <OnboardingDisclosure summary="Advanced: Custom Providers" onToggle={handleDisclosureToggle}>
          {sectionContent}
        </OnboardingDisclosure>
      )}
    </div>
  );
}
