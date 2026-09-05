// @vitest-environment node
/*
FNXC:CliChatRecall 2026-08-19-11:08:
Loopback per-turn memory-recall route (RUFU-128) — same per-session token
auth posture as /api/cli-agent/hooks (Origin/Host CSRF defense, loopback
host, 256KB cap, daemon-token exemption), plus the silent-skip contract: a
valid request whose recall produced no cue (or a service-side throw) returns
202 with an EMPTY cue, never a 5xx. The cue travels only to the CLI agent's
native hook/extension channel.
*/
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthMiddleware } from "../../auth-middleware.js";
import { request as performRequest } from "../../test-request.js";
import {
  createCliAgentMemoryRecallRouterForTest,
  type CliAgentMemoryRecallHandle,
} from "../cli-agent-memory-recall.js";
import {
  __resetPerTurnRecallDedupForTests,
  registerMemoryBackend,
} from "@fusion/core";
import { recallForChatTurn } from "@fusion/engine";

const SESSION_ID = "cli-abc12345";
const VALID_TOKEN = "tok-valid";

interface HandleOptions {
  sessionId?: string;
  token?: string;
  cue?: string;
  throwOnRecall?: boolean;
}

function makeHandle(opts: HandleOptions = {}): CliAgentMemoryRecallHandle & {
  recallForChatTurn: ReturnType<typeof vi.fn>;
} {
  const sessionId = opts.sessionId ?? SESSION_ID;
  return {
    validateToken: (sid: string, token: string | null | undefined) =>
      sid === sessionId && token === (opts.token ?? VALID_TOKEN),
    hasSession: (sid: string) => sid === sessionId,
    recallForChatTurn: vi.fn(async () => {
      if (opts.throwOnRecall) throw new Error("recall backend exploded");
      return opts.cue ?? "";
    }),
  };
}

function mount(
  resolver: (projectId: string | undefined, sessionId: string) => CliAgentMemoryRecallHandle | undefined,
  warn = vi.fn(),
): express.Express {
  const router = createCliAgentMemoryRecallRouterForTest(resolver, { warn });
  const app = express();
  app.use("/api", router);
  app.use((err: { statusCode?: number; status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? String(err) });
  });
  return app;
}

function authHeaders(overrides: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    host: "127.0.0.1",
    "x-fusion-cli-session-id": SESSION_ID,
    "x-fusion-cli-session-token": VALID_TOKEN,
    ...overrides,
  };
}

describe("POST /api/cli-agent/memory-recall (RUFU-128)", () => {
  it("valid token + session → 202 with the cue as plain text", async () => {
    const handle = makeHandle({ cue: "Recall: 3 relevant memories\n- the flake is a race in outbox backoff" });
    const app = mount(() => handle);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "fix the flake" }),
      authHeaders(),
    );
    expect(res.status).toBe(202);
    expect(res.body).toBe("Recall: 3 relevant memories\n- the flake is a race in outbox backoff");
    expect(String(res.headers["content-type"])).toContain("text/plain");
    expect(handle.recallForChatTurn).toHaveBeenCalledWith({
      topic: "fix the flake",
      sessionId: SESSION_ID,
    });
  });

  it("valid request with no cue → 202 with an empty cue (silent skip)", async () => {
    const handle = makeHandle({ cue: "" });
    const app = mount(() => handle);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "hello" }),
      authHeaders(),
    );
    expect(res.status).toBe(202);
    expect(res.body).toBe("");
  });

  it("wrong token → 401", async () => {
    const handle = makeHandle();
    const app = mount(() => handle);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "hi" }),
      authHeaders({ "x-fusion-cli-session-token": "tok-wrong" }),
    );
    expect(res.status).toBe(401);
    expect(handle.recallForChatTurn).not.toHaveBeenCalled();
  });

  it("valid token for ANOTHER session never validates (session-scoped tokens)", async () => {
    const other = makeHandle({ sessionId: "cli-other" });
    const app = mount(() => other);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "hi" }),
      authHeaders(),
    );
    expect(res.status).toBe(401);
    expect(other.recallForChatTurn).not.toHaveBeenCalled();
  });

  it("unknown session (token can't validate, record gone) → 401", async () => {
    const handle = makeHandle();
    const app = mount(() => handle);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "hi" }),
      authHeaders({ "x-fusion-cli-session-id": "cli-unknown", "x-fusion-cli-session-token": "tok-x" }),
    );
    expect(res.status).toBe(401);
    expect(handle.recallForChatTurn).not.toHaveBeenCalled();
  });

  it("missing session id header → 401", async () => {
    const app = mount(() => makeHandle());
    const headers = authHeaders();
    delete headers["x-fusion-cli-session-id"];
    const res = await performRequest(app, "POST", "/api/cli-agent/memory-recall", "{}", headers);
    expect(res.status).toBe(401);
  });

  it("missing token header → 401", async () => {
    const app = mount(() => makeHandle());
    const headers = authHeaders();
    delete headers["x-fusion-cli-session-token"];
    const res = await performRequest(app, "POST", "/api/cli-agent/memory-recall", "{}", headers);
    expect(res.status).toBe(401);
  });

  it("browser Origin header → 403 (CSRF defense)", async () => {
    const app = mount(() => makeHandle());
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "hi" }),
      authHeaders({ origin: "http://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  it("non-loopback Host → 403 (DNS-rebinding defense)", async () => {
    const app = mount(() => makeHandle());
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "hi" }),
      authHeaders({ host: "evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  it("loopback hosts with ports are accepted", async () => {
    const handle = makeHandle({ cue: "ok" });
    const app = mount(() => handle);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "hi" }),
      authHeaders({ host: "localhost:4040" }),
    );
    expect(res.status).toBe(202);
  });

  it("missing prompt in body → 400", async () => {
    const handle = makeHandle();
    const app = mount(() => handle);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ notaprompt: "hi" }),
      authHeaders(),
    );
    expect(res.status).toBe(400);
    expect(handle.recallForChatTurn).not.toHaveBeenCalled();
  });

  it("malformed JSON body → 400", async () => {
    const handle = makeHandle();
    const app = mount(() => handle);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      "{ not json",
      authHeaders(),
    );
    expect(res.status).toBe(400);
    expect(handle.recallForChatTurn).not.toHaveBeenCalled();
  });

  it("oversized body (Content-Length over cap) → 413", async () => {
    const app = mount(() => makeHandle());
    const big = "x".repeat(256 * 1024 + 1);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: big }),
      authHeaders(),
    );
    expect(res.status).toBe(413);
  });

  it("recall service throws → 202 with empty cue (NEVER 5xx)", async () => {
    const warn = vi.fn();
    const handle = makeHandle({ throwOnRecall: true });
    const app = mount(() => handle, warn);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "hi" }),
      authHeaders(),
    );
    expect(res.status).toBe(202);
    expect(res.body).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("no recall wiring (missing resolver handle) → 401, never a silent no-op", async () => {
    const app = mount(() => undefined);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: "hi" }),
      authHeaders(),
    );
    expect(res.status).toBe(401);
  });
});

/*
FNXC:CliChatRecall 2026-08-19-19:30:
RUFU-128 Step 7 — settings gate, route level, with a POPULATED backend:
the route serves the real engine recall service (same wiring as the runtime
bundle) against a fake memory backend. The gate is the FRESH settings read
per call: with recall on the cue is served (202 + text); with per-turn
recall off (then project memory off) the SAME populated backend returns a
202 EMPTY cue. Distinct topics per call keep the core's session-scoped
dedup out of the assertion.
*/
describe("POST /api/cli-agent/memory-recall settings gate (RUFU-128 Step 7)", () => {
  const GATE_ROOT = mkdtempSync(join(tmpdir(), "rufu128-route-gate-project-"));
  afterAll(() => rmSync(GATE_ROOT, { recursive: true, force: true }));
  const GATE_TOPIC = "čo sme diskutovali o LCM B.1 B.2";

  // Mutable per-call settings — the route must read them fresh on every
  // request (no caching) so a live toggle takes effect on the next prompt.
  let gateSettings: import("@fusion/core").Settings | undefined;

  beforeAll(() => {
    const capabilities = {
      readable: true,
      writable: false,
      supportsAtomicWrite: false,
      hasConflictResolution: false,
      persistent: false,
    };
    registerMemoryBackend({
      type: "rufu128-route-gate-fake",
      name: "RUFU-128 route gate fake backend",
      capabilities,
      read: async () => ({ content: "", exists: false, backend: "rufu128-route-gate-fake" }),
      write: async () => {
        throw new Error("read-only fake");
      },
      search: async () => [
        { path: "docs/notes.md", lineStart: 10, lineEnd: 12, snippet: "the LCM marker was decided here", score: 1.5, backend: "rufu128-route-gate-fake" },
      ],
    });
  });

  beforeEach(() => {
    gateSettings = {
      memoryEnabled: true,
      memoryBackendType: "rufu128-route-gate-fake",
      memoryPerTurnRecallEnabled: true,
      memoryPerTurnRecallTopK: 3,
    } as import("@fusion/core").Settings;
    __resetPerTurnRecallDedupForTests();
  });

  /** The route handle wired exactly like the runtime bundle: service + fresh settings per call. */
  const gatedHandle: CliAgentMemoryRecallHandle = {
    validateToken: () => true,
    hasSession: () => true,
    recallForChatTurn: ({ topic, sessionId }) =>
      recallForChatTurn({
        rootDir: GATE_ROOT,
        topic,
        sessionId,
        settings: gateSettings,
      }),
  };

  it("recall ON + populated backend → 202 with the cue", async () => {
    const app = mount(() => gatedHandle);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: `${GATE_TOPIC} gate-one` }),
      authHeaders(),
    );
    expect(res.status).toBe(202);
    expect(typeof res.body).toBe("string");
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("per-turn recall OFF + populated backend → 202 EMPTY cue (fresh settings read)", async () => {
    const app = mount(() => gatedHandle);
    const first = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: `${GATE_TOPIC} gate-two` }),
      authHeaders(),
    );
    expect(first.status).toBe(202);
    expect(first.body.length).toBeGreaterThan(0);

    // Live toggle: flip the settings, same populated backend, next prompt.
    gateSettings = { ...(gateSettings as object), memoryPerTurnRecallEnabled: false } as import("@fusion/core").Settings;
    const second = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: `${GATE_TOPIC} gate-three` }),
      authHeaders(),
    );
    expect(second.status).toBe(202);
    expect(second.body).toBe("");
  });

  it("project memory OFF + populated backend → 202 EMPTY cue", async () => {
    gateSettings = { ...(gateSettings as object), memoryEnabled: false } as import("@fusion/core").Settings;
    const app = mount(() => gatedHandle);
    const res = await performRequest(
      app,
      "POST",
      "/api/cli-agent/memory-recall",
      JSON.stringify({ prompt: `${GATE_TOPIC} gate-four` }),
      authHeaders(),
    );
    expect(res.status).toBe(202);
    expect(res.body).toBe("");
  });
});

/*
FNXC:CliChatRecall 2026-08-20-15:58:
Step 2 test case: the recall route must sit in the daemon-token exemption
list (the hook curl carries ONLY the per-session token, never the daemon
bearer token). Without the exemption the daemon-token middleware would 401
the request before the route's own per-session auth runs, silently killing
CLI chat recall in daemon mode. The control case proves the exemption is
not a general bypass.
*/
describe("POST /api/cli-agent/memory-recall daemon-token exemption (RUFU-128 Step 2)", () => {
  it("exempts the recall path from the daemon-token gate (no daemon token needed)", () => {
    const middleware = createAuthMiddleware("fn_daemon_token");
    const req = { path: "/api/cli-agent/memory-recall", headers: {} } as unknown as express.Request;
    const res = { status: vi.fn(), json: vi.fn() } as unknown as express.Response;
    const next = vi.fn();

    middleware(req, res, next as express.NextFunction);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("still gates non-exempt API paths without a daemon token (control)", () => {
    const middleware = createAuthMiddleware("fn_daemon_token");
    const req = { path: "/api/cli-agent/memory-recall-x", headers: {} } as unknown as express.Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as express.Response;
    const next = vi.fn();

    middleware(req, res, next as express.NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
