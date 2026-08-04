import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegisterVoiceRoutes } from "../register-voice-routes.js";
import type { ApiRoutesContext } from "../types.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
async function harness(enabled: boolean, ready = false, projectId = "project-a") {
  const app = express(); const router = express.Router(); app.use(router);
  const scoped = { getSettings: async () => ({ voiceInput: { enabled } }), getGlobalSettingsStore: () => ({ getSettings: async () => ({}) }) };
  const manager = { getState: async () => ({ status: ready ? "installed" as const : "not-installed" as const, installedPath: ready ? "/model" : undefined }), peekState: () => ({ status: "not-installed" as const }), scheduleDownload: () => ({ accepted: false, state: { status: "error" as const, errorReason: "checksum-unpinned" as const } }), remove: async () => {}, download: async () => ({ status: "not-installed" as const }), subscribe: () => () => {} };
  const service = ready ? { getRuntimeStatus: async () => ({ status: "available" as const }), createSession: async () => ({ acceptChunk: () => ({ partial: "ok" }), finish: () => ({ text: "ok" }), close: () => {} }) } : undefined;
  createRegisterVoiceRoutes({ manager, ...(service ? { service } : {}) })({ router, getScopedStore: async () => scoped, getProjectIdFromRequest: () => projectId } as unknown as ApiRoutesContext);
  const server = app.listen(0); servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

describe("voice route authorization split", () => {
  it("reports a loadable installed runtime and honors the project voice override", async () => {
    const app = express();
    const router = express.Router();
    app.use(router);
    const manager = {
      getState: async () => ({ status: "installed" as const, installedPath: "/model" }),
      peekState: () => ({ status: "installed" as const, installedPath: "/model" }),
      scheduleDownload: () => ({ accepted: true as const, state: { status: "installed" as const } }),
      remove: async () => {},
      download: async () => ({ status: "installed" as const }),
      subscribe: () => () => {},
    };
    const service = {
      getRuntimeStatus: async () => ({ status: "available" as const }),
      createSession: async () => ({ acceptChunk: () => ({ partial: "ok" }), finish: () => ({ text: "ok" }), close: () => {} }),
    };
    createRegisterVoiceRoutes({ manager, service })({
      router,
      getScopedStore: async () => ({
        getSettings: async () => ({ voiceInput: { enabled: true, language: "en" } }),
        getGlobalSettingsStore: () => ({ getSettings: async () => ({ voiceInput: { enabled: false, model: "parakeet-v3" } }) }),
      }),
      getProjectIdFromRequest: () => "project-voice-override",
    } as unknown as ApiRoutesContext);
    const server = app.listen(0); servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/voice/status`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      modelId: "parakeet-v3",
      language: "en",
      model: { status: "installed" },
      runtime: { status: "available" },
    });
  });

  it("keeps an ordered partial/final session in its owning project through cleanup", async () => {
    const app = express(); const router = express.Router(); app.use(router);
    const acceptChunk = vi.fn((_audio: Buffer, options: { final: boolean }) => options.final ? { text: "final transcript" } : { partial: "partial transcript" });
    const close = vi.fn();
    createRegisterVoiceRoutes({
      manager: { getState: async () => ({ status: "installed" as const, installedPath: "/model" }), peekState: () => ({ status: "installed" as const, installedPath: "/model" }), scheduleDownload: () => ({ accepted: false as const, state: { status: "error" as const } }), remove: async () => {}, download: async () => ({ status: "installed" as const }), subscribe: () => () => {} },
      service: { getRuntimeStatus: async () => ({ status: "available" as const }), createSession: async () => ({ acceptChunk, finish: () => ({ text: "unused" }), close }) },
    })({ router, getScopedStore: async () => ({ getSettings: async () => ({ voiceInput: { enabled: true } }), getGlobalSettingsStore: () => ({ getSettings: async () => ({}) }) }), getProjectIdFromRequest: (request) => typeof request.query.projectId === "string" ? request.query.projectId : undefined } as unknown as ApiRoutesContext);
    const server = app.listen(0); servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
    const headers = { "content-type": "application/json" };
    const projectA = "voice-project";
    expect((await request(`/voice/status?projectId=${projectA}`)).status).toBe(200);
    const { sessionId } = await (await request(`/voice/session?projectId=${projectA}`, { method: "POST" })).json() as { sessionId: string };
    const partial = await request(`/voice/transcribe?projectId=${projectA}`, { method: "POST", headers, body: JSON.stringify({ sessionId, audio: "AAA=", sequence: 0, final: false, sampleRate: 16000, channels: 1, encoding: "pcm_s16le" }) });
    expect(await partial.json()).toMatchObject({ partial: "partial transcript", final: false });
    const final = await request(`/voice/transcribe?projectId=${projectA}`, { method: "POST", headers, body: JSON.stringify({ sessionId, audio: "AAA=", sequence: 1, final: true, sampleRate: 16000, channels: 1, encoding: "pcm_s16le" }) });
    expect(await final.json()).toMatchObject({ text: "final transcript", final: true });
    const foreign = await request(`/voice/transcribe?projectId=other-project`, { method: "POST", headers, body: JSON.stringify({ sessionId, audio: "AAA=", sequence: 2, final: false }) });
    expect(await foreign.json()).toEqual({ error: "unknown-session" });
    expect(await (await request(`/voice/session/${sessionId}?projectId=${projectA}`, { method: "DELETE" })).json()).toMatchObject({ closed: true, alreadyClosed: true });
    expect(acceptChunk).toHaveBeenNthCalledWith(1, Buffer.from([0, 0]), { final: false });
    expect(acceptChunk).toHaveBeenNthCalledWith(2, Buffer.from([0, 0]), { final: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it("allows lifecycle inspection while dictation is disabled", async () => {
    const request = await harness(false);
    expect((await request("/voice/status")).status).toBe(200);
    expect((await request("/voice/session", { method: "POST" })).status).toBe(409);
    expect(await (await request("/voice/model/download", { method: "POST" })).json()).toMatchObject({ error: "checksum-unpinned" });
    expect((await request("/voice/model", { method: "DELETE" })).status).toBe(200);
  });

  it("fences a pending session creation when model deletion starts", async () => {
    const app = express();
    const router = express.Router();
    app.use(router);
    const close = vi.fn();
    let resolveCreation!: (session: { acceptChunk: () => { partial: string }; finish: () => { text: string }; close: () => void }) => void;
    let resolveRemoval!: () => void;
    let signalCreation!: () => void;
    let signalRemoval!: () => void;
    const creationStarted = new Promise<void>((resolve) => { signalCreation = resolve; });
    const removalStarted = new Promise<void>((resolve) => { signalRemoval = resolve; });
    const manager = {
      getState: async () => ({ status: "installed" as const, installedPath: "/model" }),
      peekState: () => ({ status: "installed" as const, installedPath: "/model" }),
      scheduleDownload: () => ({ accepted: true as const, state: { status: "installed" as const } }),
      remove: async () => { signalRemoval(); await new Promise<void>((resolve) => { resolveRemoval = resolve; }); },
      download: async () => ({ status: "installed" as const }),
      subscribe: () => () => {},
    };
    const service = {
      getRuntimeStatus: async () => ({ status: "available" as const }),
      createSession: async () => {
        signalCreation();
        return new Promise<{ acceptChunk: () => { partial: string }; finish: () => { text: string }; close: () => void }>((resolve) => { resolveCreation = resolve; });
      },
    };
    createRegisterVoiceRoutes({ manager, service })({
      router,
      getScopedStore: async () => ({ getSettings: async () => ({ voiceInput: { enabled: true } }), getGlobalSettingsStore: () => ({ getSettings: async () => ({}) }) }),
      getProjectIdFromRequest: () => "epoch-project",
    } as unknown as ApiRoutesContext);
    const server = app.listen(0); servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

    const creating = request("/voice/session", { method: "POST" });
    await creationStarted;
    const deleting = request("/voice/model", { method: "DELETE" });
    await removalStarted;
    resolveCreation({ acceptChunk: () => ({ partial: "" }), finish: () => ({ text: "" }), close });
    const rejected = await creating;
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "unavailable", reason: "model-removed" });
    expect(close).toHaveBeenCalledOnce();
    resolveRemoval();
    expect((await deleting).status).toBe(200);
  });

  it("rejects non-canonical base64 before it reaches the recognizer", async () => {
    const request = await harness(true, true);
    const created = await request("/voice/session", { method: "POST" });
    const { sessionId } = await created.json() as { sessionId: string };
    const response = await request("/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, audio: "AAAAAAAAA=", sequence: 0, final: false }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid-audio-payload" });
  });

  it("maps malformed and oversized voice JSON to API errors", async () => {
    const request = await harness(true);
    const malformed = await request("/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect([400, 409]).toContain(malformed.status);
    const huge = await request("/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audio: "x".repeat(2 * 1024 * 1024 + 1) }) });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ error: "payload-too-large", limitBytes: 2 * 1024 * 1024 });
  });

  it("keeps closed sessions as project-bound DELETE tombstones", async () => {
    const owner = await harness(true, true, "owner");
    const foreign = await harness(true, true, "foreign");
    const { sessionId } = await (await owner("/voice/session", { method: "POST" })).json() as { sessionId: string };
    expect(await (await owner(`/voice/session/${sessionId}`, { method: "DELETE" })).json()).toEqual({ sessionId, closed: true, alreadyClosed: false });
    expect(await (await owner(`/voice/session/${sessionId}`, { method: "DELETE" })).json()).toEqual({ sessionId, closed: true, alreadyClosed: true });
    const foreignResponse = await foreign(`/voice/session/${sessionId}`, { method: "DELETE" });
    const unknownResponse = await foreign("/voice/session/never-existed", { method: "DELETE" });
    expect(foreignResponse.status).toBe(404);
    expect(await foreignResponse.text()).toBe(await unknownResponse.text());
  });

  it("enforces the active-session cap per project and frees capacity at tombstone close", async () => {
    const request = await harness(true, true, "capacity-project");
    const created = await Promise.all(Array.from({ length: 8 }, () => request("/voice/session", { method: "POST" })));
    expect(created.every((response) => response.status === 201)).toBe(true);
    expect((await request("/voice/session", { method: "POST" })).status).toBe(429);
    const { sessionId } = await created[0].json() as { sessionId: string };
    expect((await request(`/voice/session/${sessionId}`, { method: "DELETE" })).status).toBe(200);
    expect((await request("/voice/session", { method: "POST" })).status).toBe(201);
    // A different scoped project has an independent eight-session budget.
    const other = await harness(true, true, "capacity-other");
    expect((await other("/voice/session", { method: "POST" })).status).toBe(201);
  });

  it("retains TTL and size-cap closures as tombstones before evicting them", async () => {
    const request = await harness(true, true, "expiry-project");
    const created = await request("/voice/session", { method: "POST" });
    const { sessionId } = await created.json() as { sessionId: string };
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base + 60_001);
    const expired = await request("/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, audio: "AAA=", sequence: 0, final: false }) });
    expect(await expired.json()).toEqual({ error: "session-closed", reason: "ttl-expired" });
    vi.setSystemTime(base + 120_002);
    const evicted = await request("/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, audio: "AAA=", sequence: 0, final: false }) });
    expect(await evicted.json()).toEqual({ error: "unknown-session" });
    vi.useRealTimers();
  });

  it("sweeps expired sessions before model deletion preserves their TTL tombstone", async () => {
    const request = await harness(true, true, "delete-sweep-project");
    const { sessionId } = await (await request("/voice/session", { method: "POST" })).json() as { sessionId: string };
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base + 60_001);
    expect((await request("/voice/model", { method: "DELETE" })).status).toBe(200);
    const expired = await request("/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, audio: "AAA=", sequence: 0, final: false }) });
    expect(await expired.json()).toEqual({ error: "session-closed", reason: "ttl-expired" });
    vi.useRealTimers();
  });

  it("keeps a size-cap tombstone at 413 until eviction", async () => {
    const request = await harness(true, true, "size-cap-project");
    const { sessionId } = await (await request("/voice/session", { method: "POST" })).json() as { sessionId: string };
    // The cap is checked before recognizer work; setting an already-capped session through
    // sixteen 1 MiB chunks would add slow, low-signal HTTP work to this focused route test.
    const oversized = await request("/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, audio: Buffer.alloc(1024 * 1024 + 2).toString("base64"), sequence: 0, final: false }) });
    expect(await oversized.json()).toEqual({ error: "payload-too-large", limitBytes: 1024 * 1024 });
    const repeated = await request("/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, audio: "AAA=", sequence: 0, final: false }) });
    expect(await repeated.json()).toEqual({ error: "payload-too-large", limitBytes: 16 * 1024 * 1024 });
  });
});
