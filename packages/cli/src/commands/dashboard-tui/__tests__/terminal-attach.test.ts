import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachTerminalSession,
  buildWsUrl,
  fetchAttachTicket,
  DETACH_CHORD_BYTE,
  ALT_SCREEN_ENTER,
  ALT_SCREEN_LEAVE,
  WS_OPEN,
  type TerminalWebSocket,
  type AttachStdin,
  type AttachStdout,
} from "../terminal-attach.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

/** In-memory WS-like transport. Never opens a real socket / never port 4040. */
class FakeWs implements TerminalWebSocket {
  readyState = WS_OPEN;
  sent: string[] = [];
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  closed = false;

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit("close");
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.handlers.get(event) ?? []) l(...args);
  }
  /** Simulate the server delivering a (JSON) message frame. */
  deliver(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame), "utf8"));
  }
  /** Parsed client→server frames. */
  parsedSent(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

class FakeStdin implements AttachStdin {
  isTTY = true;
  isRaw = false;
  private listeners: ((chunk: Buffer | string) => void)[] = [];
  rawCalls: boolean[] = [];
  resumed = false;
  on(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners.push(listener);
  }
  off(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  setRawMode(mode: boolean): void {
    this.rawCalls.push(mode);
    this.isRaw = mode;
  }
  resume(): void {
    this.resumed = true;
  }
  /** Simulate a user keystroke chunk. */
  feed(chunk: Buffer | string): void {
    for (const l of [...this.listeners]) l(chunk);
  }
  listenerCount(): number {
    return this.listeners.length;
  }
}

class FakeStdout implements AttachStdout {
  columns = 80;
  rows = 24;
  writes: string[] = [];
  private resizeListeners: (() => void)[] = [];
  write(chunk: string): void {
    this.writes.push(chunk);
  }
  on(_event: "resize", listener: () => void): void {
    this.resizeListeners.push(listener);
  }
  off(_event: "resize", listener: () => void): void {
    this.resizeListeners = this.resizeListeners.filter((l) => l !== listener);
  }
  fireResize(cols: number, rows: number): void {
    this.columns = cols;
    this.rows = rows;
    for (const l of [...this.resizeListeners]) l();
  }
  resizeListenerCount(): number {
    return this.resizeListeners.length;
  }
  all(): string {
    return this.writes.join("");
  }
}

/** A fetchImpl that always returns a ticket. */
function okTicketFetch(ticket = "TICKET-1"): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ticket, expiresAt: new Date().toISOString(), readOnly: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

interface Harness {
  ws: FakeWs;
  stdin: FakeStdin;
  stdout: FakeStdout;
  onDetach: ReturnType<typeof vi.fn>;
}

/**
 * Start an attach, drive the WS `open`, and return the harness + handle.
 * `await tick()` lets the async ticket fetch resolve.
 */
async function startAttach(
  overrides: Partial<Parameters<typeof attachTerminalSession>[0]> = {},
): Promise<Harness & { handle: ReturnType<typeof attachTerminalSession> }> {
  const ws = new FakeWs();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const onDetach = vi.fn();

  const handle = attachTerminalSession({
    baseUrl: "http://127.0.0.1:9999",
    token: "daemon-tok",
    sessionId: "sess-1",
    stdin,
    stdout,
    onDetach,
    fetchImpl: okTicketFetch(),
    wsFactory: () => ws,
    ackThresholdBytes: 64,
    ...overrides,
  });

  // Let the ticket fetch resolve, then open the socket.
  await tick();
  ws.emit("open");

  return { ws, stdin, stdout, onDetach, handle };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

// ── URL / ticket helpers ──────────────────────────────────────────────────────

describe("buildWsUrl", () => {
  it("derives ws:// from http:// and sets sessionId + ticket", () => {
    const url = buildWsUrl({ baseUrl: "http://127.0.0.1:4040", sessionId: "s1", ticket: "t1" });
    expect(url).toBe("ws://127.0.0.1:4040/api/cli-sessions/ws?sessionId=s1&ticket=t1");
  });
  it("derives wss:// from https://", () => {
    const url = buildWsUrl({ baseUrl: "https://host", sessionId: "s", ticket: "t" });
    expect(url.startsWith("wss://host/api/cli-sessions/ws")).toBe(true);
  });
});

describe("fetchAttachTicket", () => {
  it("POSTs to the attach-ticket route with bearer auth and returns the ticket", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ticket: "TK", readOnly: false }), { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await fetchAttachTicket({
      baseUrl: "http://h",
      token: "tok",
      sessionId: "s 1",
      fetchImpl,
    });
    expect(res.ticket).toBe("TK");
    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(url).toBe("http://h/api/cli-sessions/s%201/attach-ticket");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    await expect(
      fetchAttachTicket({ baseUrl: "http://h", sessionId: "s", fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

// ── Passthrough loop ──────────────────────────────────────────────────────────

describe("attachTerminalSession passthrough", () => {
  it("enters alt-screen + raw mode on open and sends an initial resize", async () => {
    const { stdin, stdout, ws } = await startAttach();
    expect(stdout.all()).toContain(ALT_SCREEN_ENTER);
    expect(stdin.rawCalls).toContain(true);
    expect(stdin.resumed).toBe(true);
    const resize = ws.parsedSent().find((f) => f.type === "resize");
    expect(resize).toMatchObject({ type: "resize", cols: 80, rows: 24 });
  });

  it("frames stdin bytes into input messages (base64)", async () => {
    const { stdin, ws } = await startAttach();
    stdin.feed(Buffer.from("ls -la\r", "utf8"));
    const input = ws.parsedSent().find((f) => f.type === "input");
    expect(input).toBeDefined();
    expect(Buffer.from(input!.data as string, "base64").toString("utf8")).toBe("ls -la\r");
  });

  it("writes data frames to stdout verbatim", async () => {
    const { stdout, ws } = await startAttach();
    const payload = "hello \x1b[31mworld\x1b[0m\n";
    ws.deliver({ type: "data", data: b64(payload) });
    expect(stdout.all()).toContain(payload);
  });

  it("passes CJK / double-width bytes through verbatim", async () => {
    const { stdout, ws } = await startAttach();
    const payload = "日本語 ❤ 한국어";
    ws.deliver({ type: "data", data: b64(payload) });
    expect(stdout.all()).toContain(payload);
  });

  it("writes scrollback frames to stdout", async () => {
    const { stdout, ws } = await startAttach();
    ws.deliver({ type: "scrollback", data: b64("prior output\n") });
    expect(stdout.all()).toContain("prior output\n");
  });

  it("propagates host resize as a resize frame", async () => {
    const { stdout, ws } = await startAttach();
    stdout.fireResize(120, 40);
    const resizes = ws.parsedSent().filter((f) => f.type === "resize");
    expect(resizes.at(-1)).toMatchObject({ cols: 120, rows: 40 });
  });
});

// ── Detach chord ──────────────────────────────────────────────────────────────

describe("detach chord (Ctrl-])", () => {
  it("restores state: leaves alt-screen, restores raw mode, closes WS, calls onDetach", async () => {
    const { stdin, stdout, ws, onDetach, handle } = await startAttach();
    stdin.feed(Buffer.from([DETACH_CHORD_BYTE]));
    await handle.done;

    expect(stdout.all()).toContain(ALT_SCREEN_LEAVE);
    expect(stdin.rawCalls.at(-1)).toBe(false); // restored to prior (false)
    expect(ws.closed).toBe(true);
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDetach).toHaveBeenCalledWith(undefined);
    // Listeners removed (refcount back to baseline).
    expect(stdin.listenerCount()).toBe(0);
    expect(stdout.resizeListenerCount()).toBe(0);
  });

  it("flushes bytes before the chord, then detaches", async () => {
    const { stdin, ws, handle } = await startAttach();
    stdin.feed(Buffer.from([0x61, 0x62, DETACH_CHORD_BYTE, 0x63])); // "ab" Ctrl-] "c"
    await handle.done;
    const inputs = ws.parsedSent().filter((f) => f.type === "input");
    expect(inputs).toHaveLength(1);
    expect(Buffer.from(inputs[0].data as string, "base64").toString("utf8")).toBe("ab");
  });

  it("is idempotent — detach() after a chord does not re-fire onDetach", async () => {
    const { stdin, onDetach, handle } = await startAttach();
    stdin.feed(Buffer.from([DETACH_CHORD_BYTE]));
    await handle.done;
    handle.detach();
    expect(onDetach).toHaveBeenCalledTimes(1);
  });
});

// ── Error / drop paths ─────────────────────────────────────────────────────────

describe("WS close mid-attach surfaces error", () => {
  it("close before exit → onDetach(error) and terminal restored", async () => {
    const { ws, stdout, stdin, onDetach, handle } = await startAttach();
    ws.close();
    await handle.done;
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDetach.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(stdout.all()).toContain(ALT_SCREEN_LEAVE);
    expect(stdin.rawCalls.at(-1)).toBe(false);
  });

  it("WS error → onDetach(error) and clean restore", async () => {
    const { ws, stdout, onDetach, handle } = await startAttach();
    ws.emit("error", new Error("boom"));
    await handle.done;
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect((onDetach.mock.calls[0][0] as Error).message).toBe("boom");
    expect(stdout.all()).toContain(ALT_SCREEN_LEAVE);
  });

  it("server `exit` frame ends the attach cleanly (no error)", async () => {
    const { ws, onDetach, handle } = await startAttach();
    ws.deliver({ type: "exit" });
    await handle.done;
    expect(onDetach).toHaveBeenCalledWith(undefined);
  });

  it("failed ticket mint surfaces the error without opening the WS", async () => {
    const onDetach = vi.fn();
    const wsFactory = vi.fn();
    const handle = attachTerminalSession({
      baseUrl: "http://127.0.0.1:9999",
      sessionId: "s",
      stdin: new FakeStdin(),
      stdout: new FakeStdout(),
      onDetach,
      fetchImpl: vi.fn(async () => new Response("x", { status: 500, statusText: "Err" })) as unknown as typeof fetch,
      wsFactory: wsFactory as never,
    });
    await handle.done;
    expect(wsFactory).not.toHaveBeenCalled();
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDetach.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

// ── Output neutralization (full U10 parity set) ─────────────────────────────────

describe("output neutralization before stdout", () => {
  it("strips OSC 52 clipboard-write", async () => {
    const { stdout, ws } = await startAttach();
    const hostile = `before\x1b]52;c;${Buffer.from("stolen").toString("base64")}\x07after`;
    ws.deliver({ type: "data", data: b64(hostile) });
    const out = stdout.all();
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("52;c;");
  });

  it("strips a non-http(s) (javascript:) OSC 8 link URI but keeps the text", async () => {
    const { stdout, ws } = await startAttach();
    const hostile = `\x1b]8;;javascript:alert(1)\x07click me\x1b]8;;\x07`;
    ws.deliver({ type: "data", data: b64(hostile) });
    const out = stdout.all();
    expect(out).toContain("click me");
    expect(out).not.toContain("javascript:alert(1)");
  });

  it("passes an http(s) OSC 8 link through", async () => {
    const { stdout, ws } = await startAttach();
    const safe = `\x1b]8;;https://example.com\x07link\x1b]8;;\x07`;
    ws.deliver({ type: "data", data: b64(safe) });
    expect(stdout.all()).toContain("https://example.com");
  });

  it("strips a DSR device-status query (would forge input)", async () => {
    const { stdout, ws } = await startAttach();
    const hostile = "x\x1b[6ny"; // DSR cursor-position report
    ws.deliver({ type: "data", data: b64(hostile) });
    const out = stdout.all();
    expect(out).toContain("x");
    expect(out).toContain("y");
    expect(out).not.toContain("\x1b[6n");
  });

  it("neutralizes a sequence split across two frames", async () => {
    const { stdout, ws } = await startAttach();
    // Split an OSC 52 across two data frames.
    const part1 = `safe\x1b]52;c;${Buffer.from("secret").toString("base64")}`;
    const part2 = `\x07tail`;
    ws.deliver({ type: "data", data: b64(part1) });
    ws.deliver({ type: "data", data: b64(part2) });
    const out = stdout.all();
    expect(out).toContain("safe");
    expect(out).toContain("tail");
    expect(out).not.toContain("52;c;");
  });
});

// ── ACK flow control ───────────────────────────────────────────────────────────

describe("ACK flow control", () => {
  it("emits an ACK after the threshold bytes are written", async () => {
    const { stdout, ws } = await startAttach({ ackThresholdBytes: 64 });
    void stdout;
    // 100 bytes of benign output → crosses the 64-byte threshold once.
    ws.deliver({ type: "data", data: b64("a".repeat(100)) });
    const acks = ws.parsedSent().filter((f) => f.type === "ack");
    expect(acks).toHaveLength(1);
    expect(acks[0].bytes).toBeGreaterThanOrEqual(64);
  });

  it("does not ACK below the threshold", async () => {
    const { ws } = await startAttach({ ackThresholdBytes: 1024 });
    ws.deliver({ type: "data", data: b64("short") });
    expect(ws.parsedSent().filter((f) => f.type === "ack")).toHaveLength(0);
  });
});
