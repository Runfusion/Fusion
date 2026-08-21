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
import { AlertCircle, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
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
  // FNXC:CustomProviderModelWindows 2026-08-19-16:49: RUFU-123 legacy records can carry the
  // per-model windows too; normalizeProviders carries them through so the edit form pre-fills.
  models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>;
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
        // FNXC:CustomProviderModelWindows 2026-08-19-16:49: RUFU-123 keep only valid positive windows.
        ...(isPositiveTokenValue(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
        ...(isPositiveTokenValue(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
      })),
    } satisfies CustomProvider;
  });
}

/*
FNXC:CustomProviderModelWindows 2026-08-19-16:49:
RUFU-123 (source finding: RUFU-118 finding 2): the single comma-separated "Available models"
input is replaced by per-model rows so each custom-provider model can carry an optional
context window and max output tokens. Rows hold the window fields as strings while editing;
only values that parse to a positive finite number reach the save payload (blank or invalid
=> key omitted => the registry builder's 128000/16384 fallback applies). ModelRowsEditor is
a module-scope component (never declared inside CustomProvidersSection's render) per the
no-nested-component-definitions rule; both the edit form and the new-provider form render it.
*/
type ModelRow = {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
};

function emptyModelRow(): ModelRow {
  return { id: "", name: "", contextWindow: "", maxTokens: "" };
}

function isPositiveTokenValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Parse a row's window input; blank or non-positive/non-finite values stay absent so defaults apply. */
function parsePositiveTokenValue(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return isPositiveTokenValue(parsed) ? parsed : undefined;
}

function modelRowFromModel(model: { id: string; name?: string; contextWindow?: number; maxTokens?: number }): ModelRow {
  return {
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow != null ? String(model.contextWindow) : "",
    maxTokens: model.maxTokens != null ? String(model.maxTokens) : "",
  };
}

function isEmptyModelRow(row: ModelRow): boolean {
  return row.id.trim() === "" && row.name.trim() === "" && row.contextWindow.trim() === "" && row.maxTokens.trim() === "";
}

interface ModelRowsEditorProps {
  rows: ModelRow[];
  onChange: (rows: ModelRow[]) => void;
  onDetect: () => void;
  detecting: boolean;
  canDetect: boolean;
  canAddRow: boolean;
  disabled?: boolean;
}

function ModelRowsEditor({ rows, onChange, onDetect, detecting, canDetect, canAddRow, disabled = false }: ModelRowsEditorProps) {
  const { t } = useTranslation("app");

  const updateRow = (index: number, patch: Partial<ModelRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const removeRow = (index: number) => {
    // The single remaining row cannot be removed — the form always keeps one row, and
    // blanking that last row is how the operator deletes every model (the edit save then
    // sends an explicit empty models array; see handleSave's FNXC:CustomProviderModelWindows
    // note). A blank row on a new provider stores no models.
    if (rows.length <= 1) return;
    onChange(rows.filter((_, i) => i !== index));
  };

  return (
    <div className="custom-provider-model-rows">
      {rows.map((row, index) => (
        <div key={index} className="custom-provider-model-row">
          <input
            className="input"
            aria-label={`${t("providers.modelRowModelId", "Model ID")} ${index + 1}`}
            placeholder={t("providers.modelRowModelId", "Model ID")}
            value={row.id}
            onChange={(event) => updateRow(index, { id: event.target.value })}
            disabled={disabled}
          />
          <input
            className="input"
            aria-label={`${t("providers.modelRowName", "Display name")} ${index + 1}`}
            placeholder={t("providers.modelRowName", "Display name")}
            value={row.name}
            onChange={(event) => updateRow(index, { name: event.target.value })}
            disabled={disabled}
          />
          <input
            className="input"
            aria-label={`${t("providers.fields.contextWindow", "Context window")} ${index + 1}`}
            placeholder={t("providers.fields.contextWindowPlaceholder", "e.g. 200000 (default)")}
            type="number"
            min={1}
            inputMode="numeric"
            value={row.contextWindow}
            onChange={(event) => updateRow(index, { contextWindow: event.target.value })}
            disabled={disabled}
          />
          <input
            className="input"
            aria-label={`${t("providers.fields.maxTokens", "Max output tokens")} ${index + 1}`}
            placeholder={t("providers.fields.maxTokensPlaceholder", "e.g. 4096 (default)")}
            type="number"
            min={1}
            inputMode="numeric"
            value={row.maxTokens}
            onChange={(event) => updateRow(index, { maxTokens: event.target.value })}
            disabled={disabled}
          />
          <button
            type="button"
            className="btn btn-icon btn-sm"
            onClick={() => removeRow(index)}
            disabled={disabled || rows.length <= 1}
            aria-label={t("providers.removeModelRowLabel", "Remove model {{index}}", { index: index + 1 })}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}

      <div className="custom-provider-model-row-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onChange([...rows, emptyModelRow()])}
          disabled={disabled || !canAddRow}
        >
          <Plus aria-hidden="true" /> {t("providers.addModelRow", "Add model row")}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onDetect}
          disabled={disabled || detecting || !canDetect}
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
    </div>
  );
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
  // FNXC:CustomProviderModelWindows 2026-08-19-16:49: RUFU-123 per-model rows replace the
  // comma-separated string so each model can carry optional contextWindow/maxTokens.
  const [modelRows, setModelRows] = useState<ModelRow[]>([emptyModelRow()]);
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
    setModelRows([emptyModelRow()]);
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
    setModelRows([emptyModelRow()]);
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
    // FNXC:CustomProviderModelWindows 2026-08-19-16:49: RUFU-123 seed rows from the persisted
    // models including any per-model windows so the edit form round-trips them unchanged.
    setModelRows((provider.models ?? []).length > 0
      ? (provider.models ?? []).map(modelRowFromModel)
      : [emptyModelRow()]);
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
        setModelRows((prev) => {
          // FNXC:CustomProviderModelWindows 2026-08-19-16:49: RUFU-123 merge by id: append new
          // models with their probed windows, and only fill blank fields on existing rows —
          // manual window values typed by the operator are never clobbered by the probe.
          // FNXC:CustomProviderModelWindows 2026-08-20-22:06: RUFU-145 PR #3493 review:
          // the merge writes the merged object back into the rows array by index. The
          // original code updated a parallel byId map and then returned the untouched
          // rows, so probed windows for already-typed model ids never reached the form.
          const rows = prev.filter((row) => !isEmptyModelRow(row));
          const indexById = new Map(rows.map((row, i) => [row.id.trim(), i] as const));
          for (const discovered of result.models) {
            const discoveredId = discovered.id.trim();
            if (!discoveredId) continue;
            const existingIndex = indexById.get(discoveredId);
            if (existingIndex !== undefined) {
              const existing = rows[existingIndex]!;
              rows[existingIndex] = {
                ...existing,
                name: existing.name.trim() !== "" ? existing.name : (discovered.name ?? discoveredId),
                contextWindow: existing.contextWindow.trim() !== ""
                  ? existing.contextWindow
                  : (discovered.contextWindow != null ? String(discovered.contextWindow) : ""),
                maxTokens: existing.maxTokens.trim() !== ""
                  ? existing.maxTokens
                  : (discovered.maxTokens != null ? String(discovered.maxTokens) : ""),
              };
            } else {
              const row: ModelRow = {
                id: discoveredId,
                name: discovered.name ?? discoveredId,
                contextWindow: discovered.contextWindow != null ? String(discovered.contextWindow) : "",
                maxTokens: discovered.maxTokens != null ? String(discovered.maxTokens) : "",
              };
              rows.push(row);
              indexById.set(discoveredId, rows.length - 1);
            }
          }
          return rows.length > 0 ? rows : [emptyModelRow()];
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

    // FNXC:CustomProviderModelWindows 2026-08-19-16:49: RUFU-123 build the models array from
    // rows — blank ids are dropped (a provider may be saved with zero models), a blank display
    // name falls back to the id, and window keys are included only when the field parses to a
    // positive finite number (blank/invalid persist as absent so defaults apply at registration).
    const parsedModels = modelRows.flatMap((row) => {
      const id = row.id.trim();
      if (id === "") return [];
      const contextWindow = parsePositiveTokenValue(row.contextWindow);
      const maxTokens = parsePositiveTokenValue(row.maxTokens);
      return [{
        id,
        name: row.name.trim() || id,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }];
    });
    const payload: Omit<CustomProvider, "id"> = {
      name: name.trim(),
      apiType,
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      // FNXC:CustomProviderModelWindows 2026-08-21-00:06:
      // RUFU-145 PR #3493 review (Greptile P1 "Cleared models remain persisted"): the PUT
      // update path is a partial merge — an omitted `models` key keeps the stored list.
      // The edit form must therefore always send the row result, including an explicit
      // empty array, or the operator's cleared rows silently reappear after reload. The
      // create path omits `models` when blank so a new provider simply has no registered
      // models.
      ...(editingProvider || parsedModels.length > 0 ? { models: parsedModels } : {}),
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
  }, [anthropicPromptCaching, apiKey, apiType, baseUrl, editingProvider, loadProviders, modelRows, name, resetForm, validateForm, t]);

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
          FNXC:CustomProviderModelWindows 2026-08-19-16:49:
          RUFU-123: the refresh response's models already carry the server-side id-merge of
          probed and persisted windows, so re-seed the row editor from them and the open form
          saves the merged list (windows included) instead of the pre-refresh rows.
          */
          setModelRows((result.provider.models ?? []).length > 0
            ? (result.provider.models ?? []).map(modelRowFromModel)
            : [emptyModelRow()]);
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
                      <label id="custom-provider-models-label-edit">{t("providers.modelsLabel", "Available models")}</label>
                      <div role="group" aria-labelledby="custom-provider-models-label-edit">
                      <ModelRowsEditor
                        rows={modelRows}
                        onChange={setModelRows}
                        onDetect={() => void handleDetectModels()}
                        detecting={detecting}
                        canDetect={baseUrl.trim() !== ""}
                        canAddRow
                        disabled={saving}
                      />
                      </div>
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
            <label id="custom-provider-models-label-create">{t("providers.modelsLabel", "Available models")}</label>
            <div role="group" aria-labelledby="custom-provider-models-label-create">
            <ModelRowsEditor
              rows={modelRows}
              onChange={setModelRows}
              onDetect={() => void handleDetectModels()}
              detecting={detecting}
              canDetect={baseUrl.trim() !== ""}
              canAddRow
              disabled={saving}
            />
            </div>
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
