/**
 * AI Text Translation Service
 *
 * Translates free-form GitHub/GitLab import preview content (title + body)
 * into the operator's dashboard locale. Mirrors the readonly AI helper pattern
 * used by ai-refine (rate limit, createFnAgent, MCP resolution).
 *
 * FNXC:GitHubImportTranslate 2026-07-14-12:00:
 * Import Tasks preview needs on-demand translation when issue/PR prose is not the active UI language.
 * Accept structured title+body fields (not a single blob) so markdown structure and headings survive,
 * allow longer bodies than refine-text (issue descriptions often exceed 2k chars), and return JSON fields only.
 */

import type { Locale, PromptOverrideMap, TaskStore } from "@fusion/core";
import { isLocale, SUPPORTED_LOCALES } from "@fusion/core";
import { createFnAgent as engineCreateFnAgent, resolveMcpServersForStore } from "@fusion/engine";
import {
  checkRateLimit,
  getRateLimitResetTime,
  AiServiceError,
  ValidationError,
} from "./ai-refine.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createFnAgent: any = engineCreateFnAgent;

function ensureEngineReady(): Promise<void> {
  return Promise.resolve();
}

/** Re-export shared AI helper rate-limit so routes share the refine/translate budget. */
export { checkRateLimit, getRateLimitResetTime, AiServiceError, ValidationError };

/** Maximum combined characters accepted for translation (title + body). */
export const MAX_TRANSLATE_TEXT_LENGTH = 12000;

/** Soft cap fed to the model; longer inputs are truncated with a marker. */
export const MAX_TRANSLATE_MODEL_INPUT_LENGTH = 8000;

/** Minimum non-empty text across fields. */
export const MIN_TRANSLATE_TEXT_LENGTH = 1;

export interface TranslateFields {
  title?: string;
  body?: string;
}

export interface TranslateTextRequest {
  fields: TranslateFields;
  targetLocale: Locale;
  sourceLocale?: string;
}

export interface TranslateTextResponse {
  fields: TranslateFields;
}

export const TRANSLATE_SYSTEM_PROMPT = `You are a translation assistant for a software task board.

Translate the provided JSON fields into the requested target language.

## Rules
- Preserve markdown structure (headings, lists, code fences, links, tables).
- Do NOT translate code inside fenced code blocks or inline backticks.
- Do NOT translate URLs, issue numbers (#123), @mentions, or file paths.
- Keep the same fields that were provided; omit fields that were missing/empty.
- Output ONLY a JSON object with the translated fields (keys: "title", "body"). No preamble, no markdown fence around the JSON.
- If a field is already in the target language, return it unchanged.`;

const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  fr: "French (Français)",
  es: "Spanish (Español)",
  ko: "Korean (한국어)",
};

/**
 * Validate translation request body.
 * Throws ValidationError for invalid input.
 */
export function validateTranslateRequest(
  fields: unknown,
  targetLocale: unknown,
  sourceLocale?: unknown,
): TranslateTextRequest {
  if (fields === undefined || fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new ValidationError("fields is required and must be an object");
  }

  const raw = fields as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title : undefined;
  const body = typeof raw.body === "string" ? raw.body : undefined;

  if (title === undefined && body === undefined) {
    throw new ValidationError("fields must include a string title and/or body");
  }

  if (title !== undefined && typeof raw.title !== "string") {
    throw new ValidationError("fields.title must be a string");
  }
  if (body !== undefined && typeof raw.body !== "string") {
    throw new ValidationError("fields.body must be a string");
  }

  const combined = `${title ?? ""}\n${body ?? ""}`.trim();
  if (combined.length < MIN_TRANSLATE_TEXT_LENGTH) {
    throw new ValidationError("text to translate must not be empty");
  }
  if (combined.length > MAX_TRANSLATE_TEXT_LENGTH) {
    throw new ValidationError(
      `text to translate must not exceed ${MAX_TRANSLATE_TEXT_LENGTH} characters`,
    );
  }

  if (typeof targetLocale !== "string" || !isLocale(targetLocale)) {
    throw new ValidationError(
      `targetLocale must be one of: ${SUPPORTED_LOCALES.join(", ")}`,
    );
  }

  let normalizedSource: string | undefined;
  if (sourceLocale !== undefined && sourceLocale !== null) {
    if (typeof sourceLocale !== "string") {
      throw new ValidationError("sourceLocale must be a string when provided");
    }
    normalizedSource = sourceLocale.trim() || undefined;
  }

  return {
    fields: {
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
    },
    targetLocale,
    sourceLocale: normalizedSource,
  };
}

function extractLastAssistantText(messages: unknown): string {
  interface AgentMessage {
    role: string;
    content?: string | Array<{ type: string; text: string }>;
  }

  const lastMessage = (Array.isArray(messages) ? messages : [])
    .filter((message): message is AgentMessage => Boolean(message) && typeof message === "object" && "role" in message)
    .filter((message) => message.role === "assistant")
    .pop();

  if (!lastMessage?.content) {
    return "";
  }

  if (typeof lastMessage.content === "string") {
    return lastMessage.content.trim();
  }

  if (Array.isArray(lastMessage.content)) {
    return lastMessage.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("")
      .trim();
  }

  return "";
}

/**
 * Parse model JSON output into TranslateFields. Tolerates optional markdown fences.
 */
export function parseTranslateResponse(
  raw: string,
  requestFields: TranslateFields,
): TranslateFields {
  const trimmed = raw.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    // Some models wrap JSON in prose — try first {...} slice.
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        throw new AiServiceError("AI returned non-JSON translation response");
      }
    } else {
      throw new AiServiceError("AI returned non-JSON translation response");
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AiServiceError("AI returned invalid translation object");
  }

  const obj = parsed as Record<string, unknown>;
  const result: TranslateFields = {};

  if (requestFields.title !== undefined) {
    if (typeof obj.title === "string" && obj.title.trim()) {
      result.title = obj.title;
    } else {
      // Fail soft: keep original title if model omitted it.
      result.title = requestFields.title;
    }
  }

  if (requestFields.body !== undefined) {
    if (typeof obj.body === "string") {
      result.body = obj.body;
    } else {
      result.body = requestFields.body;
    }
  }

  if (result.title === undefined && result.body === undefined) {
    throw new AiServiceError("AI returned empty translation fields");
  }

  return result;
}

function truncateForModel(fields: TranslateFields): TranslateFields {
  const title = fields.title;
  let body = fields.body;
  const titleLen = title?.length ?? 0;
  const bodyBudget = Math.max(0, MAX_TRANSLATE_MODEL_INPUT_LENGTH - titleLen - 32);
  if (body && body.length > bodyBudget) {
    body = `${body.slice(0, bodyBudget)}\n…(truncated)`;
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * Translate title/body fields into the dashboard target locale via a readonly AI agent.
 */
export async function translateText(
  request: TranslateTextRequest,
  rootDir: string,
  _promptOverrides?: PromptOverrideMap,
  store?: TaskStore,
): Promise<TranslateFields> {
  await ensureEngineReady();

  if (!createFnAgent) {
    throw new AiServiceError("AI engine not available");
  }

  const mcpServers = (await resolveMcpServersForStore(store ?? {})).servers;
  /*
   * FNXC:McpConfig 2026-07-14-12:00:
   * Import-preview translation is a readonly dashboard helper. Resolve MCP from the request-scoped store like refine/goal-draft; never log secrets.
   */
  const agentResult = await createFnAgent({
    cwd: rootDir,
    systemPrompt: TRANSLATE_SYSTEM_PROMPT,
    tools: "readonly",
    mcpServers,
  });

  if (!agentResult?.session) {
    throw new AiServiceError("Failed to initialize AI agent");
  }

  const modelFields = truncateForModel(request.fields);
  const targetLabel = LOCALE_LABELS[request.targetLocale] ?? request.targetLocale;
  const sourceHint = request.sourceLocale
    ? `Source language hint: ${request.sourceLocale}\n`
    : "";
  const prompt = `${sourceHint}Target language: ${targetLabel} (${request.targetLocale})

Fields JSON to translate:
${JSON.stringify(modelFields, null, 2)}`;

  try {
    await agentResult.session.prompt(prompt);
    const raw = extractLastAssistantText(agentResult.session.state.messages);
    if (!raw) {
      throw new AiServiceError("AI returned empty response");
    }
    const translated = parseTranslateResponse(raw, request.fields);

    try {
      agentResult.session.dispose?.();
    } catch {
      // Ignore disposal errors
    }

    return translated;
  } catch (err) {
    try {
      agentResult.session.dispose?.();
    } catch {
      // Ignore disposal errors
    }

    if (err instanceof AiServiceError) {
      throw err;
    }
    throw new AiServiceError(err instanceof Error ? err.message : "AI processing failed");
  }
}
