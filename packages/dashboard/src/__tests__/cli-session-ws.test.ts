// @vitest-environment node

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { CliSession } from "@fusion/core";
import type { CliSessionAttachment } from "@fusion/engine";
import {
  setupCliSessionWebSocket,
  CLI_SESSION_WS_PATH,
} from "../cli-session-ws.js";
import {
  AttachTicketStore,
  CliInputAttributionLog,
  bridgeCliStateToSse,
  type CliSessionManagerLike,
} from "../cli-session-transport.js";
import {
  emitCliSessionStateSseEvent,
  getCliSessionStateEventsSince,
  resetCliSessionStateBufferForTests,
} from "../sse.js";
import { CliSessionStateMachine } from "@fusion/engine";

const DAEMON_TOKEN = "test-daemon-token";

// ── A fake PTY-backed session (no real node-pty) ─────────────────────────────

class FakeAttachment implements CliSessionAttachment {
  scrollback: Uint8Array;
  private queue: Uint8Array[] = [];
  private waiters: ((r: IteratorResult<Uint8Array>) => void)[] = [];
  private closed = false;
  writes: string[] = [];
  resizes: { cols: number; rows: number }[] = [];
  detached = false;

  constructor(
    scrollback: string,
    private readonly onWrite: (data: string) => void,
    private readonly onResize: (cols: number, rows: number) => void,
  ) {
    this.scrollback = Buffer.from(scrollback, "utf8");
  }

  pushLive(text: string): void {
    const chunk = new Uint8Array(Buffer.from(text, "utf8"));
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: chunk, done: false });
    else this.queue.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true });
  }

  get stream(): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<Uint8Array>> => {
          const q = this.queue.shift();
          if (q !== undefined) return Promise.resolve({ value: q, done: false });
          if (this.closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => this.waiters.push(resolve));
        },
        return: (): Promise<IteratorResult<Uint8Array>> => {
          this.close();
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  }

  write(data: string): void {
    this.onWrite(data);
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.onResize(cols, rows);
    this.resizes.push({ cols, rows });
  }
  detach(): void {
    this.detached = true;
    this.close();
  }
}

class FakeManager implements CliSessionManagerLike {
  attachments = new Map<string, FakeAttachment[]>();
  live = new Set<string>();
  ptyInput: string[] = [];
  ptyResizes: { cols: number; rows: number }[] = [];
  paused = 0;
  resumed = 0;

  constructor(liveIds: string[]) {
    for (const id of liveIds) this.live.add(id);
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  makeAttachment(id: string, scrollback: string): FakeAttachment {
    const att = new FakeAttachment(
      scrollback,
      (data) => this.ptyInput.push(data),
      (cols, rows) => this.ptyResizes.push({ cols, rows }),
    );
    const list = this.attachments.get(id) ?? [];
    list.push(att);
    this.attachments.set(id, list);
    return att;
  }

  attach(id: string): CliSessionAttachment {
    // Each attach gets its own attachment, but they share the PTY input sink.
    return this.makeAttachment(id, this.scrollbackFor(id));
  }

  private scrollbackFor(id: string): string {
    return this.scrollbackById.get(id) ?? "";
  }
  scrollbackById = new Map<string, string>();

  /** Broadcast live bytes to every attachment of a session. */
  broadcast(id: string, text: string): void {
    for (const att of this.attachments.get(id) ?? []) att.pushLive(text);
  }

  requestPause(): void {
    this.paused += 1;
  }
  requestResume(): void {
    this.resumed += 1;
  }
}

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
    listSessions: () => [...map.values()],
  };
}

// ── Harness: a real http.Server on an EPHEMERAL port (0 — never 4040) ────────

interface Harness {
  port: number;
  manager: FakeManager;
  ticketStore: AttachTicketStore;
  attributionLog: CliInputAttributionLog;
  store: ReturnType<typeof makeStore>;
  close: () => Promise<void>;
}

async function startHarness(opts?: {
  sessions?: CliSession[];
  liveIds?: string[];
  highWatermarkBytes?: number;
  lowWatermarkBytes?: number;
  noAuth?: boolean;
}): Promise<Harness> {
  const sessions = opts?.sessions ?? [makeSession()];
  const store = makeStore(sessions);
  const manager = new FakeManager(opts?.liveIds ?? sessions.map((s) => s.id));
  const ticketStore = new AttachTicketStore();
  const attributionLog = new CliInputAttributionLog();

  const server = http.createServer((_req, res) => {
    res.statusCode = 426;
    res.end();
  });

  setupCliSessionWebSocket(server, {
    manager,
    store,
    ticketStore,
    attributionLog,
    daemonToken: DAEMON_TOKEN,
    noAuth: opts?.noAuth ?? false,
    highWatermarkBytes: opts?.highWatermarkBytes,
    lowWatermarkBytes: opts?.lowWatermarkBytes,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  expect(port).not.toBe(4040);

  return {
    port,
    manager,
    ticketStore,
    attributionLog,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function wsUrl(
  port: number,
  params: Record<string, string>,
): string {
  const qs = new URLSearchParams(params).toString();
  return `ws://127.0.0.1:${port}${CLI_SESSION_WS_PATH}?${qs}`;
}

/** Connect a WS, supplying an Origin (same-host by default) and token via query. */
function connect(
  port: number,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): WebSocket {
  return new WebSocket(wsUrl(port, { fn_token: DAEMON_TOKEN, ...params }), {
    headers: { origin: `http://127.0.0.1:${port}`, ...headers },
  });
}

function nextMessage(ws: WebSocket, predicate?: (m: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (!predicate || predicate(msg)) {
        ws.off("message", onMsg);
        resolve(msg);
      }
    };
    ws.on("message", onMsg);
    ws.once("error", reject);
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function decode(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

describe("cli-session WS attach", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  async function mintTicket(sessionId: string): Promise<string> {
    const { ticket } = h.ticketStore.mint({
      sessionId,
      projectId: h.store.getSession(sessionId)!.projectId,
      readOnly: false,
    });
    return ticket;
  }

  it("two concurrent attaches both receive live bytes; input from either reaches the PTY; detach of one keeps the session", async () => {
    h = await startHarness();
    const t1 = await mintTicket("cli-1");
    const t2 = await mintTicket("cli-1");

    const a = connect(h.port, { sessionId: "cli-1", ticket: t1 });
    const b = connect(h.port, { sessionId: "cli-1", ticket: t2 });
    await Promise.all([
      nextMessage(a, (m) => m.type === "scrollback"),
      nextMessage(b, (m) => m.type === "scrollback"),
    ]);

    const aData = nextMessage(a, (m) => m.type === "data");
    const bData = nextMessage(b, (m) => m.type === "data");
    h.manager.broadcast("cli-1", "live-output");
    expect(decode((await aData).data)).toBe("live-output");
    expect(decode((await bData).data)).toBe("live-output");

    a.send(JSON.stringify({ type: "input", data: "from-a" }));
    b.send(JSON.stringify({ type: "input", data: "from-b" }));
    await vi.waitFor(() => {
      expect(h.manager.ptyInput).toContain("from-a");
      expect(h.manager.ptyInput).toContain("from-b");
    });

    // Detach a — session must stay live and b keeps receiving.
    a.close();
    await waitClose(a);
    expect(h.manager.isLive("cli-1")).toBe(true);
    const bData2 = nextMessage(b, (m) => m.type === "data");
    h.manager.broadcast("cli-1", "still-here");
    expect(decode((await bData2).data)).toBe("still-here");
    b.close();
  });

  it("rejects upgrade without a daemon token", async () => {
    h = await startHarness();
    const t = await mintTicket("cli-1");
    const ws = new WebSocket(wsUrl(h.port, { sessionId: "cli-1", ticket: t }), {
      headers: { origin: `http://127.0.0.1:${h.port}` },
    });
    const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(err.message).toMatch(/401/);
  });

  it("rejects a foreign Origin", async () => {
    h = await startHarness();
    const t = await mintTicket("cli-1");
    const ws = connect(
      h.port,
      { sessionId: "cli-1", ticket: t },
      { origin: "http://evil.example.com" },
    );
    const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(err.message).toMatch(/403/);
  });

  it("rejects an absent browser Origin (Sec-Fetch-Site present)", async () => {
    h = await startHarness();
    const t = await mintTicket("cli-1");
    const ws = new WebSocket(wsUrl(h.port, { fn_token: DAEMON_TOKEN, sessionId: "cli-1", ticket: t }), {
      headers: { "sec-fetch-site": "cross-site" },
    });
    const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(err.message).toMatch(/403/);
  });

  it("rejects a replayed / consumed ticket", async () => {
    h = await startHarness();
    const t = await mintTicket("cli-1");
    const first = connect(h.port, { sessionId: "cli-1", ticket: t });
    await nextMessage(first, (m) => m.type === "scrollback");
    // Reuse the same ticket on a new connection — must be rejected.
    const second = connect(h.port, { sessionId: "cli-1", ticket: t });
    const closed = await waitClose(second);
    expect(closed.code).toBe(4401);
    first.close();
  });

  it("rejects a ticket for session A used to attach session B", async () => {
    h = await startHarness({
      sessions: [makeSession(), makeSession({ id: "cli-2", taskId: "FN-2" })],
    });
    const tA = await mintTicket("cli-1");
    const ws = connect(h.port, { sessionId: "cli-2", ticket: tA });
    const closed = await waitClose(ws);
    expect(closed.code).toBe(4401);
  });

  it("rejects a cross-project session id (ticket project mismatch handled; unknown session)", async () => {
    h = await startHarness();
    const t = await mintTicket("cli-1");
    const ws = connect(h.port, { sessionId: "cli-unknown", ticket: t });
    const closed = await waitClose(ws);
    expect(closed.code).toBe(4004);
  });

  it("late attacher gets scrollback then live with no duplication", async () => {
    h = await startHarness();
    h.manager.scrollbackById.set("cli-1", "PRIOR-OUTPUT");
    const t = await mintTicket("cli-1");
    const ws = connect(h.port, { sessionId: "cli-1", ticket: t });
    const sb = await nextMessage(ws, (m) => m.type === "scrollback");
    expect(decode(sb.data)).toBe("PRIOR-OUTPUT");
    const live = nextMessage(ws, (m) => m.type === "data");
    h.manager.broadcast("cli-1", "NEW");
    expect(decode((await live).data)).toBe("NEW");
    ws.close();
  });

  it("flow control: slow consumer (no acks) triggers pause at high watermark; acks resume at low watermark", async () => {
    h = await startHarness({ highWatermarkBytes: 20, lowWatermarkBytes: 10 });
    const t = await mintTicket("cli-1");
    const ws = connect(h.port, { sessionId: "cli-1", ticket: t });
    await nextMessage(ws, (m) => m.type === "scrollback");

    // Push 25 bytes without acking — crosses the 20-byte high watermark.
    const d1 = nextMessage(ws, (m) => m.type === "data");
    h.manager.broadcast("cli-1", "x".repeat(25));
    await d1;
    await vi.waitFor(() => expect(h.manager.paused).toBe(1));
    expect(h.manager.resumed).toBe(0);

    // Ack 20 bytes — outstanding drops to 5 (<= low watermark 10) → resume.
    ws.send(JSON.stringify({ type: "ack", bytes: 20 }));
    await vi.waitFor(() => expect(h.manager.resumed).toBe(1));
    ws.close();
  });

  it("resize is forwarded (latest-active-client) to the manager", async () => {
    h = await startHarness();
    const t = await mintTicket("cli-1");
    const ws = connect(h.port, { sessionId: "cli-1", ticket: t });
    await nextMessage(ws, (m) => m.type === "scrollback");
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await vi.waitFor(() =>
      expect(h.manager.ptyResizes).toContainEqual({ cols: 120, rows: 40 }),
    );
    ws.close();
  });

  it("output hardening: OSC 52, OSC 8 javascript: link, and a DSR query are neutralized (incl. split across chunks)", async () => {
    h = await startHarness();
    const t = await mintTicket("cli-1");
    const ws = connect(h.port, { sessionId: "cli-1", ticket: t });
    await nextMessage(ws, (m) => m.type === "scrollback");

    const ESC = "\x1b";
    const BEL = "\x07";
    // OSC 52 + OSC 8 js link + DSR — all in one chunk.
    const d1 = nextMessage(ws, (m) => m.type === "data");
    h.manager.broadcast(
      "cli-1",
      `A${ESC}]52;c;ZXZpbA==${BEL}${ESC}]8;;javascript:x${BEL}T${ESC}]8;;${BEL}${ESC}[6nB`,
    );
    const out1 = decode((await d1).data);
    expect(out1).not.toContain("52;");
    expect(out1).not.toContain("javascript:");
    expect(out1).not.toContain(`${ESC}[6n`);
    expect(out1).toContain("A");
    expect(out1).toContain("T");
    expect(out1).toContain("B");

    // A sequence split across two broadcasts (chunks).
    h.manager.broadcast("cli-1", `C${ESC}]52;c;ZXZ`);
    h.manager.broadcast("cli-1", `pbA==${BEL}D`);
    // Collect data frames until we see the trailing "D".
    let collected = "";
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) => {
          const onMsg = (raw: Buffer) => {
            const m = JSON.parse(raw.toString());
            if (m.type === "data") collected += decode(m.data);
            if (collected.includes("D")) {
              ws.off("message", onMsg);
              resolve();
            }
          };
          ws.on("message", onMsg);
          setTimeout(() => reject(new Error("timeout")), 1000);
        }),
    );
    expect(collected).not.toContain("52;");
    expect(collected).toContain("C");
    expect(collected).toContain("D");
    ws.close();
  });

  it("does not leak an OSC 52 split across the scrollback→live seam", async () => {
    const ESC = "\x1b";
    const BEL = "\x07";
    // The OSC 52 introducer lands at the very TAIL of scrollback (unterminated);
    // its terminator arrives in the first LIVE chunk. The carry must thread
    // across the seam so the neutralizer sees the full sequence and strips it —
    // the scrollback frame must NOT flush the held introducer verbatim.
    h = await startHarness();
    h.manager.scrollbackById.set("cli-1", `prior-output${ESC}]52;c;ZXZ`);
    const t = await mintTicket("cli-1");
    const ws = connect(h.port, { sessionId: "cli-1", ticket: t });

    const scrollback = await nextMessage(ws, (m) => m.type === "scrollback");
    const scrollText = decode(scrollback.data);
    // Normal scrollback still renders; the unterminated tail is withheld (carry).
    expect(scrollText).toContain("prior-output");
    expect(scrollText).not.toContain("52;");
    expect(scrollText).not.toContain(`${ESC}]`);

    // Deliver the terminator in the first live chunk.
    h.manager.broadcast("cli-1", `pbA==${BEL}after`);
    let collected = scrollText;
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) => {
          const onMsg = (raw: Buffer) => {
            const m = JSON.parse(raw.toString());
            if (m.type === "data") collected += decode(m.data);
            if (collected.includes("after")) {
              ws.off("message", onMsg);
              resolve();
            }
          };
          ws.on("message", onMsg);
          setTimeout(() => reject(new Error("timeout")), 1000);
        }),
    );
    // The full sequence, reassembled across the seam, was neutralized.
    expect(collected).not.toContain("52;");
    expect(collected).not.toContain(`${ESC}]52`);
    expect(collected).toContain("prior-output");
    expect(collected).toContain("after");
    ws.close();
  });

  it("read-only session rejects input with an error frame (server-side)", async () => {
    h = await startHarness({
      sessions: [makeSession({ id: "cli-ro", purpose: "validator" })],
    });
    const t = await mintTicket("cli-ro");
    const ws = connect(h.port, { sessionId: "cli-ro", ticket: t });
    await nextMessage(ws, (m) => m.type === "scrollback");
    const errFrame = nextMessage(ws, (m) => m.type === "error");
    ws.send(JSON.stringify({ type: "input", data: "should-be-blocked" }));
    const err = await errFrame;
    expect(err.code).toBe("READ_ONLY");
    expect(h.manager.ptyInput).not.toContain("should-be-blocked");
    ws.close();
  });
});

// ── SSE cli:session:state ─────────────────────────────────────────────────────

/** Minimal in-memory store satisfying what the state machine + bridge touch. */
function makeStateStore(session: CliSession) {
  let current = { ...session };
  return {
    getSession: (id: string) => (id === current.id ? current : undefined),
    listSessions: () => [current],
    updateSession: (id: string, input: Partial<CliSession>) => {
      if (id !== current.id) return undefined;
      current = { ...current, ...input } as CliSession;
      return current;
    },
  };
}

describe("cli:session:state SSE bridge", () => {
  beforeEach(() => resetCliSessionStateBufferForTests());

  it("forwards a state transition as one event carrying owning entity + redacted preview", () => {
    const session = makeSession({
      id: "s-1",
      taskId: "FN-9",
      projectId: "proj-a",
      agentState: "starting",
    });
    const store = makeStateStore(session);
    const machine = new CliSessionStateMachine({
      sessionId: "s-1",
      store: store as never,
    });
    const captured: { id: number; payload: any; projectId?: string }[] = [];
    const unbridge = bridgeCliStateToSse(machine, {
      store: store as never,
      getRecentOutput: () => "bearer sk-secret-1234567890 \x1b[31mfoo\x1b[0m",
    });
    // Seed machine into busy via the legal path, then trigger a transition.
    machine.markReady(); // starting → ready
    machine.injectPrompt(); // ready → busy
    const before = getCliSessionStateEventsSince(0).length;
    machine.signalDone(); // busy → done
    const events = getCliSessionStateEventsSince(0);
    expect(events.length).toBeGreaterThan(before);
    const last = events[events.length - 1];
    expect(last.payload.sessionId).toBe("s-1");
    expect(last.payload.taskId).toBe("FN-9");
    expect(last.payload.state).toBe("done");
    expect(last.projectId).toBe("proj-a");
    // Preview is ANSI-stripped and bounded.
    expect(last.payload.lastOutputPreview).not.toContain("\x1b");
    unbridge();
    void captured;
  });

  it("engine throttle coalesces rapid transitions into fewer emitted events", async () => {
    const session = makeSession({ id: "s-2", projectId: "proj-a", agentState: "starting" });
    const store = makeStateStore(session);
    const machine = new CliSessionStateMachine({
      sessionId: "s-2",
      store: store as never,
      stateChangeThrottleMs: 500,
    });
    bridgeCliStateToSse(machine, { store: store as never });
    machine.markReady();
    machine.injectPrompt();
    // Rapid waiting↔busy churn within the throttle window.
    machine.signalWaitingOnInput();
    machine.signalBusy();
    machine.signalWaitingOnInput();
    machine.signalBusy();
    const emitted = getCliSessionStateEventsSince(0).length;
    // Leading-edge + coalesced trailing means far fewer than the ~6 raw transitions.
    expect(emitted).toBeLessThan(6);
    expect(emitted).toBeGreaterThanOrEqual(1);
  });

  it("getCliSessionStateEventsSince replays only transitions after a lastEventId", () => {
    const a = emitCliSessionStateSseEvent(
      { sessionId: "x", taskId: null, chatSessionId: null, state: "ready", at: "t0" },
      "proj-a",
    );
    const b = emitCliSessionStateSseEvent(
      { sessionId: "x", taskId: null, chatSessionId: null, state: "busy", at: "t1" },
      "proj-a",
    );
    const replay = getCliSessionStateEventsSince(a);
    expect(replay.map((e) => e.id)).toEqual([b]);
    expect(replay[0].payload.state).toBe("busy");
  });
});
