import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Search } from "lucide-react";
import type { CustomProviderThinkingFormat } from "@fusion/core";
import type { CustomProviderConfig, CustomProviderModelInput } from "../api";
import { probeProviderModels } from "../api";
import { CUSTOM_PROVIDER_THINKING_FORMAT_OPTIONS } from "./custom-provider-thinking-format";
import "./CustomProviderForm.css";

// Reserved built-in IDs (including hidden/deprecated aliases) to prevent custom-provider collisions.
export const BUILT_IN_PROVIDER_IDS = new Set<string>([
  "anthropic", "claude-cli", "pi-claude-cli", "openai", "openai-codex", "google", "gemini", "google-antigravity",
  "antigravity", "google-vertex", "vertex", "google-cloud-code", "cloud-code", "google-gemini-cli", "google-generative-ai",
  "ollama", "github", "github-copilot", "openrouter", "orcarouter", "minimax", "minimax-cn", "zai", "kimi", "moonshot", "kimi-coding",
  "bedrock", "amazon-bedrock", "xai", "grok", "opencode", "opencode-go", "qwen", "qwen-ai", "qwen-coder", "alibaba", "tongyi",
  "lmstudio", "lm-studio", "huggingface", "hugging-face", "hf", "mistral", "mistral-ai", "azure", "azure-openai",
  "azure-openai-responses", "fireworks", "fireworks-ai", "fireworksai", "cerebras", "groq", "vercel", "vercel-ai-gateway",
  "hermes", "hermes-agent", "hermesagent", "openclaw", "open-claw", "paperclip", "paperclipai", "paperclip-ai",
]);

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const API_TYPES: CustomProviderConfig["api"][] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

type Props = {
  initialConfig?: CustomProviderConfig;
  onSave: (config: CustomProviderConfig) => void | Promise<void>;
  onCancel?: () => void;
  saving?: boolean;
  error?: string;
};

function emptyModel(): CustomProviderModelInput {
  return { id: "", name: "" };
}

export function CustomProviderForm({ initialConfig, onSave, onCancel, saving = false, error }: Props) {
  const { t } = useTranslation("app");
  const editing = Boolean(initialConfig);
  const [id, setId] = useState(initialConfig?.id ?? "");
  const [name, setName] = useState(initialConfig?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl ?? "");
  const [api, setApi] = useState<CustomProviderConfig["api"]>(initialConfig?.api ?? "openai-completions");
  const [apiKey, setApiKey] = useState(initialConfig?.apiKey ?? "");
  const [models, setModels] = useState<CustomProviderModelInput[]>(initialConfig?.models?.length ? initialConfig.models : [emptyModel()]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  const canRemoveModel = models.length > 1;

  const mergedError = useMemo(() => validationError ?? error ?? null, [validationError, error]);

  function updateModel(index: number, patch: Partial<CustomProviderModelInput>) {
    setModels((prev) => prev.map((model, i) => (i === index ? { ...model, ...patch } : model)));
  }

  function removeModel(index: number) {
    setModels((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  // Detect Models is available for all API types that expose a /models endpoint:
  // - openai-completions / openai-responses → openai-compatible
  // - anthropic-messages → anthropic-compatible
  // - google-generative-ai → google-generative-ai
  const probeApiType = api === "anthropic-messages"
    ? "anthropic-compatible"
    : api === "google-generative-ai"
      ? "google-generative-ai"
      : "openai-compatible";

  const handleDetectModels = useCallback(async () => {
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) {
      setDetectError(t("providers.detectError.urlRequired", "Base URL is required to detect models."));
      return;
    }

    setDetecting(true);
    setDetectError(null);

    try {
      const result = await probeProviderModels({
        baseUrl: trimmedBaseUrl,
        apiKey: apiKey.trim() || undefined,
        apiType: probeApiType,
      });

      if (result.models.length === 0) {
        setDetectError(t("providers.detectError.noModels", "No models found. The provider may require an API key."));
        return;
      }

      // Merge discovered models, avoiding duplicates by ID
      const existingIds = new Set(models.map((m) => m.id.trim()));
      const newModels = result.models
        .filter((m) => !existingIds.has(m.id.trim()))
        .map((m) => ({
          id: m.id,
          name: m.name || m.id,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        }));

      if (newModels.length > 0) {
        // Replace empty default rows with discovered models
        setModels((prev) => {
          const nonEmpty = prev.filter((m) => m.id.trim().length > 0);
          return [...nonEmpty, ...newModels];
        });
      } else {
        setDetectError(t("providers.detectError.allDuplicate", "All discovered models are already in the list."));
      }
    } catch (err) {
      setDetectError(
        err instanceof Error ? err.message : t("providers.detectError.failed", "Failed to detect models"),
      );
    } finally {
      setDetecting(false);
    }
  }, [baseUrl, apiKey, probeApiType, models, t]);

  function validate(): string | null {
    if (!id.trim()) return t("providers.validation.idRequired", "Provider ID is required.");
    if (!PROVIDER_ID_PATTERN.test(id.trim())) return t("providers.validation.idKebabCase", "Provider ID must be kebab-case.");
    if (!editing && BUILT_IN_PROVIDER_IDS.has(id.trim())) return t("providers.validation.idConflict", "Provider ID conflicts with a built-in provider.");

    if (!baseUrl.trim()) return t("providers.validation.urlRequired", "Base URL is required.");
    try {
      const parsed = new URL(baseUrl.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return t("providers.validation.urlProtocol", "Base URL must use http or https.");
      }
    } catch {
      return t("providers.validation.urlValid", "Base URL must be a valid URL.");
    }

    if (!API_TYPES.includes(api)) return t("providers.validation.apiTypeRequired", "API type is required.");
    if (models.length === 0) return t("providers.validation.modelRequired", "At least one model is required.");
    if (models.some((model) => !model.id?.trim())) return t("providers.validation.modelId", "Each model must have a model ID.");
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const message = validate();
    setValidationError(message);
    if (message) return;

    await onSave({
      id: id.trim(),
      name: name.trim() || undefined,
      baseUrl: baseUrl.trim(),
      api,
      apiKey: apiKey.trim() || undefined,
      models: models.map((model) => ({
        id: model.id.trim(),
        name: model.name?.trim() || undefined,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        // FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
        // Per-model HTTP idle/first-byte timeout (seconds; 0 = off, omitted = default 300s).
        // Passed through as-is (undefined keys are dropped by JSON.stringify), mirroring
        // the contextWindow/maxTokens round-trip.
        timeoutSeconds: model.timeoutSeconds,
        // FNXC:CustomProviderThinkingFormat 2026-08-21-06:30: RUFU-143 conditional spread —
        // keys appear only when set so default rows keep the byte-identical payload; the
        // opt-out wins, so a flagged model with reasoning: false sends only reasoning.
        ...(model.reasoning !== false && model.thinkingFormat ? { thinkingFormat: model.thinkingFormat } : {}),
        ...(model.reasoning === false ? { reasoning: false } : {}),
      })),
    });
  }

  return (
    <form onSubmit={onSubmit} className="custom-provider-form" aria-label="custom-provider-form">
      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-id">{t("providers.fields.id", "Provider ID")}</label>
        <input id="custom-provider-id" className="input" value={id} onChange={(e) => setId(e.target.value)} disabled={editing || saving} />
      </div>

      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-name">{t("providers.fields.name", "Display Name")}</label>
        <input id="custom-provider-name" className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
      </div>

      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-base-url">{t("providers.fields.baseUrl", "Base URL")}</label>
        <input id="custom-provider-base-url" className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={saving} />
      </div>

      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-api">{t("providers.fields.apiType", "API Type")}</label>
        <select id="custom-provider-api" className="select" value={api} onChange={(e) => setApi(e.target.value as CustomProviderConfig["api"])} disabled={saving}>
          {API_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>

      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-api-key">{t("providers.fields.apiKey", "API Key")}</label>
        <input id="custom-provider-api-key" className="input" placeholder={t("providers.placeholders.apiKey", "sk-..., MY_API_KEY, or !command")} value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={saving} />
      </div>

      <div className="form-group custom-provider-form__group">
        <label>{t("providers.fields.models", "Models")}</label>
        <div className="custom-provider-form__models">
          {models.map((model, index) => (
            /*
            FNXC:CustomProviders 2026-08-19-15:13:
            There is no reasoning capability control because custom models are presumed thinking-capable.
            Pi derives selector options and execution behavior from their shared server registration.

            FNXC:CustomProviderThinkingFormat 2026-08-21-06:30:
            RUFU-143: the per-model "Thinking format" select and "No thinking params" opt-out are
            parameter controls, not capability claims — the presumed-thinking-capable default
            stands unless the operator opts the model out (or pins a pi-ai thinking format).
            */
            <div key={`${index}-model`} className="custom-provider-form__model-row">
              <input
                className="input"
                aria-label={`${t("providers.fields.modelId", "Model ID")} ${index + 1}`}
                placeholder={t("providers.fields.modelId", "Model ID")}
                value={model.id}
                onChange={(e) => updateModel(index, { id: e.target.value })}
                disabled={saving}
              />
              <input
                className="input"
                aria-label={`${t("providers.fields.modelNameLabel", "Model name")} ${index + 1}`}
                placeholder={t("providers.fields.modelName", "Display name")}
                value={model.name ?? ""}
                onChange={(e) => updateModel(index, { name: e.target.value })}
                disabled={saving}
              />
              <input
                className="input"
                aria-label={`${t("providers.fields.contextWindow", "Context window")} ${index + 1}`}
                placeholder={t("providers.fields.contextWindow", "Context window")}
                type="number"
                value={model.contextWindow ?? ""}
                onChange={(e) => updateModel(index, { contextWindow: e.target.value ? Number(e.target.value) : undefined })}
                disabled={saving}
              />
              <input
                className="input"
                aria-label={`${t("providers.fields.maxTokens", "Max tokens")} ${index + 1}`}
                placeholder={t("providers.fields.maxTokens", "Max tokens")}
                type="number"
                value={model.maxTokens ?? ""}
                onChange={(e) => updateModel(index, { maxTokens: e.target.value ? Number(e.target.value) : undefined })}
                disabled={saving}
              />
              {/*
              FNXC:CustomProviderHttpTimeout 2026-08-24-13:54:
              Per-model HTTP idle/first-byte timeout in seconds, placed next to contextWindow/maxTokens.
              `0` is a valid value (off), so the empty-string check (not the truthy check used for the
              window fields) decides between omitted and 0; `min=0` keeps the browser from letting
              negative values in.
              */}
              <input
                className="input"
                aria-label={`${t("providers.fields.timeoutSeconds", "HTTP timeout (s)")} ${index + 1}`}
                placeholder={t("providers.fields.timeoutSeconds", "HTTP timeout (s)")}
                type="number"
                min={0}
                value={model.timeoutSeconds ?? ""}
                onChange={(e) => updateModel(index, { timeoutSeconds: e.target.value === "" ? undefined : Number(e.target.value) })}
                disabled={saving}
              />
              <select
                className="select"
                aria-label={`${t("providers.modelRow.thinkingFormat", "Thinking format")} ${index + 1}`}
                value={model.thinkingFormat ?? ""}
                onChange={(e) => updateModel(index, { thinkingFormat: (e.target.value || undefined) as CustomProviderThinkingFormat | undefined })}
                disabled={saving || model.reasoning === false}
              >
                <option value="">{t("providers.modelRow.thinkingFormatDefault", "Default")}</option>
                {CUSTOM_PROVIDER_THINKING_FORMAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey, option.label)}
                  </option>
                ))}
              </select>
              <label className="custom-provider-form__model-row-no-thinking">
                <input
                  type="checkbox"
                  aria-label={`${t("providers.modelRow.noThinkingParams", "No thinking params")} ${index + 1}`}
                  checked={model.reasoning === false}
                  onChange={(e) => updateModel(index, { reasoning: e.target.checked ? false : undefined })}
                  disabled={saving}
                />{" "}
                {t("providers.modelRow.noThinkingParams", "No thinking params")}
              </label>
              <button
                type="button"
                className="btn btn-icon btn-sm"
                onClick={() => removeModel(index)}
                disabled={saving || !canRemoveModel}
                aria-label={t("providers.actions.removeModel", "Remove model", { count: index + 1 })}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="custom-provider-form__model-actions" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button type="button" className="btn btn-sm" onClick={() => setModels((prev) => [...prev, emptyModel()])} disabled={saving}>
            {t("providers.actions.addModel", "+ Add model")}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleDetectModels()}
            disabled={saving || detecting || !baseUrl.trim()}
            title={t("providers.actions.detectModelsTitle", "Call the provider's /models endpoint to discover available models")}
          >
            {detecting ? (
              <>
                <Loader2 className="spin" size={14} /> {t("providers.actions.detecting", "Detecting…")}
              </>
            ) : (
              <>
                <Search size={14} /> {t("providers.actions.detectModels", "Detect Models")}
              </>
            )}
          </button>
        </div>
        {detectError ? <div className="form-error" style={{ marginTop: "4px" }}>{detectError}</div> : null}
      </div>

      {mergedError ? <div className="form-error">{mergedError}</div> : null}

      <div className="custom-provider-form__actions">
        {onCancel ? <button type="button" className="btn" onClick={onCancel} disabled={saving}>{t("actions.cancel", "Cancel")}</button> : null}
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? t("providers.actions.saving", "Saving...") : t("providers.actions.save", "Save Provider")}</button>
      </div>
    </form>
  );
}
