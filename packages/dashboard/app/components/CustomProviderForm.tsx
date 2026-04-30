import { useMemo, useState } from "react";
import type { CustomProviderConfig, CustomProviderModelInput } from "../api";
import "./CustomProviderForm.css";

// Keep in sync with BUILT_IN_PROVIDER_IDS in register-custom-provider-routes.ts
export const BUILT_IN_PROVIDER_IDS = new Set<string>([
  "anthropic", "claude-cli", "pi-claude-cli", "openai", "openai-codex", "google", "gemini", "google-antigravity",
  "antigravity", "google-vertex", "vertex", "google-cloud-code", "cloud-code", "google-gemini-cli", "google-generative-ai",
  "ollama", "github", "github-copilot", "openrouter", "minimax", "minimax-cn", "zai", "kimi", "moonshot", "kimi-coding",
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
  return { id: "", name: "", reasoning: false };
}

export function CustomProviderForm({ initialConfig, onSave, onCancel, saving = false, error }: Props) {
  const editing = Boolean(initialConfig);
  const [id, setId] = useState(initialConfig?.id ?? "");
  const [name, setName] = useState(initialConfig?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl ?? "");
  const [api, setApi] = useState<CustomProviderConfig["api"]>(initialConfig?.api ?? "openai-completions");
  const [apiKey, setApiKey] = useState(initialConfig?.apiKey ?? "");
  const [models, setModels] = useState<CustomProviderModelInput[]>(initialConfig?.models?.length ? initialConfig.models : [emptyModel()]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const canRemoveModel = models.length > 1;

  const mergedError = useMemo(() => validationError ?? error ?? null, [validationError, error]);

  function updateModel(index: number, patch: Partial<CustomProviderModelInput>) {
    setModels((prev) => prev.map((model, i) => (i === index ? { ...model, ...patch } : model)));
  }

  function removeModel(index: number) {
    setModels((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function validate(): string | null {
    if (!id.trim()) return "Provider ID is required.";
    if (!PROVIDER_ID_PATTERN.test(id.trim())) return "Provider ID must be kebab-case.";
    if (!editing && BUILT_IN_PROVIDER_IDS.has(id.trim())) return "Provider ID conflicts with a built-in provider.";

    if (!baseUrl.trim()) return "Base URL is required.";
    try {
      const parsed = new URL(baseUrl.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "Base URL must use http or https.";
      }
    } catch {
      return "Base URL must be a valid URL.";
    }

    if (!API_TYPES.includes(api)) return "API type is required.";
    if (models.length === 0) return "At least one model is required.";
    if (models.some((model) => !model.id?.trim())) return "Each model must have a model ID.";
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
        reasoning: Boolean(model.reasoning),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    });
  }

  return (
    <form onSubmit={onSubmit} className="custom-provider-form" aria-label="custom-provider-form">
      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-id">Provider ID</label>
        <input id="custom-provider-id" className="input" value={id} onChange={(e) => setId(e.target.value)} disabled={editing || saving} />
      </div>

      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-name">Display Name</label>
        <input id="custom-provider-name" className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
      </div>

      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-base-url">Base URL</label>
        <input id="custom-provider-base-url" className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={saving} />
      </div>

      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-api">API Type</label>
        <select id="custom-provider-api" className="select" value={api} onChange={(e) => setApi(e.target.value as CustomProviderConfig["api"])} disabled={saving}>
          {API_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>

      <div className="form-group custom-provider-form__group">
        <label htmlFor="custom-provider-api-key">API Key</label>
        <input id="custom-provider-api-key" className="input" placeholder="sk-..., MY_API_KEY, or !command" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={saving} />
      </div>

      <div className="form-group custom-provider-form__group">
        <label>Models</label>
        <div className="custom-provider-form__models">
          {models.map((model, index) => (
            <div key={`${index}-model`} className="custom-provider-form__model-row">
              <input
                className="input"
                aria-label={`Model ID ${index + 1}`}
                placeholder="Model ID"
                value={model.id}
                onChange={(e) => updateModel(index, { id: e.target.value })}
                disabled={saving}
              />
              <input
                className="input"
                aria-label={`Model name ${index + 1}`}
                placeholder="Display name"
                value={model.name ?? ""}
                onChange={(e) => updateModel(index, { name: e.target.value })}
                disabled={saving}
              />
              <label className="checkbox-label custom-provider-form__toggle">
                <input
                  type="checkbox"
                  checked={Boolean(model.reasoning)}
                  onChange={(e) => updateModel(index, { reasoning: e.target.checked })}
                  disabled={saving}
                />
                Reasoning
              </label>
              <input
                className="input"
                aria-label={`Context window ${index + 1}`}
                placeholder="Context window"
                type="number"
                value={model.contextWindow ?? ""}
                onChange={(e) => updateModel(index, { contextWindow: e.target.value ? Number(e.target.value) : undefined })}
                disabled={saving}
              />
              <input
                className="input"
                aria-label={`Max tokens ${index + 1}`}
                placeholder="Max tokens"
                type="number"
                value={model.maxTokens ?? ""}
                onChange={(e) => updateModel(index, { maxTokens: e.target.value ? Number(e.target.value) : undefined })}
                disabled={saving}
              />
              <button
                type="button"
                className="btn btn-icon btn-sm"
                onClick={() => removeModel(index)}
                disabled={saving || !canRemoveModel}
                aria-label={`Remove model ${index + 1}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setModels((prev) => [...prev, emptyModel()])} disabled={saving}>
          + Add model
        </button>
      </div>

      {mergedError ? <div className="form-error">{mergedError}</div> : null}

      <div className="custom-provider-form__actions">
        {onCancel ? <button type="button" className="btn" onClick={onCancel} disabled={saving}>Cancel</button> : null}
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save Provider"}</button>
      </div>
    </form>
  );
}
