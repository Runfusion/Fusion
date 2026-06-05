// @vitest-environment node

import express from "express";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliSessionStore, Database } from "@fusion/core";
import { TelemetryHub } from "@fusion/engine";
import { request as performRequest } from "../../test-request.js";
import {
  createCliAgentHooksRouterForTest,
  HOOK_PAYLOAD_LIMIT_BYTES,
  type CliAgentHookHub,
} from "../cli-agent-hooks.js";

const PATH = "/api/cli-agent/hooks";
const TOKEN_HEADER = "x-fusion-cli-session-token";
const SESSION_HEADER = "x-fusion-cli-session-id";

/** Mount the hook route on a bare express app with a JSON error handler. */
function mount(resolver: (projectId: string | undefined, sessionId: string) => CliAgentHookHub | undefined) {
  const router = createCliAgentHooksRouterForTest(resolver);
  const app = express();
  app.use("/api", router);
  // express.json's PayloadTooLargeError surfaces here as 413.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? String(err) });
  });
  return app;
}

function post(
  app: express.Express,
  body: string,
  headers: Record<string, string> = {},
  path = PATH,
) {
  return performRequest(app, "POST", path, body, {
    "content-type": "application/json",
    host: "127.0.0.1",
    ...headers,
  });
}

describe("cli-agent-hooks route (stub hub)", () => {
  function stubHub(overrides: Partial<CliAgentHookHub> = {}): CliAgentHookHub & { ingested: Array<{ sessionId: string; event: unknown }> } {
    const ingested: Array<{ sessionId: string; event: unknown }> = [];
    return {
      ingested,
      validateToken: (sessionId, token) => token === "good-token" && sessionId === "sess-1",
      ingest: (sessionId, event) => {
        ingested.push({ sessionId, event });
        return event;
      },
      ...overrides,
    };
  }

  it("forwards a valid token + session to the hub", async () => {
    const hub = stubHub();
    const app = mount(() => hub);
    const res = await post(app, JSON.stringify({ session_id: "native-1", hello: "world" }) , {
      [TOKEN_HEADER]: "good-token",
      [SESSION_HEADER]: "sess-1",
    }, `${PATH}?event=Stop`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(hub.ingested).toHaveLength(1);
    expect(hub.ingested[0].sessionId).toBe("sess-1");
    expect(hub.ingested[0].event).toMatchObject({
      kind: "done",
      payload: { nativeSessionId: "native-1" },
    });
  });

  it("rejects a missing token with 401", async () => {
    const hub = stubHub();
    const app = mount(() => hub);
    const res = await post(app, "{}", { [SESSION_HEADER]: "sess-1" });
    expect(res.status).toBe(401);
    expect(hub.ingested).toHaveLength(0);
  });

  it("rejects a wrong token with 401", async () => {
    const hub = stubHub();
    const app = mount(() => hub);
    const res = await post(app, "{}", {
      [TOKEN_HEADER]: "wrong-token",
      [SESSION_HEADER]: "sess-1",
    });
    expect(res.status).toBe(401);
    expect(hub.ingested).toHaveLength(0);
  });

  it("rejects a valid-format token issued for the WRONG session", async () => {
    const hub = stubHub();
    const app = mount(() => hub);
    // good-token only validates for sess-1; present it for sess-2.
    const res = await post(app, "{}", {
      [TOKEN_HEADER]: "good-token",
      [SESSION_HEADER]: "sess-2",
    });
    expect(res.status).toBe(401);
    expect(hub.ingested).toHaveLength(0);
  });

  it("rejects a request carrying a browser Origin header (CSRF)", async () => {
    const hub = stubHub();
    const app = mount(() => hub);
    const res = await post(app, "{}", {
      [TOKEN_HEADER]: "good-token",
      [SESSION_HEADER]: "sess-1",
      origin: "http://evil.example.com",
    });
    expect(res.status).toBe(403);
    expect(hub.ingested).toHaveLength(0);
  });

  it("rejects a cross-site Host header", async () => {
    const hub = stubHub();
    const app = mount(() => hub);
    const res = await post(app, "{}", {
      [TOKEN_HEADER]: "good-token",
      [SESSION_HEADER]: "sess-1",
      host: "evil.example.com",
    });
    expect(res.status).toBe(403);
    expect(hub.ingested).toHaveLength(0);
  });

  it("accepts loopback Host with a port", async () => {
    const hub = stubHub();
    const app = mount(() => hub);
    const res = await post(app, "{}", {
      [TOKEN_HEADER]: "good-token",
      [SESSION_HEADER]: "sess-1",
      host: "127.0.0.1:4040",
    });
    expect(res.status).toBe(200);
  });

  it("rejects an oversized payload", async () => {
    const hub = stubHub();
    const app = mount(() => hub);
    const big = JSON.stringify({ blob: "x".repeat(HOOK_PAYLOAD_LIMIT_BYTES + 1024) });
    const res = await post(app, big, {
      [TOKEN_HEADER]: "good-token",
      [SESSION_HEADER]: "sess-1",
    });
    expect(res.status).toBe(413);
    expect(hub.ingested).toHaveLength(0);
  });

  it("treats an unknown session as a no-op (200), never a crash, when the hub accepts it", async () => {
    // A hub that validates any token but whose ingest is a no-op for unknown
    // sessions (the real hub's contract). The route returns 200 and never throws.
    const hub: CliAgentHookHub = {
      validateToken: () => true,
      ingest: () => undefined, // unknown session → no-op (returns undefined)
    };
    const app = mount(() => hub);
    const res = await post(app, "{}", {
      [TOKEN_HEADER]: "any",
      [SESSION_HEADER]: "ghost",
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 when no hub is resolvable for the session", async () => {
    const app = mount(() => undefined);
    const res = await post(app, "{}", {
      [TOKEN_HEADER]: "good-token",
      [SESSION_HEADER]: "sess-1",
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 even when hub.ingest throws (best-effort telemetry)", async () => {
    const hub: CliAgentHookHub = {
      validateToken: () => true,
      ingest: () => {
        throw new Error("boom");
      },
    };
    const app = mount(() => hub);
    const res = await post(app, "{}", {
      [TOKEN_HEADER]: "good-token",
      [SESSION_HEADER]: "sess-1",
    });
    expect(res.status).toBe(200);
  });
});

describe("cli-agent-hooks route (real TelemetryHub lifecycle)", () => {
  let tmpDir: string;
  let db: Database;
  let store: CliSessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fusion-hook-route-"));
    const fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function seed(agentState = "busy"): string {
    return store.createSession({
      purpose: "execute",
      projectId: "proj",
      adapterId: "claude-code",
      agentState: agentState as never,
    }).id;
  }

  it("end-to-end: valid token forwards and advances state; lifecycle revokes it", async () => {
    const sessionId = seed("busy");
    const hub = new TelemetryHub({ store });
    const token = hub.issueToken(sessionId);

    const app = mount((_proj, sid) => (hub.hasSession(sid) ? (hub as unknown as CliAgentHookHub) : undefined));

    // Valid POST → 200, state machine advances to done.
    const ok = await post(app, "{}", {
      [TOKEN_HEADER]: token,
      [SESSION_HEADER]: sessionId,
    }, `${PATH}?event=Stop`);
    expect(ok.status).toBe(200);
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("done");

    // Lifecycle: session end invalidates the token.
    hub.invalidate(sessionId);

    // Replayed POST with the old token → 401 (no hub / not validating).
    const replay = await post(app, "{}", {
      [TOKEN_HEADER]: token,
      [SESSION_HEADER]: sessionId,
    }, `${PATH}?event=Stop`);
    expect(replay.status).toBe(401);
  });

  it("after registry rebuild from non-live sessions, old tokens are rejected", async () => {
    const sessionId = seed("busy");
    const hub1 = new TelemetryHub({ store });
    const oldToken = hub1.issueToken(sessionId);

    // Simulate engine death mid-session: the session is no longer live.
    store.updateSession(sessionId, { agentState: "dead" as never });

    // New hub rebuilt from the store mints NO token for the non-live session.
    const hub2 = new TelemetryHub({ store });
    expect(hub2.hasSession(sessionId)).toBe(false);

    const app = mount((_proj, sid) => (hub2.hasSession(sid) ? (hub2 as unknown as CliAgentHookHub) : undefined));
    const res = await post(app, "{}", {
      [TOKEN_HEADER]: oldToken,
      [SESSION_HEADER]: sessionId,
    }, `${PATH}?event=Stop`);
    expect(res.status).toBe(401);
  });
});
