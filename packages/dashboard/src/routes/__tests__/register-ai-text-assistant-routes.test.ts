// @vitest-environment node
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerAiTextAssistantRoutes } from "../register-ai-text-assistant-routes.js";

const refine = vi.hoisted(() => { class ValidationError extends Error {}; class InvalidTypeError extends Error {}; class RateLimitError extends Error {}; class AiServiceError extends Error {}; return { checkRateLimit: vi.fn(), validateRefineRequest: vi.fn(), validateGoalDraftRequest: vi.fn(), refineText: vi.fn(), draftGoalDescription: vi.fn(), getRateLimitResetTime: vi.fn(), ValidationError, InvalidTypeError, RateLimitError, AiServiceError }; });
const translate = vi.hoisted(() => { class ValidationError extends Error {}; class AiServiceError extends Error {}; return { checkRateLimit: vi.fn(), checkTranslateRateLimit: vi.fn(), validateTranslateRequest: vi.fn(), translateText: vi.fn(), getRateLimitResetTime: vi.fn(), getTranslateRateLimitResetTime: vi.fn(), MAX_TRANSLATE_REQUESTS_PER_HOUR: 300, ValidationError, AiServiceError }; });
vi.mock("../../ai-refine.js", () => refine);
vi.mock("../../ai-translate.js", () => translate);
vi.mock("@fusion/core", async () => ({ ...(await vi.importActual<typeof import("@fusion/core")>("@fusion/core")), resolveImportTranslateSettingsModel: vi.fn(() => ({ provider: "p", modelId: "m" })), resolveTitleSummarizerSettingsModel: vi.fn() }));

type CacheEntry = { translatedTitle: string; translatedBody: string; detectedLocale: string | null };
function createStore() {
  const cache = new Map<string, CacheEntry>();
  const key = (value: unknown) => JSON.stringify(value);
  return {
    cache,
    getRootDir: () => "/root",
    getSettings: vi.fn().mockResolvedValue({ promptOverrides: {} }),
    getImportTranslation: vi.fn(async (value) => cache.get(key(value)) ?? null),
    recordImportTranslation: vi.fn(async (value, translation) => { cache.set(key(value), translation); }),
  };
}

function app(store = createStore()) {
  const router = express.Router();
  registerAiTextAssistantRoutes({ router, getProjectContext: vi.fn().mockResolvedValue({ store }) } as never);
  const server = express(); server.use(express.json()); server.use("/api", router);
  server.use((err: { statusCode?: number; message?: string; details?: unknown }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.statusCode ?? 500).json({ error: err.message, details: err.details }));
  return { server, store };
}

const identity = { provider: "github", repoKey: "fusion/fusion", issueNumber: 42 };
const body = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  fields: { title: "Bonjour", body: "Contenu" }, targetLocale: "en", ...identity, ...overrides,
});
const headers = { "Content-Type": "application/json" };

describe("registerAiTextAssistantRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refine.checkRateLimit.mockReturnValue(true);
    translate.checkRateLimit.mockReturnValue(true);
    translate.checkTranslateRateLimit.mockReturnValue(true);
    translate.validateTranslateRequest.mockImplementation((fields, targetLocale, _sourceLocale, candidateIdentity) => ({
      fields,
      targetLocale,
      importIdentity: candidateIdentity?.provider && candidateIdentity?.repoKey && candidateIdentity?.issueNumber
        ? candidateIdentity
        : undefined,
    }));
    translate.translateText.mockResolvedValue({ title: "Hello", body: "Content" });
  });

  it("maps refine validation, invalid types, happy responses, and rate limits", async () => {
    refine.validateRefineRequest.mockImplementationOnce(() => { throw new refine.ValidationError("bad text"); }).mockImplementationOnce(() => { throw new refine.InvalidTypeError("bad type"); }).mockReturnValueOnce({ text: "x", type: "clarify" });
    refine.refineText.mockResolvedValue("refined");
    const { server } = app();
    const invalid = await request(server, "POST", "/api/ai/refine-text", JSON.stringify({}), headers); expect(invalid.status).toBe(400);
    expect((await request(server, "POST", "/api/ai/refine-text", JSON.stringify({}), headers)).status).toBe(422);
    expect((await request(server, "POST", "/api/ai/refine-text", JSON.stringify({ text: "x", type: "clarify" }), headers)).body).toEqual({ refined: "refined" });
    refine.checkRateLimit.mockReturnValue(false);
    expect((await request(server, "POST", "/api/ai/refine-text", JSON.stringify({}), headers)).status).toBe(429);
  });

  it("uses the dedicated translate budget even after the shared refine budget is exhausted", async () => {
    refine.checkRateLimit.mockReturnValue(false);
    translate.checkTranslateRateLimit.mockReturnValue(true);
    const { server } = app();

    const response = await request(server, "POST", "/api/ai/translate-text", body(), headers);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ fields: { title: "Hello", body: "Content" } });
    expect(translate.checkTranslateRateLimit).toHaveBeenCalledTimes(1);
    expect(translate.checkRateLimit).not.toHaveBeenCalled();
  });

  it("persists an identified manual translation and serves an identical repeat without another model call", async () => {
    const { server, store } = app();

    expect((await request(server, "POST", "/api/ai/translate-text", body(), headers)).status).toBe(200);
    expect((await request(server, "POST", "/api/ai/translate-text", body(), headers)).status).toBe(200);

    expect(translate.translateText).toHaveBeenCalledTimes(1);
    expect(translate.checkTranslateRateLimit).toHaveBeenCalledTimes(1);
    expect(store.recordImportTranslation).toHaveBeenCalledTimes(1);
    expect(store.getImportTranslation).toHaveBeenCalledTimes(2);
  });

  it("re-translates when an identified issue body has changed", async () => {
    const { server } = app();
    await request(server, "POST", "/api/ai/translate-text", body(), headers);
    await request(server, "POST", "/api/ai/translate-text", body({ fields: { title: "Bonjour", body: "Edited content" } }), headers);

    expect(translate.translateText).toHaveBeenCalledTimes(2);
    expect(translate.checkTranslateRateLimit).toHaveBeenCalledTimes(2);
  });

  it("reads an identified cached translation without model calls or translate budget", async () => {
    const { server, store } = app();
    await request(server, "POST", "/api/ai/translate-text", body(), headers);
    translate.translateText.mockClear();
    translate.checkTranslateRateLimit.mockClear();

    const hit = await request(server, "GET", "/api/ai/import-translation?provider=github&repoKey=fusion%2Ffusion&issueNumber=42&targetLocale=en&title=Bonjour&body=Contenu");
    const miss = await request(server, "GET", "/api/ai/import-translation?provider=github&repoKey=fusion%2Ffusion&issueNumber=42&targetLocale=en&title=Bonjour&body=Changed");

    expect(hit.status).toBe(200);
    expect(hit.body).toEqual({ fields: { title: "Hello", body: "Content" } });
    expect(miss.status).toBe(200);
    expect(miss.body).toEqual({ fields: null });
    expect(translate.translateText).not.toHaveBeenCalled();
    expect(translate.checkTranslateRateLimit).not.toHaveBeenCalled();
    expect(store.getImportTranslation).toHaveBeenCalled();
  });

  it("returns distinct validation, service, and translate-rate-limit error codes", async () => {
    const { server } = app();
    translate.validateTranslateRequest.mockImplementationOnce(() => { throw new translate.ValidationError("fields is required"); });
    const validation = await request(server, "POST", "/api/ai/translate-text", body(), headers);
    const serviceError = new translate.AiServiceError("provider unavailable");
    serviceError.name = "AiServiceError";
    translate.translateText.mockRejectedValueOnce(serviceError);
    const service = await request(server, "POST", "/api/ai/translate-text", body(), headers);
    translate.checkTranslateRateLimit.mockReturnValue(false);
    const limit = await request(server, "POST", "/api/ai/translate-text", body(), headers);

    expect(validation).toMatchObject({ status: 400, body: { error: "TRANSLATE_VALIDATION_ERROR" } });
    expect(service).toMatchObject({ status: 503, body: { error: "TRANSLATE_SERVICE_ERROR" } });
    expect(limit).toMatchObject({ status: 429, body: { error: "TRANSLATE_RATE_LIMIT" } });
  });
});
