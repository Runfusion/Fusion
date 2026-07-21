import { resolveImportTranslateSettingsModel, resolveTitleSummarizerSettingsModel } from "@fusion/core";
import { createSessionDiagnostics } from "../ai-session-diagnostics.js";
import { ApiError, badRequest, rateLimited, rethrowAsApiError } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

const summarizeDiagnostics = createSessionDiagnostics("ai-summarize");

export const registerAiTextAssistantRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getProjectContext } = ctx;
/**
 * POST /api/ai/refine-text
 * AI-powered text refinement for task descriptions.
 * Body: { text: string, type: string }
 * Returns: { refined: string }
 *
 * Refinement types: clarify, add-details, expand, simplify
 * Rate limited: 10 requests per hour per IP
 */
router.post("/ai/refine-text", async (req, res) => {
  try {
    const { text, type } = req.body;
    const ip = req.ip || req.socket.remoteAddress || "unknown";

    // Get scoped store and settings for prompt overrides
    const { store: scopedStore } = await getProjectContext(req);
    const rootDir = scopedStore.getRootDir();
    const settings = await scopedStore.getSettings();

    const {
      validateRefineRequest,
      checkRateLimit,
      getRateLimitResetTime,
      refineText,
      RateLimitError: _RateLimitError3,
      ValidationError,
      InvalidTypeError,
      AiServiceError: _AiServiceError,
    } = await import("../ai-refine.js");

    // Check rate limit first
    if (!checkRateLimit(ip)) {
      const resetTime = getRateLimitResetTime(ip);
      throw rateLimited(`Rate limit exceeded. Maximum 10 refinement requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`);
    }

    // Validate request body
    let validated;
    try {
      validated = validateRefineRequest(text, type);
    } catch (err) {
      if (err instanceof ValidationError) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      if (err instanceof InvalidTypeError) {
        throw new ApiError(422, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    // Process refinement with prompt overrides
    const refined = await refineText(
      validated.text,
      validated.type,
      rootDir,
      settings.promptOverrides,
      scopedStore,
    );
    res.json({ refined });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    // Check error by name since error classes are from dynamic import
    if (err instanceof Error && err.name === "RateLimitError") {
      throw rateLimited(err.message);
    } else if (err instanceof Error && err.name === "AiServiceError") {
      rethrowAsApiError(err, "AI service error");
    } else {
      rethrowAsApiError(err, "Failed to refine text");
    }
  }
});

/**
 * POST /api/ai/translate-text
 * AI-powered translation for GitHub/GitLab import preview title+body.
 * Body: { fields: { title?: string, body?: string }, targetLocale: string, sourceLocale?: string }
 * Returns: { fields: { title?: string, body?: string } }
 *
 * Rate limited: shared AI-helper budget (10 requests per hour per IP with refine/draft)
 *
 * FNXC:GitHubImportTranslate 2026-07-14-12:00:
 * Import Tasks offers on-demand translation when selected content is not the dashboard language.
 */
router.post("/ai/translate-text", async (req, res) => {
  try {
    const { fields, targetLocale, sourceLocale } = req.body ?? {};
    const ip = req.ip || req.socket.remoteAddress || "unknown";

    const { store: scopedStore } = await getProjectContext(req);
    const rootDir = scopedStore.getRootDir();
    const settings = await scopedStore.getSettings();

    const {
      validateTranslateRequest,
      checkRateLimit,
      getRateLimitResetTime,
      translateText,
      AiServiceError: _AiServiceErrorTranslate,
      ValidationError,
    } = await import("../ai-translate.js");

    if (!checkRateLimit(ip)) {
      const resetTime = getRateLimitResetTime(ip);
      throw rateLimited(
        `Rate limit exceeded. Maximum 10 AI helper requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`,
      );
    }

    let validated;
    try {
      validated = validateTranslateRequest(fields, targetLocale, sourceLocale);
    } catch (err) {
      if (err instanceof ValidationError) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    /*
    FNXC:GitHubImportTranslate 2026-07-15-09:30:
    Manual (operator-clicked) translation resolves the same translate lane as auto-translation, so the model shown in Settings is the model that actually runs on both paths.
    */
    const resolvedTranslateModel = resolveImportTranslateSettingsModel(settings);
    const translated = await translateText(
      validated,
      rootDir,
      settings.promptOverrides,
      scopedStore,
      resolvedTranslateModel.provider,
      resolvedTranslateModel.modelId,
    );
    res.json({ fields: translated });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    if (err instanceof Error && err.name === "RateLimitError") {
      throw rateLimited(err.message);
    } else if (err instanceof Error && err.name === "AiServiceError") {
      rethrowAsApiError(err, "AI service error");
    } else {
      rethrowAsApiError(err, "Failed to translate text");
    }
  }
});

/**
 * POST /api/ai/draft-goal-description
 * AI-powered goal description drafting from a goal title.
 * Body: { title: string }
 * Returns: { description: string }
 *
 * Rate limited: 10 requests per hour per IP
 */
router.post("/ai/draft-goal-description", async (req, res) => {
  try {
    const { title } = req.body;
    const ip = req.ip || req.socket.remoteAddress || "unknown";

    const { store: scopedStore } = await getProjectContext(req);
    const rootDir = scopedStore.getRootDir();
    const settings = await scopedStore.getSettings();

    const {
      validateGoalDraftRequest,
      checkRateLimit,
      getRateLimitResetTime,
      draftGoalDescription,
      RateLimitError: _RateLimitError4,
      ValidationError,
      AiServiceError: _AiServiceError2,
    } = await import("../ai-refine.js");

    if (!checkRateLimit(ip)) {
      const resetTime = getRateLimitResetTime(ip);
      throw rateLimited(`Rate limit exceeded. Maximum 10 draft requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`);
    }

    let validatedTitle: string;
    try {
      validatedTitle = validateGoalDraftRequest(title);
    } catch (err) {
      if (err instanceof ValidationError) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    const description = await draftGoalDescription(validatedTitle, rootDir, settings.promptOverrides, scopedStore);
    res.json({ description });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    if (err instanceof Error && err.name === "RateLimitError") {
      throw rateLimited(err.message);
    } else if (err instanceof Error && err.name === "AiServiceError") {
      rethrowAsApiError(err, "AI service error");
    } else {
      rethrowAsApiError(err, "Failed to draft goal description");
    }
  }
});

/**
 * POST /api/ai/summarize-title
 * AI-powered title generation from task descriptions.
 * Body: { description: string, provider?: string, modelId?: string }
 * Returns: { title: string }
 *
 * Generates a concise title (≤60 characters) from descriptions longer than 200 characters.
 * Long descriptions are accepted; core truncates model input before prompting.
 * Rate limited: 10 requests per hour per IP
 */
router.post("/ai/summarize-title", async (req, res) => {
  try {
    const { description, provider, modelId } = req.body;
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const { store: scopedStore } = await getProjectContext(req);
    const rootDir = scopedStore.getRootDir();

    const {
      checkRateLimit,
      getRateLimitResetTime,
      summarizeTitle,
      validateDescription,
      MIN_DESCRIPTION_LENGTH,
      RateLimitError: _RateLimitError4,
      ValidationError: _ValidationError2,
      AiServiceError: _AiServiceError2,
    } = await import("@fusion/core");

    // Optional debug tracing for summarize flows.
    if (process.env.FUSION_DEBUG_AI) {
      summarizeDiagnostics.info("Summarize title request", {
        ip,
        descriptionLength: typeof description === "string" ? description.length : 0,
        operation: "summarize-title-request",
      });
    }

    // Check rate limit first
    if (!checkRateLimit(ip)) {
      const resetTime = getRateLimitResetTime(ip);
      throw rateLimited(`Rate limit exceeded. Maximum 10 summarization requests per hour. Reset at ${resetTime?.toISOString() || "unknown"}`);
    }

    // Validate request body
    try {
      validateDescription(description);
    } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
      if (err instanceof Error && err.name === "ValidationError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    // Resolve model selection hierarchy for summarization:
    // 1. Request body provider+modelId (request override)
    // 2. Project title summarizer lane
    // 3. Global title summarizer lane
    // 4. Project planning lane
    // 5. Project default override
    // 6. Global default
    // 7. Automatic model resolution (no explicit model)
    const settings = await scopedStore.getSettings();
    const resolvedSummarySettings = resolveTitleSummarizerSettingsModel(settings);

    const resolvedProvider =
      (provider && modelId ? provider : undefined) ||
      resolvedSummarySettings.provider;

    const resolvedModelId =
      (provider && modelId ? modelId : undefined) ||
      resolvedSummarySettings.modelId;

    if (process.env.FUSION_DEBUG_AI) {
      summarizeDiagnostics.info("Summarize title model resolved", {
        provider: resolvedProvider ?? "auto",
        modelId: resolvedModelId ?? "auto",
        operation: "summarize-title-model-resolution",
      });
    }

    // Process summarization
    const title = await summarizeTitle(description, rootDir, resolvedProvider, resolvedModelId);

    if (!title) {
      throw badRequest(`Description must be at least ${MIN_DESCRIPTION_LENGTH} characters for summarization`);
    }

    res.json({ title });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    // Check error by name since error classes are from dynamic import
    if (err instanceof Error && err.name === "RateLimitError") {
      throw rateLimited(err.message);
    } else if (err instanceof Error && err.name === "AiServiceError") {
      throw new ApiError(503, err.message || "AI service temporarily unavailable");
    } else if (err instanceof Error && err.name === "ValidationError") {
      throw badRequest(err instanceof Error ? err.message : String(err));
    } else {
      summarizeDiagnostics.errorFromException("Unexpected summarize title error", err, {
        operation: "summarize-title",
      });
      rethrowAsApiError(err, "Failed to generate title");
    }
  }
});

};
