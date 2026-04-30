import { useCallback, useEffect, useState } from "react";
import {
  addCustomProvider,
  deleteCustomProvider,
  fetchCustomProviders,
  updateCustomProvider,
  type CustomProvider,
} from "../api";
import { AlertCircle, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { OnboardingDisclosure } from "./OnboardingDisclosure";
import "./CustomProvidersSection.css";

type ProviderApiType = CustomProvider["apiType"];

const API_TYPES: ProviderApiType[] = ["openai-compatible", "anthropic-compatible"];

type LegacyProvider = {
  id: string;
  name?: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  apiKey?: string;
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
      apiType: provider.api === "anthropic-messages" ? "anthropic-compatible" : "openai-compatible",
      baseUrl: provider.baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
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
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchCustomProviders();
      setProviders(normalizeProviders(response));
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load custom providers.");
    } finally {
      setLoading(false);
    }
  }, []);

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
    setFormError(null);
    setIsFormOpen(false);
  }, []);

  const openAddForm = useCallback(() => {
    setEditingProvider(null);
    setName("");
    setApiType("openai-compatible");
    setBaseUrl("");
    setApiKey("");
    setModels("");
    setFormError(null);
    setIsFormOpen(true);
  }, []);

  const openEditForm = useCallback((provider: CustomProvider) => {
    setEditingProvider(provider);
    setName(provider.name);
    setApiType(provider.apiType);
    setBaseUrl(provider.baseUrl);
    setApiKey(provider.apiKey ?? "");
    setModels((provider.models ?? []).map((model) => model.id).join(", "));
    setFormError(null);
    setIsFormOpen(true);
  }, []);

  const validateForm = useCallback((): string | null => {
    if (!name.trim()) {
      return "Provider name is required.";
    }

    if (!baseUrl.trim()) {
      return "Base URL is required.";
    }

    let validProtocol = false;
    try {
      const parsed = new URL(baseUrl.trim());
      validProtocol = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      validProtocol = false;
    }

    if (!validProtocol) {
      return "Base URL must be a valid http/https URL.";
    }

    if (!API_TYPES.includes(apiType)) {
      return "API type is invalid.";
    }

    return null;
  }, [apiType, baseUrl, name]);

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
      setFormError(saveError instanceof Error ? saveError.message : "Failed to save provider.");
    } finally {
      setSaving(false);
    }
  }, [apiKey, apiType, baseUrl, editingProvider, loadProviders, models, name, resetForm, validateForm]);

  const handleDelete = useCallback(
    async (provider: CustomProvider) => {
      if (!window.confirm(`Delete custom provider "${provider.name}"?`)) return;

      setError(null);
      try {
        await deleteCustomProvider(provider.id);
        await loadProviders();
        onProviderChange?.();
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : "Failed to delete provider.");
      }
    },
    [loadProviders, onProviderChange],
  );

  const sectionContent = (
    <>
      {embedded ? null : loading ? (
        <div className="custom-provider-empty" role="status">
          <Loader2 aria-hidden="true" className="spin" /> Loading custom providers…
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
                      className="btn btn-icon btn-sm"
                      onClick={() => openEditForm(provider)}
                      aria-label={`Edit ${provider.name}`}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-sm"
                      onClick={() => void handleDelete(provider)}
                      aria-label={`Delete ${provider.name}`}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {isEditingThisProvider ? (
                  <div className="custom-provider-form custom-provider-item-edit-form">
                    <div className="form-group custom-provider-form-row">
                      <label htmlFor="custom-provider-name">Provider name</label>
                      <input
                        id="custom-provider-name"
                        className="input"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        disabled={saving}
                      />
                    </div>

                    <div className="form-group custom-provider-form-row">
                      <label htmlFor="custom-provider-api-type">API type</label>
                      <select
                        id="custom-provider-api-type"
                        className="select"
                        value={apiType}
                        onChange={(event) => setApiType(event.target.value as ProviderApiType)}
                        disabled={saving}
                      >
                        <option value="openai-compatible">OpenAI-compatible</option>
                        <option value="anthropic-compatible">Anthropic-compatible</option>
                      </select>
                    </div>

                    <div className="form-group custom-provider-form-row">
                      <label htmlFor="custom-provider-base-url">Base URL</label>
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
                      <label htmlFor="custom-provider-api-key">API key</label>
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
                      <label htmlFor="custom-provider-models">Available models</label>
                      <input
                        id="custom-provider-models"
                        className="input"
                        placeholder="e.g., gpt-4, gpt-3.5-turbo"
                        value={models}
                        onChange={(event) => setModels(event.target.value)}
                        disabled={saving}
                      />
                    </div>

                    {formError ? <div className="custom-provider-form-error">{formError}</div> : null}

                    <div className="custom-provider-form-actions">
                      <button type="button" className="btn btn-sm" onClick={resetForm} disabled={saving}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void handleSave()}
                        disabled={saving}
                      >
                        {saving ? "Saving…" : "Save Changes"}
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
        <div className="custom-provider-empty">No custom providers configured.</div>
      ) : null}

      <button type="button" className="btn btn-sm custom-provider-add-btn" onClick={openAddForm}>
        <Plus aria-hidden="true" /> Add Custom Provider
      </button>

      {isFormOpen && !editingProvider ? (
        <div className="custom-provider-form">
          <div className="form-group custom-provider-form-row">
            <label htmlFor="custom-provider-name">Provider name</label>
            <input
              id="custom-provider-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
            />
          </div>

          <div className="form-group custom-provider-form-row">
            <label htmlFor="custom-provider-api-type">API type</label>
            <select
              id="custom-provider-api-type"
              className="select"
              value={apiType}
              onChange={(event) => setApiType(event.target.value as ProviderApiType)}
              disabled={saving}
            >
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="anthropic-compatible">Anthropic-compatible</option>
            </select>
          </div>

          <div className="form-group custom-provider-form-row">
            <label htmlFor="custom-provider-base-url">Base URL</label>
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
            <label htmlFor="custom-provider-api-key">API key</label>
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
            <label htmlFor="custom-provider-models">Available models</label>
            <input
              id="custom-provider-models"
              className="input"
              placeholder="e.g., gpt-4, gpt-3.5-turbo"
              value={models}
              onChange={(event) => setModels(event.target.value)}
              disabled={saving}
            />
          </div>

          {formError ? <div className="custom-provider-form-error">{formError}</div> : null}

          <div className="custom-provider-form-actions">
            <button type="button" className="btn btn-sm" onClick={resetForm} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save Provider"}
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
