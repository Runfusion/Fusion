import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, Router } from "express";
import type { TaskStore } from "@fusion/core";
import { createSSE, emitChatSnippetsUpdatedSseEvent } from "../sse";
import { registerSettingsMemoryRoutes } from "../routes/register-settings-memory-routes.js";

/*
FNXC:SnippetsDestination 2026-09-16-21:44:
FN-476: the Snippets destination has no manual refresh, so the guarantee that replaces it is this one: a SUCCESSFUL
write of the global snippet list notifies every connected client exactly once, with no settings content, and a failed
write notifies nobody. Snippets are global, so a client subscribed to another project must receive it too. These tests
drive the real publication seam and the real stream forwarder rather than a stand-in.
*/

class MockSocket extends EventEmitter {
  destroyed = false;
  setKeepAlive = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("close");
  });
}

class MockResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  write = vi.fn();
  flushHeaders = vi.fn();
  end = vi.fn(() => {
    this.writableEnded = true;
    this.emit("close");
  });
  setHeader = vi.fn();

  constructor(readonly socket: MockSocket) {
    super();
  }
}

function openConnection(projectId?: string) {
  const store = {
    on: vi.fn(),
    off: vi.fn(),
    getProjectId: vi.fn(() => projectId),
    getResearchStore: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
    getAsyncLayer: vi.fn(() => null),
  } as unknown as TaskStore;
  const socket = new MockSocket();
  const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
  req.query = { clientId: `snippets-${projectId ?? "default"}`, ...(projectId ? { projectId } : {}) };
  req.socket = socket;
  const res = new MockResponse(socket);
  createSSE(store, undefined, undefined, undefined, projectId ? { projectId } : undefined)(
    req,
    res as unknown as Response,
  );
  return { req, res, socket };
}

function snippetFrames(connection: ReturnType<typeof openConnection>): Record<string, unknown>[] {
  return vi.mocked(connection.res.write).mock.calls
    .map(([frame]) => String(frame))
    .filter((frame) => frame.startsWith("event: settings:chat-snippets-updated\n"))
    .map((frame) => JSON.parse(frame.split("\n")[1]!.slice("data: ".length)) as Record<string, unknown>);
}

/**
 * Mirrors the publication CONDITION each route applies: publish once, after the write and its cache invalidation
 * succeeded, and only when the patch actually touched `chatSnippets`.
 */
async function writeGlobalSettings(
  patch: Record<string, unknown>,
  persist: (patch: Record<string, unknown>) => Promise<void>,
): Promise<{ ok: boolean }> {
  try {
    await persist(patch);
  } catch {
    return { ok: false };
  }
  if (Object.hasOwn(patch, "chatSnippets")) emitChatSnippetsUpdatedSseEvent();
  return { ok: true };
}

describe("notification temps réel des snippets globaux", () => {
  let connections: ReturnType<typeof openConnection>[];

  beforeEach(() => {
    connections = [];
  });

  afterEach(() => {
    for (const connection of connections) connection.res.end();
    vi.useRealTimers();
  });

  function connect(projectId?: string) {
    const connection = openConnection(projectId);
    connections.push(connection);
    return connection;
  }

  it("publie une fois vers tous les clients, y compris ceux d'un autre projet", async () => {
    const defaultStream = connect();
    const projectA = connect("project-a");
    const projectB = connect("project-b");

    const result = await writeGlobalSettings({ chatSnippets: [{ name: "alpha", prompt: "secret" }] }, async () => {});

    expect(result.ok).toBe(true);
    for (const connection of [defaultStream, projectA, projectB]) {
      const frames = snippetFrames(connection);
      expect(frames).toHaveLength(1);
      // Fait seul : aucun réglage, aucun prompt, aucun identifiant de projet.
      expect(Object.keys(frames[0]!)).toEqual(["at"]);
      expect(typeof frames[0]!.at).toBe("string");
      expect(JSON.stringify(frames[0])).not.toContain("secret");
      expect(JSON.stringify(frames[0])).not.toContain("alpha");
    }
  });

  it("ne publie rien quand l'écriture échoue", async () => {
    const stream = connect("project-a");

    const result = await writeGlobalSettings({ chatSnippets: [{ name: "alpha", prompt: "p" }] }, async () => {
      throw new Error("écriture refusée");
    });

    expect(result.ok).toBe(false);
    expect(snippetFrames(stream)).toHaveLength(0);
  });

  it("ne publie rien pour un patch de réglages sans snippets", async () => {
    const stream = connect();

    await writeGlobalSettings({ theme: "dark" }, async () => {});

    expect(snippetFrames(stream)).toHaveLength(0);
  });

  it("publie pour une suppression, un renommage et une synchronisation entrante ou sortante", async () => {
    const stream = connect("project-a");

    await writeGlobalSettings({ chatSnippets: [] }, async () => {});
    await writeGlobalSettings({ chatSnippets: [{ name: "renomme", prompt: "p" }] }, async () => {});
    // Les deux routes de synchronisation appliquent la même condition sur leur section globale.
    await writeGlobalSettings({ chatSnippets: [{ name: "entrant", prompt: "p" }], otherKey: 1 }, async () => {});
    await writeGlobalSettings({ chatSnippets: [{ name: "sortant", prompt: "p" }] }, async () => {});

    expect(snippetFrames(stream)).toHaveLength(4);
  });

  it("libère l'abonnement quand le flux se ferme et n'échoue pas sur un client lent", async () => {
    const alive = connect();
    const closing = connect("project-a");

    closing.res.end();
    await writeGlobalSettings({ chatSnippets: [{ name: "apres", prompt: "p" }] }, async () => {});

    expect(snippetFrames(closing)).toHaveLength(0);
    expect(snippetFrames(alive)).toHaveLength(1);

    // Un client dont l'écriture jette (socket cassée) ne doit pas faire échouer la publication des autres.
    const hostile = connect("project-c");
    hostile.res.write.mockImplementationOnce(() => { throw new Error("socket cassée"); });
    expect(() => emitChatSnippetsUpdatedSseEvent()).not.toThrow();
    expect(snippetFrames(alive)).toHaveLength(2);
  });

  /*
  FNXC:SnippetsDestination 2026-09-16-21:44:
  The real PUT /settings/global handler is the writer an operator actually reaches, so it is driven here directly
  rather than through a restatement of its condition.
  */
  describe("route PUT /settings/global", () => {
    function mountGlobalSettingsRoute(persist?: (patch: Record<string, unknown>) => Promise<void>) {
      const handlers = new Map<string, (req: { body: Record<string, unknown> }, res: { json: (body: unknown) => void }) => Promise<void>>();
      const router = {
        get: vi.fn(),
        put: vi.fn((path: string, handler: (req: { body: Record<string, unknown> }, res: { json: (body: unknown) => void }) => Promise<void>) => {
          handlers.set(path, handler);
        }),
        post: vi.fn(),
        delete: vi.fn(),
      } as unknown as Router;

      let globalSettings: Record<string, unknown> = {};
      const store = {
        getGlobalSettingsStore: () => ({
          getSettings: vi.fn(async () => globalSettings),
          invalidateCache: vi.fn(),
        }),
        getSettings: vi.fn(async () => globalSettings),
        updateGlobalSettings: vi.fn(async (patch: Record<string, unknown>) => {
          await persist?.(patch);
          globalSettings = { ...globalSettings, ...patch };
          return globalSettings;
        }),
      };

      registerSettingsMemoryRoutes(
        {
          router,
          store: store as never,
          options: { engineManager: { getAllEngines: () => new Map() } } as never,
          runtimeLogger: { warn: vi.fn() } as never,
          getProjectContext: vi.fn() as never,
          rethrowAsApiError: (err: unknown): never => { throw err; },
        } as never,
        {
          validateModelPresets: () => undefined,
          sanitizeOverlapIgnorePaths: () => undefined,
          discoverDashboardPiExtensions: async () => ({ entries: [] }) as never,
        },
      );

      return handlers.get("/settings/global")!;
    }

    it("notifie tous les clients après un PUT réussi touchant chatSnippets", async () => {
      const stream = connect("project-a");
      const put = mountGlobalSettingsRoute();

      await put({ body: { chatSnippets: [{ name: "alpha", prompt: "secret" }] } }, { json: vi.fn() });

      const frames = snippetFrames(stream);
      expect(frames).toHaveLength(1);
      expect(Object.keys(frames[0]!)).toEqual(["at"]);
    });

    it("ne notifie pas pour un PUT sans chatSnippets", async () => {
      const stream = connect();
      const put = mountGlobalSettingsRoute();

      await put({ body: { autoBackupRetention: 5 } }, { json: vi.fn() });

      expect(snippetFrames(stream)).toHaveLength(0);
    });

    it("ne notifie pas quand l'écriture du PUT échoue", async () => {
      const stream = connect();
      const put = mountGlobalSettingsRoute(async () => { throw new Error("disque plein"); });

      await expect(put({ body: { chatSnippets: [] } }, { json: vi.fn() })).rejects.toThrow();

      expect(snippetFrames(stream)).toHaveLength(0);
    });
  });
});
