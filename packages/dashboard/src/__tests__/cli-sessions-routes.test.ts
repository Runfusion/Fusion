// @vitest-environment node

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";
import type { CliSession } from "@fusion/core";

type App = (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void;

function getJson(app: App, path: string) {
  return request(app, "GET", path);
}
function postJson(app: App, path: string, body: unknown) {
  return request(app, "POST", path, JSON.stringify(body), {
    "content-type": "application/json",
  });
}
import { createCliSessionsRouter } from "../routes/cli-sessions.js";
import {
  AttachTicketStore,
  CliInputAttributionLog,
  CliConfirmAdvanceRegistry,
  type CliSessionManagerLike,
} from "../cli-session-transport.js";

function makeSession(overrides: Partial<CliSession> = {}): CliSession {
  return {
    id: "cli-1",
    taskId: "FN-1",
    chatSessionId: null,
    purpose: "execute",
    projectId: "proj-a",
    adapterId: "claude-code",
    agentState: "busy",
    terminationReason: null,
    nativeSessionId: null,
    resumeAttempts: 0,
    autonomyPosture: null,
    worktreePath: "/tmp/wt",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

function makeStore(sessions: CliSession[]) {
  const map = new Map(sessions.map((s) => [s.id, s]));
  return {
    getSession: (id: string) => map.get(id),
    listSessions: (opts?: {
      projectId?: string;
      taskId?: string;
      chatSessionId?: string;
    }) =>
      [...map.values()].filter(
        (s) =>
          (opts?.projectId === undefined || s.projectId === opts.projectId) &&
          (opts?.taskId === undefined || s.taskId === opts.taskId) &&
          (opts?.chatSessionId === undefined || s.chatSessionId === opts.chatSessionId),
      ),
    _map: map,
  };
}

function buildApp(opts: {
  store: ReturnType<typeof makeStore>;
  manager: CliSessionManagerLike;
  ticketStore: AttachTicketStore;
  attributionLog: CliInputAttributionLog;
  confirmAdvance: CliConfirmAdvanceRegistry;
}): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/cli-sessions",
    createCliSessionsRouter({
      store: opts.store,
      manager: opts.manager,
      ticketStore: opts.ticketStore,
      attributionLog: opts.attributionLog,
      confirmAdvance: opts.confirmAdvance,
    }),
  );
  return app;
}

describe("cli-sessions routes", () => {
  let store: ReturnType<typeof makeStore>;
  let manager: CliSessionManagerLike;
  let injectSpy: ReturnType<typeof vi.fn>;
  let ticketStore: AttachTicketStore;
  let attributionLog: CliInputAttributionLog;
  let confirmAdvance: CliConfirmAdvanceRegistry;
  let app: express.Express;

  beforeEach(() => {
    store = makeStore([
      makeSession(),
      makeSession({ id: "cli-2", projectId: "proj-b", taskId: "FN-2" }),
      makeSession({ id: "cli-ro", purpose: "validator", projectId: "proj-a", taskId: "FN-3" }),
    ]);
    injectSpy = vi.fn().mockResolvedValue(undefined);
    manager = {
      isLive: () => true,
      attach: () => {
        throw new Error("not used in route tests");
      },
      inject: injectSpy,
      requestPause: vi.fn(),
      requestResume: vi.fn(),
    };
    ticketStore = new AttachTicketStore();
    attributionLog = new CliInputAttributionLog();
    confirmAdvance = new CliConfirmAdvanceRegistry();
    app = buildApp({ store, manager, ticketStore, attributionLog, confirmAdvance });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists sessions filtered by project / task / chat", async () => {
    const res = await getJson(app, "/api/cli-sessions?projectId=proj-a");
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: CliSession) => s.id).sort();
    expect(ids).toEqual(["cli-1", "cli-ro"]);

    const byTask = await getJson(app, "/api/cli-sessions?taskId=FN-2");
    expect(byTask.body.sessions.map((s: CliSession) => s.id)).toEqual(["cli-2"]);
  });

  it("returns a single session record", async () => {
    const res = await getJson(app, "/api/cli-sessions/cli-1");
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe("cli-1");
  });

  it("404s for unknown session", async () => {
    const res = await getJson(app, "/api/cli-sessions/nope");
    expect(res.status).toBe(404);
  });

  it("rejects cross-project access (project scope check)", async () => {
    const res = await getJson(app, "/api/cli-sessions/cli-1?projectId=proj-b");
    expect(res.status).toBe(403);
  });

  it("mints a single-use attach ticket with expiry", async () => {
    const res = await postJson(app, "/api/cli-sessions/cli-1/attach-ticket", {});
    expect(res.status).toBe(200);
    expect(typeof res.body.ticket).toBe("string");
    expect(res.body.ticket.length).toBeGreaterThan(20);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.readOnly).toBe(false);

    // The ticket consumes exactly once and is bound to its session.
    const entry = ticketStore.consume(res.body.ticket, "cli-1");
    expect(entry).not.toBeNull();
    expect(ticketStore.consume(res.body.ticket, "cli-1")).toBeNull(); // single-use
  });

  it("marks a read-only (validator) session's ticket as readOnly", async () => {
    const res = await postJson(app, "/api/cli-sessions/cli-ro/attach-ticket", {});
    expect(res.body.readOnly).toBe(true);
  });

  it("injects text and records attribution", async () => {
    const res = await postJson(app, "/api/cli-sessions/cli-1/inject", { text: "hello agent" });
    expect(res.status).toBe(200);
    expect(injectSpy).toHaveBeenCalledWith("cli-1", "hello agent");
    const log = attributionLog.list("cli-1");
    expect(log).toHaveLength(1);
    expect(log[0].source).toBe("inject");
  });

  it("rejects inject on a read-only session (server-side enforcement)", async () => {
    const res = await postJson(app, "/api/cli-sessions/cli-ro/inject", { text: "nope" });
    expect(res.status).toBe(403);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it("rejects empty inject body", async () => {
    const res = await postJson(app, "/api/cli-sessions/cli-1/inject", { text: "" });
    expect(res.status).toBe(400);
  });

  it("409s inject when session is not live", async () => {
    manager.isLive = () => false;
    const res = await postJson(app, "/api/cli-sessions/cli-1/inject", { text: "hi" });
    expect(res.status).toBe(409);
  });

  it("records a confirm-advance decision and emits an event", async () => {
    const seen: string[] = [];
    confirmAdvance.on((info) => seen.push(`${info.sessionId}:${info.decision}`));
    const res = await postJson(app, "/api/cli-sessions/cli-1/confirm-advance", {
      decision: "advance",
    });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("advance");
    expect(confirmAdvance.getLatest("cli-1")).toBe("advance");
    expect(seen).toContain("cli-1:advance");
  });

  it("rejects an invalid confirm-advance decision", async () => {
    const res = await postJson(app, "/api/cli-sessions/cli-1/confirm-advance", {
      decision: "maybe",
    });
    expect(res.status).toBe(400);
  });
});
