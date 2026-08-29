// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request } from "../test-request.js";

/**
 * FNXC:VoiceInput 2026-07-21-18:20:
 * This intentionally boots server.ts rather than a registrar-only router. The global JSON
 * middleware is installed before registrars, so only this path proves the voice exclusion is
 * load-bearing while all other API routes retain the existing 100 KiB budget.
 */
class VoiceParserStore extends EventEmitter {
  constructor(private readonly voiceEnabled = false) { super(); }
  getRootDir() { return process.cwd(); }
  getFusionDir() { return `${process.cwd()}/.fusion`; }
  getSettings = vi.fn(async (): Promise<Settings> => ({ voiceInput: { enabled: this.voiceEnabled } } as Settings));
  getSettingsFast = this.getSettings;
  getGlobalSettingsStore = () => ({ getSettings: async () => ({}) });
  getAsyncLayer = vi.fn(() => ({ db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })) } }));
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
  getTaskWorkflowSelection = vi.fn();
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "default");
}

const app = (voiceEnabled = false) => createServer(new VoiceParserStore(voiceEnabled) as unknown as TaskStore, { noAuth: true });

describe("voice body parser middleware boundary", () => {
  it("lets a voice JSON body above the global 100 KiB limit reach the chunk handler intact", async () => {
    // Enable dictation so the handler must read sessionId after its 2 MiB parser, rather than
    // rejecting on the guard before consuming the parsed request body.
    const server = app(true);
    const body = JSON.stringify({ sessionId: "never", audio: "A".repeat(110 * 1024), sequence: 0, final: false });
    const response = await request(server, "POST", "/api/voice/transcribe", body, { "content-type": "application/json" });
    // The route proves it received the complete parsed session id; without the server.ts
    // exclusion Express rejects this same request at the global 100 KiB parser with 413.
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "unknown-session" });
  });

  it("treats the trailing-slash spelling as the same 2 MiB voice endpoint", async () => {
    const server = app(true);
    const body = JSON.stringify({ sessionId: "never", audio: "A".repeat(110 * 1024), sequence: 0, final: false });
    const response = await request(server, "POST", "/api/voice/transcribe/", body, { "content-type": "application/json" });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "unknown-session" });
  });

  it("keeps the global 100 KiB JSON budget outside the one voice exclusion", async () => {
    const overGlobalLimit = await request(app(), "POST", "/api/no-such-json-route", JSON.stringify({ payload: "x".repeat(110 * 1024) }), { "content-type": "application/json" });
    expect(overGlobalLimit.status).toBe(413);
    expect(overGlobalLimit.body).toEqual({ error: "payload-too-large" });
  });

  it("maps voice parser size and JSON syntax errors to the public JSON contract", async () => {
    const tooLarge = await request(app(), "POST", "/api/voice/transcribe", JSON.stringify({ audio: "A".repeat(2 * 1024 * 1024 + 1) }), { "content-type": "application/json" });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toEqual({ error: "payload-too-large", limitBytes: 2 * 1024 * 1024 });
    const malformed = await request(app(), "POST", "/api/voice/transcribe", "{", { "content-type": "application/json" });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "invalid-request" });
  });
});
