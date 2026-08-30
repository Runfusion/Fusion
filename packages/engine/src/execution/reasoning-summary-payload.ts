/*
FNXC:ThinkingTrace 2026-08-27-10:45:
Pi-coding-agent streams Responses models through `streamSimple`, which forwards reasoning effort but cannot carry `reasoningSummary`. Pi therefore defaults Responses payloads to the short `"auto"` summary that can contain titles without bodies.

Pi 0.84.1 exposes `Agent.onPayload` as the request-shaping seam. This helper upgrades only already-enabled Responses reasoning; CLI and ACP runtimes are structurally exempt because they never construct a pi Agent.
*/

export const RESPONSES_FAMILY_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
] as const);

export type ResponsesFamilyApi = typeof RESPONSES_FAMILY_APIS extends Set<infer Api> ? Api : never;
export type ReasoningSummaryDetail = "auto" | "concise" | "detailed" | "off";

type PayloadModel = { api?: unknown };
type ReasoningPayload = { effort?: unknown; summary?: unknown };
type ProviderPayload = Record<string, unknown> & { reasoning?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponsesFamilyApi(api: unknown): api is ResponsesFamilyApi {
  return typeof api === "string" && RESPONSES_FAMILY_APIS.has(api as ResponsesFamilyApi);
}

/**
 * Returns a replacement only when an already-enabled Responses request needs a
 * more detailed reasoning summary. This preserves pi's undefined-means-keep
 * contract and never enables reasoning for a request that omitted it.
 */
export function applyReasoningSummaryToPayload(
  payload: unknown,
  model: PayloadModel,
  detail: ReasoningSummaryDetail,
): ProviderPayload | undefined {
  if (detail === "off" || detail === "auto" || !isResponsesFamilyApi(model.api) || !isRecord(payload)) {
    return undefined;
  }

  const reasoning = payload.reasoning;
  if (!isRecord(reasoning)) {
    return undefined;
  }

  const effort = reasoning.effort;
  if (typeof effort !== "string" || effort.length === 0 || effort === "none") {
    return undefined;
  }

  const summary = reasoning.summary;
  if (summary !== undefined && summary !== "auto") {
    return undefined;
  }

  return {
    ...payload,
    reasoning: {
      ...reasoning,
      summary: detail,
    } satisfies ReasoningPayload,
  };
}

/** Match only explicit provider rejections of the optional summary request. */
export function isReasoningSummaryUnsupportedError(message: string): boolean {
  const mentionsReasoningSummary = /\breasoning[\s_-]*summary\b|\bsummary\b[\s\S]{0,80}\breasoning\b/i.test(message);
  const rejectsFeature = /\b(?:unsupported|not supported|unknown|unrecognized|invalid|not allowed|not available)\b/i.test(message);
  return mentionsReasoningSummary && rejectsFeature;
}
