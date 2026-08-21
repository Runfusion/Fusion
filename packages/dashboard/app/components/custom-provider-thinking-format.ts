import type { CustomProviderThinkingFormat } from "@fusion/core";

/*
FNXC:CustomProviderThinkingFormat 2026-08-21-05:59:
RUFU-143: shared UI-safe option list for the per-model "Thinking format" select on the
dashboard custom-provider surfaces (Settings → Models and the legacy onboarding modal).
The values are the subset of pi-ai 0.84.1's thinking-format union that the form can
configure safely — every listed format works with no additional payload fields:
qwen-chat-template/qwen (enable_thinking), zai (thinking + optional effort),
deepseek (enable_thinking + optional effort), string-thinking, openrouter, together,
ant-ling.

Deliberate exclusions (the root route validator still accepts the FULL core union, so
models.json / API clients can express these — the dashboard form simply cannot):
- "openai" is the default behavior itself, represented by the blank select value, so
  listing it would be a confusing no-op option.
- "chat-template" and "baseten" require a chatTemplateKwargs payload that pi-ai THROWS
  on when absent — exposing them here without a kwargs editor would only create a
  guaranteed-broken path, so the form keeps its models.json-only escape hatch.

Options carry an i18n label key plus an English fallback (RUFU-123 inline-fallback
pattern — no locale-catalog entries are added for these).
*/

export interface CustomProviderThinkingFormatOption {
  value: CustomProviderThinkingFormat;
  /** i18next key under the "app" namespace; the fallback below is used when untranslated. */
  labelKey: string;
  /** English fallback label (also the default rendered text). */
  label: string;
}

export const CUSTOM_PROVIDER_THINKING_FORMAT_OPTIONS: readonly CustomProviderThinkingFormatOption[] = [
  { value: "qwen-chat-template", labelKey: "providers.modelRow.thinkingFormatOptionQwenChatTemplate", label: "Qwen (chat template)" },
  { value: "qwen", labelKey: "providers.modelRow.thinkingFormatOptionQwen", label: "Qwen (enable_thinking)" },
  { value: "zai", labelKey: "providers.modelRow.thinkingFormatOptionZai", label: "Z.AI / GLM (thinking)" },
  { value: "deepseek", labelKey: "providers.modelRow.thinkingFormatOptionDeepSeek", label: "DeepSeek (enable_thinking)" },
  { value: "string-thinking", labelKey: "providers.modelRow.thinkingFormatOptionStringThinking", label: "String thinking" },
  { value: "openrouter", labelKey: "providers.modelRow.thinkingFormatOptionOpenRouter", label: "OpenRouter" },
  { value: "together", labelKey: "providers.modelRow.thinkingFormatOptionTogether", label: "Together AI" },
  { value: "ant-ling", labelKey: "providers.modelRow.thinkingFormatOptionAntLing", label: "Ant Ling" },
] as const;

/** Derived value set — used to guard values round-tripped from the API before treating them as user selections. */
export const CUSTOM_PROVIDER_THINKING_FORMAT_VALUES: ReadonlySet<string> =
  new Set(CUSTOM_PROVIDER_THINKING_FORMAT_OPTIONS.map((option) => option.value));

