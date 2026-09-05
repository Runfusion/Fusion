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
import type { CustomProviderThinkingFormat } from "@fusion/core";
import { CUSTOM_PROVIDER_THINKING_FORMAT_OPTIONS } from "./custom-provider-thinking-format";
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
  // FNXC:CustomProviderThinkingFormat 2026-08-21-05:59: RUFU-143 same for the per-model
  // thinking flags (thinkingFormat/reasoning) — legacy records may carry them too.
  // FNXC:CustomProviderHttpTimeout 2026-08-25-01:58: legacy records carry the per-model HTTP
  // timeout too; normalizeProviders must carry it through as well. fetchCustomProviders always
  // returns the legacy shape, so EVERY provider record flows through this conversion branch —
  // dropping the field here silently emptied the row editor (and the next save wiped the value).
  models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; timeoutSeconds?: number; thinkingFormat?: string; reasoning?: boolean }>;
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
        // FNXC:CustomProviderHttpTimeout 2026-08-25-01:58: carry the per-model HTTP timeout
        // through the legacy normalize so the edit form pre-fills it. Unlike the window fields,
        // 0 is a valid persisted value ("timeout disabled"), so the guard is >= 0, not > 0 —
        // a positive-only guard would collapse the disabled sentinel to blank and the next
        // save would omit the key, wiping the stored value.
        ...(typeof model.timeoutSeconds === "number" && Number.isFinite(model.timeoutSeconds) && model.timeoutSeconds >= 0
          ? { timeoutSeconds: model.timeoutSeconds }
          : {}),
        // FNXC:CustomProviderThinkingFormat 2026-08-21-05:59: RUFU-143 carry the per-model
        // thinking flags through the legacy normalize so the edit form pre-fills them. The
        // legacy record type is string-typed; the route is the authority for the literal union.
        ...(typeof model.thinkingFormat === "string" && model.thinkingFormat.length > 0 ? { thinkingFormat: model.thinkingFormat as CustomProviderThinkingFormat } : {}),
        ...(model.reasoning === false ? { reasoning: false } : {}),
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

FNXC:CustomProviderThinkingFormat 2026-08-21-05:59:
RUFU-143: each row also carries the per-model thinking flags — a "Thinking format" select
("") = pi-ai default; any UI-safe value is sent as-is) and a "No thinking params" checkbox
(reasoning: false, which wins over the select and disables it). Both reach the save payload
only when set, so default rows keep the byte-identical registration shape. Rows with a
persisted value outside the UI-safe set (chat-template/baseten via models.json or the raw
API) keep it in row.thinkingFormat and round-trip unchanged — the select simply renders
blank for a value it has no option for.
*/
type ModelRow = {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  /**
   * FNXC:CustomProviderHttpTimeout 2026-08-24-19:52:
   * RUFU-145 follow-up surface fix: the settings section's row editor (this component) is a
   * SEPARATE surface from CustomProviderForm (onboarding modal) — the first fix only added
   * the input to the modal, so the main Settings → Custom Providers editor had no timeout
   * field and operators could not configure it where they actually edit providers. "" =
   * default 300 s; "0" = disabled (both must round-trip, so this is a string like the other
   * window fields and 0 is a VALID parsed value, unlike contextWindow/maxTokens).
   */
  timeoutSeconds: string;
  /** "" = pi-ai default; otherwise a value from CUSTOM_PROVIDER_THINKING_FORMAT_OPTIONS. */
  thinkingFormat: string;
  /** True = send reasoning: false (opt out of all thinking params; wins over thinkingFormat). */
  noThinkingParams: boolean;
};

function emptyModelRow(): ModelRow {
  return { id: "", name: "", contextWindow: "", maxTokens: "", timeoutSeconds: "", thinkingFormat: "", noThinkingParams: false };
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

/**
 * FNXC:CustomProviderHttpTimeout 2026-08-24-19:52:
 * Unlike the window fields, 0 is a meaningful persisted value ("timeout disabled") and
 * must reach the save payload; only blank or non-finite/negative input stays absent.
 */
function parseNonNegativeTimeoutValue(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function modelRowFromModel(model: { id: string; name?: string; contextWindow?: number; maxTokens?: number; timeoutSeconds?: number; thinkingFormat?: string; reasoning?: boolean }): ModelRow {
  return {
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow != null ? String(model.contextWindow) : "",
    maxTokens: model.maxTokens != null ? String(model.maxTokens) : "",
    // FNXC:CustomProviderHttpTimeout 2026-08-24-19:52: 0 must pre-fill as "0" (disabled),
    // never collapse to the blank default.
    timeoutSeconds: model.timeoutSeconds != null ? String(model.timeoutSeconds) : "",
    // FNXC:CustomProviderThinkingFormat 2026-08-21-05:59: RUFU-143 pre-fill the thinking flags;
    // only reasoning === false counts as opted out (true/absent = presumed thinking-capable).
    thinkingFormat: typeof model.thinkingFormat === "string" ? model.thinkingFormat : "",
    noThinkingParams: model.reasoning === false,
  };
}

function isEmptyModelRow(row: ModelRow): boolean {
  return row.id.trim() === "" && row.name.trim() === "" && row.contextWindow.trim() === "" && row.maxTokens.trim() === "" &&
    row.timeoutSeconds.trim() === "" &&
    row.thinkingFormat.trim() === "" && !row.noThinkingParams;
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
          {/*
          FNXC:CustomProviderHttpTimeout 2026-08-24-19:52:
          RUFU-145 follow-up surface fix: the per-model HTTP timeout input belongs on the SAME
          surface operators edit providers (this section), not only in the onboarding modal.
          min={0} unlike the window fields: 0 = "timeout disabled" is a valid value. The
          route accepts non-negative finite numbers; the engine maps 0 to the disabled
          sentinel (2147483647 ms for the SDK, no idle timer for undici).
          */}
          <input
            className="input"
            aria-label={`${t("providers.fields.timeoutSeconds", "HTTP timeout (s)")} ${index + 1}`}
            placeholder={t("providers.fields.timeoutSeconds", "HTTP timeout (s)")}
            type="number"
            min={0}
            inputMode="numeric"
            value={row.timeoutSeconds}
            onChange={(event) => updateRow(index, { timeoutSeconds: event.target.value })}
            disabled={disabled}
          />
          {/*
          FNXC:CustomProviderThinkingFormat 2026-08-21-05:59:
          RUFU-143: per-model thinking controls. The select offers only the UI-safe pi-ai
          formats (blank = default) and is disabled while "No thinking params" is checked —
          the opt-out wins, so a disabled select's value never reaches the save payload.
          */}
          <select
            className="select custom-provider-model-row-thinking-format"
            aria-label={`${t("providers.modelRow.thinkingFormat", "Thinking format")} ${index + 1}`}
            title={t("providers.modelRow.thinkingFormat", "Thinking format")}
            value={row.thinkingFormat}
            onChange={(event) => updateRow(index, { thinkingFormat: event.target.value })}
            disabled={disabled || row.noThinkingParams}
          >
            <option value="">{t("providers.modelRow.thinkingFormatDefault", "Default")}</option>
            {CUSTOM_PROVIDER_THINKING_FORMAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey, option.label)}
              </option>
            ))}
          </select>
          <label className="custom-provider-model-row-no-thinking">
            <input
              type="checkbox"
              aria-label={`${t("providers.modelRow.noThinkingParams", "No thinking params")} ${index + 1}`}
              checked={row.noThinkingParams}
              onChange={(event) => updateRow(index, { noThinkingParams: event.target.checked })}
              disabled={disabled}
            />{" "}
            {t("providers.modelRow.noThinkingParams", "No thinking params")}
          </label>
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
              /*
              FNXC:CustomProviderThinkingFormat 2026-08-21-06:07:
              RUFU-143: newly probed rows start at the thinking-flag defaults — the probe
              reports no thinking capability, and pre-filling from heuristics is forbidden
              (the operator sets the format explicitly).
              */
              const row: ModelRow = {
                id: discoveredId,
                name: discovered.name ?? discoveredId,
                contextWindow: discovered.contextWindow != null ? String(discovered.contextWindow) : "",
                maxTokens: discovered.maxTokens != null ? String(discovered.maxTokens) : "",
                // FNXC:CustomProviderHttpTimeout 2026-08-24-19:52: the probe cannot report a
                // timeout; new rows start blank (300 s default) and the operator opts in.
                timeoutSeconds: "",
                thinkingFormat: "",
                noThinkingParams: false,
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
    // FNXC:CustomProviderThinkingFormat 2026-08-21-05:59: RUFU-143 the thinking flags follow
    // the same conditional-spread rule — thinkingFormat only when non-blank AND not opted
    // out (the opt-out wins); reasoning: false only when the checkbox is checked. Default
    // rows (both at default) keep the byte-identical { id, name, ...windows } shape.
    const parsedModels = modelRows.flatMap((row) => {
      const id = row.id.trim();
      if (id === "") return [];
      const contextWindow = parsePositiveTokenValue(row.contextWindow);
      const maxTokens = parsePositiveTokenValue(row.maxTokens);
      // FNXC:CustomProviderHttpTimeout 2026-08-24-19:52: 0 persists as 0 (disabled);
      // blank/invalid persists as absent so the 300 s default applies at registration.
      const timeoutSeconds = parseNonNegativeTimeoutValue(row.timeoutSeconds);
      const thinkingFormat = !row.noThinkingParams ? row.thinkingFormat.trim() : "";
      return [{
        id,
        name: row.name.trim() || id,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        // The row keeps the raw string so values outside the UI-safe set (chat-template/
        // baseten via models.json or the raw API) round-trip unchanged; the route validator
        // is the authority on the full pi-ai union, so the cast is safe.
        ...(thinkingFormat !== "" ? { thinkingFormat: thinkingFormat as CustomProviderThinkingFormat } : {}),
        ...(row.noThinkingParams ? { reasoning: false } : {}),
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
