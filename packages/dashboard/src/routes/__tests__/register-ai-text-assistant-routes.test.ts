// @vitest-environment node
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerAiTextAssistantRoutes } from "../register-ai-text-assistant-routes.js";

const refine = vi.hoisted(() => { class ValidationError extends Error {}; class InvalidTypeError extends Error {}; class RateLimitError extends Error {}; class AiServiceError extends Error {}; return { checkRateLimit: vi.fn(), validateRefineRequest: vi.fn(), validateGoalDraftRequest: vi.fn(), refineText: vi.fn(), draftGoalDescription: vi.fn(), getRateLimitResetTime: vi.fn(), ValidationError, InvalidTypeError, RateLimitError, AiServiceError }; });
const translate = vi.hoisted(() => { class ValidationError extends Error {}; class AiServiceError extends Error {}; return { checkRateLimit: vi.fn(), validateTranslateRequest: vi.fn(), translateText: vi.fn(), getRateLimitResetTime: vi.fn(), ValidationError, AiServiceError }; });
vi.mock("../../ai-refine.js", () => refine);
vi.mock("../../ai-translate.js", () => translate);
vi.mock("@fusion/core", async () => ({ ...(await vi.importActual<typeof import("@fusion/core")>("@fusion/core")), resolveImportTranslateSettingsModel: vi.fn(() => ({ provider: "p", modelId: "m" })), resolveTitleSummarizerSettingsModel: vi.fn() }));

function app() {
  const router = express.Router();
  registerAiTextAssistantRoutes({ router, getProjectContext: vi.fn().mockResolvedValue({ store: { getRootDir: () => "/root", getSettings: vi.fn().mockResolvedValue({ promptOverrides: {} }) } }) } as never);
  const server = express(); server.use(express.json()); server.use("/api", router);
  server.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.statusCode ?? 500).json({ error: err.message }));
  return server;
}

describe("registerAiTextAssistantRoutes", () => {
  beforeEach(() => { vi.clearAllMocks(); refine.checkRateLimit.mockReturnValue(true); translate.checkRateLimit.mockReturnValue(true); });
  it("maps refine validation, invalid types, happy responses, and rate limits", async () => {
    refine.validateRefineRequest.mockImplementationOnce(() => { throw new refine.ValidationError("bad text"); }).mockImplementationOnce(() => { throw new refine.InvalidTypeError("bad type"); }).mockReturnValueOnce({ text: "x", type: "clarify" });
    refine.refineText.mockResolvedValue("refined");
    const server = app();
    const invalid = await request(server, "POST", "/api/ai/refine-text", JSON.stringify({}), { "Content-Type": "application/json" }); expect(invalid.status).toBe(400);
    expect((await request(server, "POST", "/api/ai/refine-text", JSON.stringify({}), { "Content-Type": "application/json" })).status).toBe(422);
    expect((await request(server, "POST", "/api/ai/refine-text", JSON.stringify({ text: "x", type: "clarify" }), { "Content-Type": "application/json" })).body).toEqual({ refined: "refined" });
    refine.checkRateLimit.mockReturnValue(false);
    expect((await request(server, "POST", "/api/ai/refine-text", JSON.stringify({}), { "Content-Type": "application/json" })).status).toBe(429);
  });
  it("validates, translates with the resolved model, and rate limits", async () => {
    translate.validateTranslateRequest.mockImplementationOnce(() => { throw new translate.ValidationError("bad fields"); }).mockReturnValueOnce({ fields: { title: "hi" } });
    translate.translateText.mockResolvedValue({ title: "bonjour" }); const server = app();
    expect((await request(server, "POST", "/api/ai/translate-text", JSON.stringify({}), { "Content-Type": "application/json" })).status).toBe(400);
    expect((await request(server, "POST", "/api/ai/translate-text", JSON.stringify({ fields: {}, targetLocale: "fr" }), { "Content-Type": "application/json" })).body).toEqual({ fields: { title: "bonjour" } });
    expect(translate.translateText).toHaveBeenCalledWith(expect.anything(), "/root", {}, expect.anything(), "p", "m");
    translate.checkRateLimit.mockReturnValue(false);
    expect((await request(server, "POST", "/api/ai/translate-text", JSON.stringify({}), { "Content-Type": "application/json" })).status).toBe(429);
  });
  it("validates, drafts, and rate limits goal descriptions", async () => {
    refine.validateGoalDraftRequest.mockImplementationOnce(() => { throw new refine.ValidationError("title required"); }).mockReturnValueOnce("Goal"); refine.draftGoalDescription.mockResolvedValue("draft"); const server = app();
    expect((await request(server, "POST", "/api/ai/draft-goal-description", JSON.stringify({}), { "Content-Type": "application/json" })).status).toBe(400);
    expect((await request(server, "POST", "/api/ai/draft-goal-description", JSON.stringify({ title: "Goal" }), { "Content-Type": "application/json" })).body).toEqual({ description: "draft" });
    refine.checkRateLimit.mockReturnValue(false);
    expect((await request(server, "POST", "/api/ai/draft-goal-description", JSON.stringify({}), { "Content-Type": "application/json" })).status).toBe(429);
  });
});
