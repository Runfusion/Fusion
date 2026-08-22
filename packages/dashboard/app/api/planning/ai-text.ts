/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * AI text refinement / import translation client API peeled from legacy.ts.
 */
import { api } from "../client/client.js";import { withProjectId } from "../client/health.js";
// ── AI Text Refinement API ────────────────────────────────────────────

/** Refinement types for AI text refinement */
export type RefinementType = "clarify" | "add-details" | "expand" | "simplify";

/** Response from text refinement endpoint */
export interface RefineTextResponse {
  refined: string;
}

export interface DraftGoalDescriptionResponse {
  description: string;
}

/**
 * Refine task description text using AI.
 * @param text - The text to refine (1-2000 characters)
 * @param type - The refinement type: clarify, add-details, expand, or simplify
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The refined text
 * @throws Error with message for rate limit (429), invalid type (422), validation (400), or server errors
 */
export async function refineText(text: string, type: RefinementType, projectId?: string): Promise<string> {
  const response = await api<RefineTextResponse>(withProjectId("/ai/refine-text", projectId), {
    method: "POST",
    body: JSON.stringify({ text, type }),
  });
  return response.refined;
}

/**
 * Error messages for refineText failures (to use with toast notifications).
 */
export const REFINE_ERROR_MESSAGES = {
  /** Rate limit exceeded (429) */
  RATE_LIMIT: "Too many refinement requests. Please wait an hour.",
  /** Invalid refinement type (422) */
  INVALID_TYPE: "Invalid refinement option selected.",
  /** Network or server errors */
  NETWORK: "Failed to refine text. Please try again.",
} as const;

/**
 * Get user-friendly error message for a refineText error.
 * @param error - The error thrown by refineText
 * @returns A user-friendly error message suitable for toast display
 */
export function getRefineErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return REFINE_ERROR_MESSAGES.NETWORK;
  }

  const message = error.message.toLowerCase();

  // Rate limit errors (429)
  if (message.includes("rate limit") || message.includes("429")) {
    return REFINE_ERROR_MESSAGES.RATE_LIMIT;
  }

  // Invalid type errors (422)
  if (message.includes("invalid") && message.includes("type")) {
    return REFINE_ERROR_MESSAGES.INVALID_TYPE;
  }

  // Validation errors (400) - pass through from backend
  if (
    message.startsWith("text must") ||
    message.startsWith("title must") ||
    message.includes("text is required") ||
    message.includes("type is required") ||
    message.includes("title is required")
  ) {
    return error.message;
  }

  // Default network/server error
  return REFINE_ERROR_MESSAGES.NETWORK;
}

/**
 * Draft a goal description using AI from a goal title.
 * @param title - The goal title to expand into a draft description
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The drafted goal description
 * @throws Error with message for rate limit (429), validation (400), or server errors
 */
export async function draftGoalDescription(title: string, projectId?: string): Promise<string> {
  const response = await api<DraftGoalDescriptionResponse>(withProjectId("/ai/draft-goal-description", projectId), {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return response.description;
}

/*
FNXC:GitHubImportTranslate 2026-07-14-12:00:
Client for POST /api/ai/translate-text — used by the GitHub/GitLab import preview when issue/PR prose is not the dashboard language.
Structured title+body fields keep markdown import content intact; shares the AI-helper rate-limit budget with refine/draft.
*/
export interface TranslateImportFields {
  title?: string;
  body?: string;
}

export interface ImportTranslationIdentity {
  provider: "github" | "gitlab";
  repoKey: string;
  issueNumber: number;
}

export interface TranslateImportContentResponse {
  fields: TranslateImportFields;
}

export interface CachedTranslateImportContentResponse {
  fields: TranslateImportFields | null;
}

/**
 * Translate import-preview title/body into the dashboard locale via AI.
 * @param fields - Original title and/or body
 * @param targetLocale - Active dashboard locale
 * @param projectId - Optional project scope for settings/MCP
 * @param sourceLocale - Optional detection hint for the model
 * @param identity - Optional complete import identity for durable read-through caching
 */
export async function translateImportContent(
  fields: TranslateImportFields,
  targetLocale: string,
  projectId?: string,
  sourceLocale?: string,
  identity?: ImportTranslationIdentity,
): Promise<TranslateImportFields> {
  const response = await api<TranslateImportContentResponse>(
    withProjectId("/ai/translate-text", projectId),
    {
      method: "POST",
      body: JSON.stringify({
        fields,
        targetLocale,
        ...(sourceLocale ? { sourceLocale } : {}),
        ...(identity ?? {}),
      }),
    },
  );
  return response.fields;
}

/** Read a durable manual import translation without triggering AI work or budget use. */
export async function fetchCachedImportTranslation(
  fields: TranslateImportFields,
  targetLocale: string,
  identity: ImportTranslationIdentity,
  projectId?: string,
): Promise<TranslateImportFields | null> {
  const query = new URLSearchParams({
    provider: identity.provider,
    repoKey: identity.repoKey,
    issueNumber: String(identity.issueNumber),
    targetLocale,
    title: fields.title ?? "",
    body: fields.body ?? "",
  });
  const response = await api<CachedTranslateImportContentResponse>(
    withProjectId(`/ai/import-translation?${query.toString()}`, projectId),
  );
  return response.fields;
}

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Auto-translate the visible import list in ONE request. The server reads through its durable cache, so a repeat load of the same repo returns instantly and bills nothing; the same cache is what the import path reads, so an imported task carries the translation shown here.
The server enforces the auto-translate setting and the 50-issue cap itself and echoes `enabled`/`capped` back, so the client never has to duplicate that policy.
*/
export interface AutoTranslateImportItem {
  number: number;
  title: string;
  body: string | null;
  state?: "open" | "closed";
}

export interface AutoTranslateImportResponse {
  translations: Record<number, { title: string; body: string }>;
  enabled: boolean;
  targetLocale: string | null;
  /** True when more foreign issues existed than the per-load cap. */
  capped: boolean;
}

export async function autoTranslateImportIssues(
  owner: string,
  repo: string,
  items: AutoTranslateImportItem[],
  targetLocale: string,
  projectId?: string,
): Promise<AutoTranslateImportResponse> {
  return api<AutoTranslateImportResponse>(
    withProjectId("/github/issues/auto-translate", projectId),
    {
      method: "POST",
      body: JSON.stringify({ owner, repo, items, targetLocale }),
    },
  );
}

/** User-facing error copy for translateImportContent failures (toast/banner). */
export const TRANSLATE_ERROR_MESSAGES = {
  RATE_LIMIT: "Too many translation requests. Please wait an hour.",
  VALIDATION: "Translation request is invalid. Check the selected content and try again.",
  SERVICE: "Translation service is temporarily unavailable. Please try again shortly.",
  NETWORK: "Failed to translate content. Please try again.",
} as const;

/**
 * Map a translateImportContent error to banner-safe copy.
 */
export function getTranslateErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return TRANSLATE_ERROR_MESSAGES.NETWORK;
  }

  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  const message = error.message.toLowerCase();
  if (status === 429 || message.includes("translate_rate_limit") || message.includes("rate limit")) {
    return TRANSLATE_ERROR_MESSAGES.RATE_LIMIT;
  }
  if (status === 400 || message.includes("translate_validation_error")) {
    return TRANSLATE_ERROR_MESSAGES.VALIDATION;
  }
  if (status === 503 || message.includes("translate_service_error")) {
    return TRANSLATE_ERROR_MESSAGES.SERVICE;
  }
  return TRANSLATE_ERROR_MESSAGES.NETWORK;
}


