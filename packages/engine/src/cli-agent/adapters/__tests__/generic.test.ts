import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CliSessionStore, Database } from "@fusion/core";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import {
  GenericCliAdapter,
  GenericHeuristicAnalyzer,
  GenericCommandMissingError,
  DEFAULT_QUIET_WINDOW_MS,
} from "../generic.js";
import type { CliAgentAdapter } from "../../adapter.js";
import { TelemetryHub, type TelemetryEvent } from "../../telemetry-hub.js";

// ── Capability flags (AE4) ───────────────────────────────────────────────────

describe("GenericCliAdapter capabilities", () => {
  const adapter = new GenericCliAdapter();

  it("declares the heuristic tier: every native capability disabled", () => {
    expect(adapter.id).toBe("generic");
    expect(adapter.capabilities).toEqual({
      nativeDone: false,
      nativeWaiting: false,
      transcriptSource: "none",
      supportsResume: false,
    });
  });

  it("exposes no resume builder (fresh launch only)", () => {
    const asInterface: CliAgentAdapter = adapter;
    expect(asInterface.buildResume).toBeUndefined();
  });

  it("formatInjection only appends CR and never wraps bracketed paste (no double-wrap)", () => {
    // Bracketed-paste wrapping is the session manager's responsibility; the
    // adapter must not also wrap, otherwise the payload double-wraps.
    expect(adapter.formatInjection("hello", { bracketedPasteActive: false })).toEqual({
      payload: "hello\r",
    });
    expect(adapter.formatInjection("hello", { bracketedPasteActive: true })).toEqual({
      payload: "hello\r",
    });
    const wrapped = adapter.formatInjection("multi\nline", { bracketedPasteActive: true });
    expect(wrapped.payload).not.toContain("\x1b[200~");
    expect(wrapped.payload).not.toContain("\x1b[201~");
  });
});

// ── buildLaunch / env ────────────────────────────────────────────────────────

describe("GenericCliAdapter buildLaunch", () => {
  const adapter = new GenericCliAdapter();

  it("builds from a configured command + args, appending extraArgs", () => {
    const spec = adapter.buildLaunch({
      settings: { command: "mytool", args: ["run", "--fast"], extraArgs: ["-v"] },
      posture: null,
    });
    expect(spec).toEqual({ command: "mytool", args: ["run", "--fast", "-v"] });
  });

  it("throws GenericCommandMissingError when no command is configured", () => {
    expect(() => adapter.buildLaunch({ settings: {}, posture: null })).toThrow(
      GenericCommandMissingError,
    );
    expect(() => adapter.buildLaunch({ settings: { command: "  " }, posture: null })).toThrow(
      GenericCommandMissingError,
    );
  });

  it("env allowlist is a minimal explicit set, extensible but never inherit-all", () => {
    const base = adapter.buildEnvAllowlist({ settings: { command: "x" }, posture: null });
    expect(base).toContain("PATH");
    expect(base).toContain("TERM");
    expect(base).not.toContain("FUSION_DAEMON_TOKEN");

    const extended = adapter.buildEnvAllowlist({
      settings: { command: "x", envAllowlist: ["MY_VAR", "PATH"] },
      posture: null,
    });
    expect(extended).toContain("MY_VAR");
    // De-duped.
    expect(extended.filter((k) => k === "PATH")).toHaveLength(1);
  });
});

// ── Readiness ────────────────────────────────────────────────────────────────

describe("GenericCliAdapter readiness", () => {
  const adapter = new GenericCliAdapter();

  it("becomes ready on a prompt-like trailing glyph", () => {
    const det = adapter.createReadinessDetector();
    expect(det.observe("starting up...\n")).toBe(false);
    expect(det.observe("user@host:~$ ")).toBe(true);
  });

  it("is not ready immediately on first non-prompt output (grace window)", () => {
    const det = adapter.createReadinessDetector();
    // No prompt glyph and within the grace window → not yet ready.
    expect(det.observe("loading")).toBe(false);
  });

  it("ignores empty / control-only chunks for readiness", () => {
    const det = adapter.createReadinessDetector();
    expect(det.observe("\x1b[2K")).toBe(false);
  });
});

// ── Heuristic analyzer (fake timers) ─────────────────────────────────────────

describe("GenericHeuristicAnalyzer", () => {
  let now = 0;
  let events: TelemetryEvent[];

  function makeAnalyzer(quietWindowMs = DEFAULT_QUIET_WINDOW_MS) {
    events = [];
    return new GenericHeuristicAnalyzer({
      quietWindowMs,
      now: () => now,
      setTimer: (fn, ms) => {
        const at = now + ms;
        return { fn, at };
      },
      clearTimer: () => {},
      emit: (e) => events.push(e),
    });
  }

  // A trivial deterministic timer: we drive `now` forward and manually fire the
  // pending quiet timer by invoking its captured fn when `now >= at`.
  function fireDue(analyzer: GenericHeuristicAnalyzer, pending: { fn: () => void; at: number }[]) {
    void analyzer;
    for (const t of pending.splice(0)) {
      if (now >= t.at) t.fn();
    }
  }

  beforeEach(() => {
    now = 1_000;
  });

  it("emits outputProgress while streaming", () => {
    const a = makeAnalyzer();
    a.observe("Building the project...\n");
    expect(events.some((e) => e.kind === "outputProgress")).toBe(true);
    const op = events.find((e) => e.kind === "outputProgress");
    expect(op?.payload?.text).toContain("Building the project");
  });

  it("quiet window past threshold with a prompt glyph emits a synthetic idle", () => {
    const pending: { fn: () => void; at: number }[] = [];
    events = [];
    const a = new GenericHeuristicAnalyzer({
      quietWindowMs: DEFAULT_QUIET_WINDOW_MS,
      now: () => now,
      setTimer: (fn, ms) => {
        const entry = { fn, at: now + ms };
        pending.push(entry);
        return entry;
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h as { fn: () => void; at: number });
        if (i >= 0) pending.splice(i, 1);
      },
      emit: (e) => events.push(e),
    });
    a.observe("All done.\nuser@host:~$ ");
    // Advance past the quiet window and fire the timer.
    now += DEFAULT_QUIET_WINDOW_MS + 1;
    fireDue(a, pending);
    expect(events.some((e) => e.kind === "idle")).toBe(true);
  });

  it("spinner override: prompt glyph visible + spinner animating → busy, not idle", () => {
    const pending: { fn: () => void; at: number }[] = [];
    events = [];
    const a = new GenericHeuristicAnalyzer({
      quietWindowMs: DEFAULT_QUIET_WINDOW_MS,
      now: () => now,
      setTimer: (fn, ms) => {
        const entry = { fn, at: now + ms };
        pending.push(entry);
        return entry;
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h as { fn: () => void; at: number });
        if (i >= 0) pending.splice(i, 1);
      },
      emit: (e) => events.push(e),
    });
    // Two distinct spinner frames close in time → animating, with a prompt glyph
    // visible in the same window.
    a.observe("⠋ Working ❯");
    now += 100;
    a.observe("⠙ Working ❯");
    now += DEFAULT_QUIET_WINDOW_MS - 50; // still within spinner-animation memory
    fireDue(a, pending);
    expect(events.some((e) => e.kind === "idle")).toBe(false);
  });

  it("resumed output after idle flips back to busy", () => {
    const pending: { fn: () => void; at: number }[] = [];
    events = [];
    const a = new GenericHeuristicAnalyzer({
      quietWindowMs: DEFAULT_QUIET_WINDOW_MS,
      now: () => now,
      setTimer: (fn, ms) => {
        const entry = { fn, at: now + ms };
        pending.push(entry);
        return entry;
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h as { fn: () => void; at: number });
        if (i >= 0) pending.splice(i, 1);
      },
      emit: (e) => events.push(e),
    });
    a.observe("done\n$ ");
    now += DEFAULT_QUIET_WINDOW_MS + 1;
    fireDue(a, pending);
    expect(events.some((e) => e.kind === "idle")).toBe(true);
    events.length = 0;
    // New output arrives → busy event emitted (idle withdrawn).
    a.observe("running more work...\n");
    expect(events.some((e) => e.kind === "busy")).toBe(true);
  });

  it("idle is never inferred from silence alone (no prompt glyph)", () => {
    const pending: { fn: () => void; at: number }[] = [];
    events = [];
    const a = new GenericHeuristicAnalyzer({
      quietWindowMs: DEFAULT_QUIET_WINDOW_MS,
      now: () => now,
      setTimer: (fn, ms) => {
        const entry = { fn, at: now + ms };
        pending.push(entry);
        return entry;
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h as { fn: () => void; at: number });
        if (i >= 0) pending.splice(i, 1);
      },
      emit: (e) => events.push(e),
    });
    a.observe("partial output with no prompt glyph");
    now += DEFAULT_QUIET_WINDOW_MS + 1;
    fireDue(a, pending);
    expect(events.some((e) => e.kind === "idle")).toBe(false);
  });

  it("classifies ANSI-noise-laden output correctly (strip before pattern match)", () => {
    const pending: { fn: () => void; at: number }[] = [];
    events = [];
    const a = new GenericHeuristicAnalyzer({
      quietWindowMs: DEFAULT_QUIET_WINDOW_MS,
      now: () => now,
      setTimer: (fn, ms) => {
        const entry = { fn, at: now + ms };
        pending.push(entry);
        return entry;
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h as { fn: () => void; at: number });
        if (i >= 0) pending.splice(i, 1);
      },
      emit: (e) => events.push(e),
    });
    // Colored prompt with cursor/clear sequences and a trailing ❯ glyph.
    a.observe("\x1b[2K\x1b[32mAll set.\x1b[0m\r\n\x1b[1m❯\x1b[0m ");
    now += DEFAULT_QUIET_WINDOW_MS + 1;
    fireDue(a, pending);
    expect(events.some((e) => e.kind === "idle")).toBe(true);
    // The emitted progress text is ANSI-stripped.
    const op = events.find((e) => e.kind === "outputProgress");
    expect(op?.payload?.text).not.toContain("\x1b");
    expect(op?.payload?.text).toContain("All set.");
  });
});

// ── End-to-end through the hub + state machine: idle never reaches done ───────

describe("generic heuristic idle via TelemetryHub never advances to done (R20/AE4)", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let store: CliSessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-cli-generic-test-"));
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
    vi.useRealTimers();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function seedBusy(): string {
    return store.createSession({
      purpose: "execute",
      projectId: "proj",
      adapterId: "generic",
      agentState: "busy",
    }).id;
  }

  it("idle event maps to a busy-equivalent idle state, never done", () => {
    const id = seedBusy();
    const hub = new TelemetryHub({ store });
    hub.issueToken(id);

    hub.ingest(id, { kind: "outputProgress", payload: { text: "working" } });
    expect(hub.getStateMachine(id)?.getState()).toBe("busy");

    hub.ingest(id, { kind: "idle" });
    // Machine surfaces the transient idle sub-state...
    expect(hub.getStateMachine(id)?.getState()).toBe("idle");
    // ...but it is NEVER done, and persists as busy (honestly live).
    expect(store.getSession(id)?.agentState).toBe("busy");

    // Resumed output flips idle → busy.
    hub.ingest(id, { kind: "busy" });
    expect(hub.getStateMachine(id)?.getState()).toBe("busy");
  });

  it("no sequence of generic signals (output/idle) ever reaches done", () => {
    const id = seedBusy();
    const hub = new TelemetryHub({ store });
    hub.issueToken(id);

    for (let i = 0; i < 20; i++) {
      hub.ingest(id, { kind: "outputProgress", payload: { text: `chunk ${i}` } });
      hub.ingest(id, { kind: "idle" });
      hub.ingest(id, { kind: "toolActivity" });
    }
    const state = hub.getStateMachine(id)?.getState();
    expect(state).not.toBe("done");
    expect(store.getSession(id)?.agentState).not.toBe("done");
  });

  it("analyzer-emitted events drive the hub without ever advancing to done", () => {
    const id = seedBusy();
    const hub = new TelemetryHub({ store });
    hub.issueToken(id);

    let now = 1_000;
    const pending: { fn: () => void; at: number }[] = [];
    const analyzer = new GenericHeuristicAnalyzer({
      quietWindowMs: DEFAULT_QUIET_WINDOW_MS,
      now: () => now,
      setTimer: (fn, ms) => {
        const entry = { fn, at: now + ms };
        pending.push(entry);
        return entry;
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h as { fn: () => void; at: number });
        if (i >= 0) pending.splice(i, 1);
      },
      emit: (e) => hub.ingest(id, e),
    });

    analyzer.observe("compiling...\n");
    expect(hub.getStateMachine(id)?.getState()).toBe("busy");

    analyzer.observe("done.\n$ ");
    now += DEFAULT_QUIET_WINDOW_MS + 1;
    for (const t of pending.splice(0)) if (now >= t.at) t.fn();
    expect(hub.getStateMachine(id)?.getState()).toBe("idle");
    expect(store.getSession(id)?.agentState).not.toBe("done");

    // Resume.
    analyzer.observe("more work\n");
    expect(hub.getStateMachine(id)?.getState()).toBe("busy");
  });
});
