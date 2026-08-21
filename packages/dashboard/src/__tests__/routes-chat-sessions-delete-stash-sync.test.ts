// @vitest-environment node
import express from "express";
import multer from "multer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StashChatSessionDeleteResult } from "@fusion/core";
import { DEFAULT_STASH_URL } from "@fusion/core";
import { request } from "../test-request.js";
import { registerChatRoutes } from "../routes/register-chat-routes.js";

/*
FNXC:RUFU121DeleteSync 2026-08-18-20:55:
RUFU-121 Step 5: DELETE /api/chat/sessions/:id fires a best-effort, NON-BLOCKING Stash
session delete sync after the local delete succeeds. These tests stub the Stash helper
(deleteStashChatSession) and the logger (createLogger) while keeping resolveStashMemorySettings
real, and assert the four contract points: (a) the route responds {success:true} WITHOUT
awaiting the Stash call (deferred-promise proof), (b) a Stash rejection still yields
{success:true}, logs a warn, and produces no unhandled rejection, (c) memory-disabled /
non-stash / missing-key skip the helper entirely, and (d) the 404 local-delete contract is
unchanged. No real network: the helper is fully mocked.
*/
const mocks = vi.hoisted(() => ({
  deleteStashChatSession: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    deleteStashChatSession: mocks.deleteStashChatSession,
    createLogger: () => mocks.logger,
  };
});

const STASH_OK_SETTINGS = {
  memoryEnabled: true,
  memoryBackendType: "stash",
  stashUrl: "http://stash.test",
  stashApiKey: "key-123",
};

interface BuildOpts {
  settings?: Record<string, unknown>;
  deleteSessionResult: boolean;
  getSecretsStore?: () => Promise<unknown> | undefined;
}

function buildApp(opts: BuildOpts) {
  const deleteSession = vi.fn(async () => opts.deleteSessionResult);
  const scopedStore = {
    getFusionDir: () => "/route-project/.fusion",
    getAsyncLayer: () => undefined,
    getSettings: async () => opts.settings,
    ...(opts.getSecretsStore ? { getSecretsStore: opts.getSecretsStore } : {}),
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerChatRoutes(
    {
      router,
      store: scopedStore,
      options: { chatStore: { deleteSession } },
      getProjectContext: async () => ({ store: scopedStore, projectId: "project-1", engine: undefined }),
      rethrowAsApiError: (error: unknown) => {
        throw error;
      },
    } as never,
    {
      parseLastEventId: () => undefined,
      replayBufferedSSE: () => false,
      validateOptionalModelField: () => undefined,
      upload: multer(),
    },
  );
  app.use("/api", router);
  // The route rethrows ApiError; without a boundary the 404 path would hang rather than assert a status.
  app.use(
    (err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "unknown" });
    },
  );
  return { app, deleteSession };
}

async function flushMacrotasks() {
  await new Promise((r) => setImmediate(r));
}

describe("DELETE /api/chat/sessions/:id — Stash delete sync (RUFU-121 Step 5)", () => {
  afterEach(() => {
    mocks.deleteStashChatSession.mockReset();
    mocks.logger.debug.mockClear();
    mocks.logger.info.mockClear();
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
  });

  it("(a) responds {success:true} WITHOUT awaiting the Stash delete (deferred-promise proof)", async () => {
    const { app, deleteSession } = buildApp({ settings: STASH_OK_SETTINGS, deleteSessionResult: true });

    let stashSettled = false;
    let resolveStash!: (v: StashChatSessionDeleteResult) => void;
    const stashPromise = new Promise<StashChatSessionDeleteResult>((resolve) => {
      resolveStash = (v) => {
        stashSettled = true;
        resolve(v);
      };
    });
    mocks.deleteStashChatSession.mockImplementation(() => stashPromise);

    const res = await request(app, "DELETE", "/api/chat/sessions/chat-abc12345");

    // The response completed while the deferred Stash promise was still pending — if the route
    // had awaited the sync, request() would not have resolved yet.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(deleteSession).toHaveBeenCalledWith("chat-abc12345");
    expect(stashSettled).toBe(false);

    // Let the fire-and-forget IIFE reach the (stubbed) helper and assert the exact session id.
    await vi.waitFor(() => expect(mocks.deleteStashChatSession).toHaveBeenCalledTimes(1));
    expect(mocks.deleteStashChatSession).toHaveBeenCalledWith("http://stash.test", "key-123", "chat-abc12345");
    expect(stashSettled).toBe(false);

    // Drain the deferred promise so nothing dangles after the test.
    resolveStash({ deleted: true, status: "ok" });
    await stashPromise;
    expect(stashSettled).toBe(true);
  });

  /*
  FNXC:RUFU121DeleteSyncUrl 2026-08-18-21:59:
  Code-review remediation: the operator's default configuration sets memoryEnabled +
  backend=stash WITHOUT an explicit stashUrl (capture targets the built-in
  DEFAULT_STASH_URL via resolveMemoryBackend's fallback). The sync must target the
  SAME server — an unset/blank stashUrl falls back to DEFAULT_STASH_URL, and only an
  empty API key skips the call (the pre-fix `!stashUrl` gate made the sync a silent
  no-op in exactly this configuration, so deleted chats kept leaking into Stash).
  */
  it("(a2) stash backend with UNSET stashUrl + settings key -> helper called with DEFAULT_STASH_URL", async () => {
    const { app } = buildApp({
      settings: { memoryEnabled: true, memoryBackendType: "stash", stashApiKey: "key-123" },
      deleteSessionResult: true,
    });

    const res = await request(app, "DELETE", "/api/chat/sessions/chat-abc12345");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    await vi.waitFor(() => expect(mocks.deleteStashChatSession).toHaveBeenCalledTimes(1));
    expect(mocks.deleteStashChatSession).toHaveBeenCalledWith(DEFAULT_STASH_URL, "key-123", "chat-abc12345");
  });

  /*
  FNXC:RUFU121DeleteSyncBlankUrl 2026-08-21-13:35:
  RUFU-146 review (PRRT_kwDOSA-8Y86bC_sS): (a3) claimed to cover a BLANK
  stashUrl but omitted the key, so it only re-proved the UNSET case of (a2).
  A whitespace-only configured value is the real blank shape (operators paste
  URLs with stray spaces); set it explicitly so this test exercises the
  trim→DEFAULT_STASH_URL fallback while the key still resolves from the global
  secret — the two axes the route must handle independently.
  */
  it("(a3) stash backend with BLANK stashUrl + key resolved from the global secret -> helper called with DEFAULT_STASH_URL + secret key", async () => {
    const { app } = buildApp({
      // Blank (whitespace-only) stashUrl — NOT unset: the trim fallback to
      // DEFAULT_STASH_URL must fire on the configured value itself. No
      // stashApiKey: the key comes from the global stash-api-key secret via
      // listSecrets → revealSecret (real resolveStashMemorySettings, unmocked).
      settings: { memoryEnabled: true, memoryBackendType: "stash", stashUrl: "   	 " },
      deleteSessionResult: true,
      getSecretsStore: async () => ({
        listSecrets: async () => [{ id: "secret-row-uuid-1", key: "stash-api-key" }],
        revealSecret: async (id: string, scope: string) => {
          expect(id).toBe("secret-row-uuid-1");
          expect(scope).toBe("global");
          return { plaintextValue: "secret-key-999" };
        },
      }),
    });

    const res = await request(app, "DELETE", "/api/chat/sessions/chat-abc12345");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    await vi.waitFor(() => expect(mocks.deleteStashChatSession).toHaveBeenCalledTimes(1));
    expect(mocks.deleteStashChatSession).toHaveBeenCalledWith(DEFAULT_STASH_URL, "secret-key-999", "chat-abc12345");
  });

  it("(b) Stash rejection: still {success:true}, logs a warn, no unhandled rejection", async () => {
    const { app } = buildApp({ settings: STASH_OK_SETTINGS, deleteSessionResult: true });
    mocks.deleteStashChatSession.mockRejectedValue(new Error("stash down"));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const res = await request(app, "DELETE", "/api/chat/sessions/chat-abc12345");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      await vi.waitFor(() => expect(mocks.deleteStashChatSession).toHaveBeenCalledTimes(1));
      // The IIFE's catch must log a warn (the sync failed) — the sync is best-effort, not fatal.
      await vi.waitFor(() => expect(mocks.logger.warn).toHaveBeenCalled());
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining("chat-abc12345"));

      // Give any (incorrectly) unhandled rejection a chance to surface, then assert none.
      await flushMacrotasks();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("(c1) memory disabled -> helper never called, still {success:true}", async () => {
    const { app } = buildApp({
      settings: { memoryEnabled: false, memoryBackendType: "stash", stashUrl: "http://stash.test", stashApiKey: "key-123" },
      deleteSessionResult: true,
    });

    const res = await request(app, "DELETE", "/api/chat/sessions/chat-abc12345");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    await flushMacrotasks();
    expect(mocks.deleteStashChatSession).not.toHaveBeenCalled();
  });

  it("(c2) non-stash backend -> helper never called, still {success:true}", async () => {
    const { app } = buildApp({
      settings: { memoryEnabled: true, memoryBackendType: "file", stashUrl: "http://stash.test", stashApiKey: "key-123" },
      deleteSessionResult: true,
    });

    const res = await request(app, "DELETE", "/api/chat/sessions/chat-abc12345");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    await flushMacrotasks();
    expect(mocks.deleteStashChatSession).not.toHaveBeenCalled();
  });

  it("(c3) stash backend with missing key (no settings key, no secret) -> helper never called", async () => {
    const { app } = buildApp({
      settings: { memoryEnabled: true, memoryBackendType: "stash", stashUrl: "http://stash.test" },
      deleteSessionResult: true,
      // No getSecretsStore on the store -> resolveStashMemorySettings degrades to an empty key.
    });

    const res = await request(app, "DELETE", "/api/chat/sessions/chat-abc12345");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    await flushMacrotasks();
    expect(mocks.deleteStashChatSession).not.toHaveBeenCalled();
  });

  it("(c4) stash backend with UNSET stashUrl AND missing key -> helper never called (key gate still holds)", async () => {
    const { app } = buildApp({
      settings: { memoryEnabled: true, memoryBackendType: "stash" },
      deleteSessionResult: true,
      // No getSecretsStore on the store -> resolveStashMemorySettings degrades to an empty key.
    });

    const res = await request(app, "DELETE", "/api/chat/sessions/chat-abc12345");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    await flushMacrotasks();
    expect(mocks.deleteStashChatSession).not.toHaveBeenCalled();
  });

  it("(d) local-delete miss still 404s (contract unchanged) and never calls the Stash helper", async () => {
    const { app, deleteSession } = buildApp({ settings: STASH_OK_SETTINGS, deleteSessionResult: false });

    const res = await request(app, "DELETE", "/api/chat/sessions/chat-missing");
    expect(res.status).toBe(404);
    expect(deleteSession).toHaveBeenCalledWith("chat-missing");
    await flushMacrotasks();
    expect(mocks.deleteStashChatSession).not.toHaveBeenCalled();
  });
});
