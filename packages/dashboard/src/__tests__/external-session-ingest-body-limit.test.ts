// @vitest-environment node
/*
FNXC:ExternalSessions 2026-09-23-11:10:
Collector ingestion bodies can legitimately exceed Express's 100 KiB default: the turn contract admits
prompts and patches up to 256 KiB and a response up to 1 MiB, and the host collector spools turns up to
2 MiB. With the default parser a 131 KiB turn was rejected as a bare 413 before collector authentication,
and because turns are delivered in order it blocked every later turn on that host indefinitely.

The body parser runs before routing, so any route answer (401 without a collector credential, 404 for an
unknown project in this minimal server) proves the parser admitted the body; 413 means it did not.
*/
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";

import { createServer } from "../server.js";
import { request } from "../test-request.js";

class MinimalStore extends EventEmitter {
  constructor(private readonly rootDir: string) { super(); }
  getRootDir() { return this.rootDir; }
  getFusionDir() { return join(this.rootDir, ".fusion"); }
  getSettings = vi.fn(async (): Promise<Settings> => ({} as Settings));
  getSettingsFast = this.getSettings;
  getGlobalSettingsStore = () => ({ getSettings: async () => ({}) });
  getAsyncLayer = vi.fn(() => ({ db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })) } }));
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
  getTaskWorkflowSelection = vi.fn();
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "default");
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function server() {
  const root = await mkdtemp(join(tmpdir(), "fusion-ingest-limit-"));
  roots.push(root);
  return createServer(new MinimalStore(root) as unknown as TaskStore, { headless: true } as never);
}

const bodyOf = (bytes: number) => JSON.stringify({ schemaVersion: 1, padding: "x".repeat(bytes) });

describe("external-session ingestion body limit", () => {
  for (const operation of ["turn-ingest", "ingest"] as const) {
    it(`admits a ${operation} body larger than 100 KiB past the parser`, async () => {
      const app = await server();
      const res = await request(app, "POST", `/api/external-sessions/${operation}?projectId=p`, bodyOf(140 * 1024), {
        "content-type": "application/json",
      });
      expect(res.status).not.toBe(413);
      expect([401, 404]).toContain(res.status);
    });
  }

  it("still rejects a body above the collector's 2 MiB turn cap", async () => {
    const app = await server();
    const res = await request(app, "POST", "/api/external-sessions/turn-ingest?projectId=p", bodyOf(2 * 1024 * 1024 + 4096), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(413);
  });

  it("keeps the 100 KiB default for other routes", async () => {
    const app = await server();
    const res = await request(app, "POST", "/api/external-sessions/sessions?projectId=p", bodyOf(140 * 1024), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(413);
  });
});
