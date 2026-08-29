import { randomUUID } from "node:crypto";
import express from "express";
import type { VoiceInputSettings } from "@fusion/core";
import { createVoiceModelManager } from "../stt/model-manager.js";
import { createParakeetService, VoiceInputError } from "../stt/parakeet-service.js";
import { DEFAULT_VOICE_LANGUAGE, DEFAULT_VOICE_MODEL_ID, resolveVoiceLanguage, resolveVoiceModelId } from "../stt/types.js";
import type { ApiRouteRegistrar } from "./types.js";

const defaultManager = createVoiceModelManager();
const defaultService = createParakeetService({ manager: defaultManager });
type Session = { projectId?: string; recognizer: Awaited<ReturnType<typeof defaultService.createSession>>; next: number; bytes: number; last: number; expires: number; closed?: string; tombstone?: number };
const sessions = new Map<string, Session>();
// Session creation awaits native initialization; reservations close the await-window race.
const pendingSessionReservations = new Map<string | undefined, number>();

/**
 * FNXC:VoiceInput 2026-07-21-21:10:
 * Model deletion fences pending native session creation immediately. A creation that began
 * before shared-cache removal must close its just-created recognizer and remain unavailable;
 * it must never insert an active session backed by a removed model.
 */
let modelEpoch = 0;
const LIMIT = 1024 * 1024; const TOTAL_LIMIT = 16 * LIMIT;

/** FNXC:VoiceInput 2026-07-21-12:00: voice mode is opt-in, but model lifecycle remains usable while off so operators can install from settings first. */
async function settingsFor(ctx: Parameters<ApiRouteRegistrar>[0], req: express.Request) {
  const scoped = await ctx.getScopedStore(req); const project = await scoped.getSettings() as { voiceInput?: VoiceInputSettings };
  const global = await scoped.getGlobalSettingsStore().getSettings() as { voiceInput?: VoiceInputSettings };
  const voice = { ...global.voiceInput, ...project.voiceInput }; return { voice, projectId: ctx.getProjectIdFromRequest(req) };
}
function sweep() { const now = Date.now(); for (const [id, session] of sessions) { if (!session.closed && (now - session.last > 60_000 || now > session.expires)) { session.recognizer.close(); session.closed = "ttl-expired"; session.tombstone = now + 60_000; } if (session.closed && (session.tombstone ?? 0) <= now) sessions.delete(id); } }
function error(res: express.Response, code: number, body: object) { res.status(code).json(body); }

/**
 * FNXC:VoiceInput 2026-07-21-19:10:
 * Audio chunks use canonical standard base64. Node's permissive decoder accepts malformed
 * padding, so validate structure and round-trip equality before audio reaches a recognizer.
 */
function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (!value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

export function createRegisterVoiceRoutes(deps: { manager?: typeof defaultManager; service?: typeof defaultService } = {}): ApiRouteRegistrar {
  const manager = deps.manager ?? defaultManager;
  const service = deps.service ?? defaultService;
  return (ctx) => {
  const { router } = ctx;
  const voiceStatus = async (req: express.Request) => {
    const { voice } = await settingsFor(ctx, req);
    const model = resolveVoiceModelId(voice.model);
    const language = resolveVoiceLanguage(voice.language);
    const modelState = manager.peekState().status === "queued" || manager.peekState().status === "downloading" ? manager.peekState() : await manager.getState();
    return { enabled: voice.enabled === true, modelId: "id" in model ? model.id : undefined, language: "language" in language ? language.language : undefined, unsupportedModel: "unsupported" in model ? model.unsupported : undefined, unsupportedLanguage: "unsupported" in language ? language.unsupported : undefined, model: modelState, runtime: await service.getRuntimeStatus() };
  };
  router.get("/voice/status", async (req, res) => { res.json(await voiceStatus(req)); });
  router.post("/voice/runtime/recheck", async (req, res) => { service.resetRuntime(); res.json(await voiceStatus(req)); });
  router.post("/voice/model/download", async (req, res) => { const { voice } = await settingsFor(ctx, req); const model = resolveVoiceModelId(voice.model); if ("unsupported" in model) return error(res, 400, { error: "unsupported-model", value: model.unsupported, supported: [DEFAULT_VOICE_MODEL_ID] }); const scheduled = manager.scheduleDownload(); if (!scheduled.accepted) return error(res, 409, { error: scheduled.state.errorReason }); res.status(202).json({ state: scheduled.state }); });
  router.delete("/voice/model", async (_req, res) => {
    // Increment before awaiting cleanup so pending createSession() calls are fenced immediately.
    modelEpoch++;
    sweep();
    await manager.remove();
    const now = Date.now();
    for (const session of sessions.values()) if (!session.closed) {
      session.recognizer.close();
      session.closed = "model-removed";
      session.tombstone = now + 60_000;
    }
    res.json({ state: manager.peekState() });
  });
  router.post("/voice/session", async (req, res) => { sweep(); const { voice, projectId } = await settingsFor(ctx, req); if (voice.enabled !== true) return error(res, 409, { error: "disabled" }); const model = resolveVoiceModelId(voice.model); const language = resolveVoiceLanguage(voice.language); if ("unsupported" in model) return error(res, 400, { error: "unsupported-model", value: model.unsupported, supported: [DEFAULT_VOICE_MODEL_ID] }); if ("unsupported" in language) return error(res, 400, { error: "unsupported-language", value: language.unsupported, supported: [DEFAULT_VOICE_LANGUAGE] }); const active = [...sessions.values()].filter((s) => !s.closed && s.projectId === projectId).length; const reserved = pendingSessionReservations.get(projectId) ?? 0; if (active + reserved >= 8) return error(res, 429, { error: "too-many-sessions" });
    // FNXC:VoiceInput 2026-07-21-20:30: Reserve before native session creation awaits so
    // concurrent requests cannot all pass the eight-active-session capacity check.
    pendingSessionReservations.set(projectId, reserved + 1);
    const creationEpoch = modelEpoch;
    try {
      const recognizer = await service.createSession({ modelId: model.id, language: language.language });
      if (creationEpoch !== modelEpoch) {
        recognizer.close();
        return error(res, 409, { error: "unavailable", reason: "model-removed" });
      }
      const id = randomUUID();
      const now = Date.now();
      sessions.set(id, { projectId, recognizer, next: 0, bytes: 0, last: now, expires: now + 300_000 });
      res.status(201).json({ sessionId: id, expiresAt: new Date(now + 300_000).toISOString(), modelId: model.id, language: language.language });
    } catch (e) {
      return error(res, 409, { error: "unavailable", reason: e instanceof Error ? e.message : "unavailable" });
    } finally {
      const remaining = (pendingSessionReservations.get(projectId) ?? 1) - 1;
      if (remaining > 0) pendingSessionReservations.set(projectId, remaining); else pendingSessionReservations.delete(projectId);
    }
  });
  const parserError: express.ErrorRequestHandler = (err, _req, res, next) => { if (err?.type === "entity.too.large") return error(res, 413, { error: "payload-too-large", limitBytes: 2 * LIMIT }); if (err instanceof SyntaxError) return error(res, 400, { error: "invalid-request" }); next(err); };
  router.post("/voice/transcribe", express.json({ limit: "2mb" }), parserError, async (req: express.Request, res: express.Response) => { sweep(); const { voice, projectId } = await settingsFor(ctx, req); if (voice.enabled !== true) return error(res, 409, { error: "disabled" }); const body = req.body as { sessionId?: unknown; audio?: unknown; sequence?: unknown; final?: unknown; sampleRate?: unknown; channels?: unknown; encoding?: unknown; }; if (!body || typeof body.sessionId !== "string" || typeof body.audio !== "string" || typeof body.sequence !== "number" || typeof body.final !== "boolean") return error(res, 400, { error: "invalid-request" }); const session = sessions.get(body.sessionId); if (!session || session.projectId !== projectId) return error(res, 404, { error: "unknown-session" }); if (session.closed) return session.closed === "size-cap-exceeded" ? error(res, 413, { error: "payload-too-large", limitBytes: TOTAL_LIMIT }) : error(res, 409, { error: "session-closed", reason: session.closed }); if (body.sequence !== session.next) return error(res, 400, { error: "out-of-order-chunk", expected: session.next }); if ((body.sampleRate !== undefined && body.sampleRate !== 16000) || (body.channels !== undefined && body.channels !== 1) || (body.encoding !== undefined && body.encoding !== "pcm_s16le")) return error(res, 400, { error: "unsupported-audio-format", expected: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } }); const audio = decodeCanonicalBase64(body.audio); if (!audio || !audio.length || audio.length % 2) return error(res, 400, { error: "invalid-audio-payload" }); if (audio.length > LIMIT || session.bytes + audio.length > TOTAL_LIMIT) { session.recognizer.close(); session.closed = "size-cap-exceeded"; session.tombstone = Date.now() + 60_000; return error(res, 413, { error: "payload-too-large", limitBytes: audio.length > LIMIT ? LIMIT : TOTAL_LIMIT }); } try { const result = session.recognizer.acceptChunk(audio, { final: body.final }); session.next++; session.bytes += audio.length; session.last = Date.now(); if (body.final) { session.recognizer.close(); session.closed = "completed"; session.tombstone = Date.now() + 60_000; return res.json({ sessionId: body.sessionId, sequence: body.sequence, text: result.text ?? "", final: true }); } return res.json({ sessionId: body.sessionId, sequence: body.sequence, partial: result.partial ?? "", final: false }); } catch (e) { return error(res, e instanceof VoiceInputError ? 400 : 409, { error: e instanceof VoiceInputError ? e.code : "unavailable" }); } });
  router.delete("/voice/session/:id", async (req, res) => { sweep(); const { voice, projectId } = await settingsFor(ctx, req); if (voice.enabled !== true) return error(res, 409, { error: "disabled" }); const session = sessions.get(req.params.id); if (!session || session.projectId !== projectId) return error(res, 404, { error: "unknown-session" }); if (session.closed) return res.json({ sessionId: req.params.id, closed: true, alreadyClosed: true }); session.recognizer.close(); session.closed = "deleted"; session.tombstone = Date.now() + 60_000; res.json({ sessionId: req.params.id, closed: true, alreadyClosed: false }); });  };
}

export const registerVoiceRoutes = createRegisterVoiceRoutes();
