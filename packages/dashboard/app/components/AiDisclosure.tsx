import { useTranslation } from "react-i18next";
import "./AiDisclosure.css";

export const AI_DISCLOSURE_KINDS = [
  "ai-interaction",
  "generated-output",
  "ai-assisted-analysis",
  "ai-translation",
] as const;

export type AiDisclosureKind = (typeof AI_DISCLOSURE_KINDS)[number];

interface AiDisclosureProps {
  kind: AiDisclosureKind;
  provider?: string | null;
  modelId?: string | null;
  compact?: boolean;
  className?: string;
  accessibleLabel?: string;
  testId?: string;
}

const SAFE_METADATA_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._+/@:-]{0,119}$/u;
const SAFE_METADATA_DELIMITERS = "[._/@+:-]";
const SENSITIVE_METADATA_PATTERN = new RegExp(
  `(?:^|${SAFE_METADATA_DELIMITERS})(secret|token|password|credential|api[-_]?key)(?:$|${SAFE_METADATA_DELIMITERS})`,
  "i",
);
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function normalizeAiAttributionValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  /*
  FNXC:AITransparency 2026-09-04-05:45:
  Attribution must never render a URI or secret-shaped fragment. Reject scheme prefixes such as
  mailto: even without ://, and treat every SAFE delimiter (including slash) as a sensitive-token
  boundary so values like vendor/token-abc cannot appear as a provider or model.
  */
  if (!normalized || normalized.includes("://") || URI_SCHEME_PATTERN.test(normalized) || !SAFE_METADATA_PATTERN.test(normalized)) return undefined;
  if (SENSITIVE_METADATA_PATTERN.test(normalized)) return undefined;
  return normalized;
}

export interface StoredAiAttribution {
  provider?: string;
  modelId?: string;
}

/*
FNXC:AITransparency 2026-09-04-04:44:
Historic generated output must keep the provider/model stamped on that row. Session selection is
mutable, so missing or mixed metadata stays provider-agnostic instead of inheriting the current model.
*/
export function readStoredAiAttribution(metadata: Record<string, unknown> | null | undefined): StoredAiAttribution {
  if (!metadata) return {};
  const providerSource = typeof metadata.modelProvider === "string"
    ? metadata.modelProvider
    : typeof metadata.provider === "string"
      ? metadata.provider
      : undefined;
  const provider = normalizeAiAttributionValue(providerSource);
  if (!provider) return {};
  const modelId = normalizeAiAttributionValue(typeof metadata.modelId === "string" ? metadata.modelId : undefined);
  return modelId ? { provider, modelId } : { provider };
}

export function AiDisclosure({
  kind,
  provider,
  modelId,
  compact = false,
  className,
  accessibleLabel,
  testId,
}: AiDisclosureProps) {
  const { t } = useTranslation("app");
  const safeProvider = normalizeAiAttributionValue(provider);
  const safeModel = safeProvider ? normalizeAiAttributionValue(modelId) : undefined;
  const label = kind === "ai-interaction"
    ? t("aiDisclosure.interaction", "AI interaction")
    : kind === "generated-output"
      ? t("aiDisclosure.generatedOutput", "AI-generated")
      : kind === "ai-assisted-analysis"
        ? t("aiDisclosure.assistedAnalysis", "AI-assisted analysis")
        : t("aiDisclosure.translation", "AI translation");
  const attribution = safeProvider ? `${safeProvider}${safeModel ? `/${safeModel}` : ""}` : undefined;
  const semanticLabel = accessibleLabel ?? (attribution ? `${label} · ${attribution}` : label);

  return (
    <span
      className={["ai-disclosure", compact ? "ai-disclosure--compact" : "", className ?? ""].filter(Boolean).join(" ")}
      role="note"
      aria-label={semanticLabel}
      data-testid={testId}
      data-compliance="eu-ai-act-art-50"
      data-ai-disclosure={kind}
      {...(safeProvider
        ? { "data-ai-provider": safeProvider, ...(safeModel ? { "data-ai-model": safeModel } : {}) }
        : { "data-ai-attribution": "provider-agnostic" })}
    >
      <span>{label}</span>
      {attribution ? <span className="ai-disclosure__attribution" aria-hidden="true">· {attribution}</span> : null}
    </span>
  );
}
