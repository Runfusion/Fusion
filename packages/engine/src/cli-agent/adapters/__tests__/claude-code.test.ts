import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database, CliSessionStore } from "@fusion/core";
import { TelemetryHub } from "../../telemetry-hub.js";
import {
  claudeCodeAdapter,
  buildClaudeCodeSettings,
  mapHookPayload,
  parseHookPayload,
  classifyStop,
  isResumeReattach,
  ClaudeTranscriptTailer,
  ClaudeCodeReadinessDetector,
  CLAUDE_CODE_CAPABILITIES,
  type HookScriptRefs,
} from "../claude-code.js";

const SCRIPTS: HookScriptRefs = {
  stopScript: "/tmp/sess/hooks/stop.sh",
  notificationScript: "/tmp/sess/hooks/notify.sh",
  permissionScript: "/tmp/sess/hooks/perm.sh",
  sessionStartScript: "/tmp/sess/hooks/start.sh",
};

describe("claudeCodeAdapter — capabilities + identity", () => {
  it("declares the native tier capability flags", () => {
    expect(claudeCodeAdapter.id).toBe("claude-code");
    expect(claudeCodeAdapter.capabilities).toEqual({
      nativeDone: true,
      nativeWaiting: true,
      transcriptSource: "jsonl",
      supportsResume: true,
    });
    expect(CLAUDE_CODE_CAPABILITIES).toEqual(claudeCodeAdapter.capabilities);
  });
});

describe("claudeCodeAdapter — buildLaunch + settings", () => {
  it("launches bare `claude` with no hook scripts", () => {
    const spec = claudeCodeAdapter.buildLaunch({ settings: {}, posture: null });
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual([]);
  });

  it("builds the verified hooks settings schema for the four core events", () => {
    const doc = buildClaudeCodeSettings(SCRIPTS);
    expect(Object.keys(doc.hooks).sort()).toEqual([
      "Notification",
      "PermissionRequest",
      "SessionStart",
      "Stop",
    ]);
    expect(doc.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: SCRIPTS.stopScript }] },
    ]);
    expect(doc.hooks.SessionStart[0].hooks[0].command).toBe(SCRIPTS.sessionStartScript);
  });

  it("registers tool-activity hooks only when a toolActivityScript is provided", () => {
    const doc = buildClaudeCodeSettings({ ...SCRIPTS, toolActivityScript: "/tmp/sess/hooks/act.sh" });
    expect(doc.hooks.PreToolUse).toBeDefined();
    expect(doc.hooks.PostToolUse).toBeDefined();
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toBe("/tmp/sess/hooks/act.sh");
  });

  it("inlines the settings JSON via --settings when no settingsPath is given", () => {
    const spec = claudeCodeAdapter.buildLaunch({
      settings: { hookScripts: SCRIPTS },
      posture: null,
    });
    const idx = spec.args.indexOf("--settings");
    expect(idx).toBeGreaterThanOrEqual(0);
    const json = spec.args[idx + 1];
    const parsed = JSON.parse(json);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(SCRIPTS.stopScript);
  });

  describe("session-scoped settings file containment", () => {
    let sessionDir: string;
    afterEach(async () => {
      if (sessionDir) await rm(dirname(sessionDir), { recursive: true, force: true });
    });

    it("writes the settings file ONLY to the session-scoped path it was given", () => {
      const root = mkdtempSync(join(tmpdir(), "kb-cc-settings-"));
      sessionDir = join(root, "session-abc");
      const settingsPath = join(sessionDir, "settings.json");
      // create the session dir
      mkdirSync(sessionDir, { recursive: true });

      const spec = claudeCodeAdapter.buildLaunch({
        settings: { hookScripts: SCRIPTS, settingsPath },
        posture: null,
      });

      // The flag points at the session-scoped file, and the file is contained
      // within the session dir — never the user's global ~/.claude.
      const idx = spec.args.indexOf("--settings");
      expect(spec.args[idx + 1]).toBe(settingsPath);
      expect(settingsPath.startsWith(sessionDir)).toBe(true);
      expect(settingsPath.includes(`${sep}.claude${sep}`)).toBe(false);
      expect(existsSync(settingsPath)).toBe(true);
      const written = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(written.hooks.Notification[0].hooks[0].command).toBe(SCRIPTS.notificationScript);
    });
  });

  it("appends model + extraArgs", () => {
    const spec = claudeCodeAdapter.buildLaunch({
      settings: { model: "claude-opus", extraArgs: ["--add-dir", "/x"] },
      posture: null,
    });
    expect(spec.args).toEqual(["--model", "claude-opus", "--add-dir", "/x"]);
  });

  it("emits the privileged flag ONLY when posture.autoApprove is true", () => {
    const off = claudeCodeAdapter.buildLaunch({ settings: {}, posture: { autoApprove: false } });
    expect(off.args).not.toContain("--dangerously-skip-permissions");
    const on = claudeCodeAdapter.buildLaunch({ settings: {}, posture: { autoApprove: true } });
    expect(on.args).toContain("--dangerously-skip-permissions");
  });

  it("env allowlist excludes FUSION_* / service credentials", () => {
    const allow = claudeCodeAdapter.buildEnvAllowlist({ settings: {}, posture: null });
    expect(allow).toContain("PATH");
    expect(allow).toContain("ANTHROPIC_API_KEY");
    expect(allow.some((k) => k.startsWith("FUSION_"))).toBe(false);
  });
});

describe("claudeCodeAdapter — buildResume", () => {
  it("produces `claude --resume <id>` (AE3)", () => {
    const spec = claudeCodeAdapter.buildResume!({
      settings: {},
      posture: null,
      nativeSessionId: "sess-123",
    });
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual(["--resume", "sess-123"]);
  });

  it("re-applies hook settings + posture on resume", () => {
    const spec = claudeCodeAdapter.buildResume!({
      settings: { hookScripts: SCRIPTS },
      posture: { autoApprove: true },
      nativeSessionId: "sess-9",
    });
    expect(spec.args.slice(0, 2)).toEqual(["--resume", "sess-9"]);
    expect(spec.args).toContain("--settings");
    expect(spec.args).toContain("--dangerously-skip-permissions");
  });

  it("recognizes SessionStart{source:resume} as a re-attach (AE3)", () => {
    expect(isResumeReattach({ hook_event_name: "SessionStart", source: "resume" })).toBe(true);
    expect(isResumeReattach({ hook_event_name: "SessionStart", source: "startup" })).toBe(false);
    expect(isResumeReattach({ hook_event_name: "Stop", source: "resume" })).toBe(false);
  });
});

describe("claudeCodeAdapter — formatInjection", () => {
  it("appends a trailing \\r submit", () => {
    expect(claudeCodeAdapter.formatInjection("hello", { bracketedPasteActive: false })).toEqual({
      payload: "hello\r",
    });
  });
  it("does not double the trailing \\r", () => {
    expect(claudeCodeAdapter.formatInjection("hi\r", { bracketedPasteActive: true })).toEqual({
      payload: "hi\r",
    });
  });
});

describe("claudeCodeAdapter — readiness detector", () => {
  it("becomes ready on the bracketed-paste enable sequence", () => {
    const d = new ClaudeCodeReadinessDetector();
    expect(d.observe("loading...\n")).toBe(false);
    expect(d.observe("\x1b[?2004h")).toBe(true);
    expect(d.observe("more")).toBe(true); // latches
  });
  it("falls back to a prompt-glyph at line start", () => {
    const d = new ClaudeCodeReadinessDetector();
    expect(d.observe("welcome\n")).toBe(false);
    expect(d.observe("\n> ")).toBe(true);
  });
});

describe("mapHookPayload — telemetry mapping", () => {
  it("SessionStart → sessionStart capturing session_id + transcript_path", () => {
    const ev = mapHookPayload({
      hook_event_name: "SessionStart",
      session_id: "S1",
      transcript_path: "/t/x.jsonl",
      source: "startup",
    });
    expect(ev?.kind).toBe("sessionStart");
    expect(ev?.payload?.nativeSessionId).toBe("S1");
    expect(ev?.payload?.transcriptPath).toBe("/t/x.jsonl");
    expect(ev?.payload?.source).toBe("startup");
  });

  it("UserPromptSubmit → busy; PreToolUse/PostToolUse → toolActivity", () => {
    expect(mapHookPayload({ hook_event_name: "UserPromptSubmit", session_id: "S1" })?.kind).toBe(
      "busy",
    );
    expect(mapHookPayload({ hook_event_name: "PreToolUse", tool_name: "Bash" })?.kind).toBe(
      "toolActivity",
    );
    expect(mapHookPayload({ hook_event_name: "PostToolUse" })?.kind).toBe("toolActivity");
  });

  it("PermissionRequest → waitingOnInput", () => {
    const ev = mapHookPayload({ hook_event_name: "PermissionRequest", session_id: "S1" });
    expect(ev?.kind).toBe("waitingOnInput");
    expect((ev?.payload?.notification as Record<string, unknown>).kind).toBe("permission_request");
  });

  it("Notification{permission_prompt|idle_prompt} → waitingOnInput", () => {
    const perm = mapHookPayload({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    expect(perm?.kind).toBe("waitingOnInput");
    const idle = mapHookPayload({
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
    });
    expect(idle?.kind).toBe("waitingOnInput");
    expect((idle?.payload?.notification as Record<string, unknown>).kind).toBe("idle_prompt");
  });

  it("Notification{other} → toolActivity (non-blocking)", () => {
    expect(
      mapHookPayload({ hook_event_name: "Notification", notification_type: "info" })?.kind,
    ).toBe("toolActivity");
  });

  it("Stop → done (positive completion)", () => {
    const ev = mapHookPayload({ hook_event_name: "Stop", session_id: "S1" });
    expect(ev?.kind).toBe("done");
    expect(ev?.payload?.nativeSessionId).toBe("S1");
  });

  it("tolerates missing optional fields (no session_id, no source, etc.)", () => {
    expect(mapHookPayload({ hook_event_name: "SessionStart" })?.kind).toBe("sessionStart");
    expect(mapHookPayload({ hook_event_name: "Stop" })?.kind).toBe("done");
    expect(mapHookPayload({})).toBeNull();
  });

  it("unknown hook with a session id → outputProgress, otherwise null", () => {
    expect(mapHookPayload({ hook_event_name: "Weird", session_id: "S" })?.kind).toBe(
      "outputProgress",
    );
    expect(mapHookPayload({ hook_event_name: "Weird" })).toBeNull();
  });
});

describe("classifyStop — failure downgrade", () => {
  it("maps a clean Stop to done", () => {
    expect(classifyStop({ hook_event_name: "Stop" }).kind).toBe("done");
  });
  it("maps an error-ish stop_reason to toolActivity, not done", () => {
    const ev = classifyStop({ hook_event_name: "Stop", stop_reason: "error_max_tokens" });
    expect(ev.kind).toBe("toolActivity");
    expect(ev.payload?.stopReason).toBe("error_max_tokens");
  });
});

describe("parseHookPayload — raw stdin parsing", () => {
  it("parses a JSON string into a normalized event", () => {
    const ev = parseHookPayload('{"hook_event_name":"Stop","session_id":"S1"}');
    expect(ev?.kind).toBe("done");
  });
  it("returns null on unparseable input (never throws)", () => {
    expect(parseHookPayload("not json")).toBeNull();
    expect(parseHookPayload("[]")).toBeNull();
  });
});

describe("ClaudeTranscriptTailer — incremental JSONL tail", () => {
  it("yields entries incrementally across appended writes and remembers offset", () => {
    const tailer = new ClaudeTranscriptTailer();
    const l1 = JSON.stringify({ message: { role: "user", content: "hi" } }) + "\n";
    const first = tailer.push(l1);
    expect(first).toEqual([{ role: "user", text: "hi" }]);
    expect(tailer.bytesRead).toBe(Buffer.byteLength(l1, "utf8"));

    const l2 = JSON.stringify({ message: { role: "assistant", content: "hello" } }) + "\n";
    const second = tailer.push(l2);
    expect(second).toEqual([{ role: "assistant", text: "hello" }]);
    expect(tailer.bytesRead).toBe(Buffer.byteLength(l1 + l2, "utf8"));
  });

  it("holds a partial trailing line until its newline arrives", () => {
    const tailer = new ClaudeTranscriptTailer();
    const full = JSON.stringify({ message: { role: "user", content: "split" } });
    expect(tailer.push(full.slice(0, 10))).toEqual([]); // partial
    expect(tailer.push(full.slice(10) + "\n")).toEqual([{ role: "user", text: "split" }]);
  });

  it("flattens content-block arrays and normalizes roles", () => {
    const tailer = new ClaudeTranscriptTailer();
    const line =
      JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
      }) + "\n";
    expect(tailer.push(line)).toEqual([{ role: "assistant", text: "AB" }]);
  });

  it("skips unparseable / empty lines without throwing", () => {
    const tailer = new ClaudeTranscriptTailer();
    expect(tailer.push("\n{bad}\n\n")).toEqual([]);
  });

  it("flush() emits a final unterminated line", () => {
    const tailer = new ClaudeTranscriptTailer();
    expect(tailer.push(JSON.stringify({ role: "tool", content: "result" }))).toEqual([]);
    expect(tailer.flush()).toEqual([{ role: "tool", text: "result" }]);
  });
});

describe("end-to-end via TelemetryHub: SessionStart → PreToolUse → Stop", () => {
  let tmpDir: string;
  let db: Database;
  let store: CliSessionStore;
  let hub: TelemetryHub;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-cc-e2e-"));
    const fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
    const rec = store.createSession({
      purpose: "execute",
      projectId: "p1",
      adapterId: "claude-code",
      agentState: "starting",
    });
    sessionId = rec.id;
    hub = new TelemetryHub({ store });
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function feed(payload: Parameters<typeof mapHookPayload>[0]) {
    const ev = mapHookPayload(payload);
    if (ev) hub.ingest(sessionId, ev);
  }

  it("drives ready → busy → done and persists session_id from the first payload", () => {
    feed({ hook_event_name: "SessionStart", session_id: "native-abc", transcript_path: "/t.jsonl" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("ready");
    // session_id captured from the FIRST payload.
    expect(store.getSession(sessionId)?.nativeSessionId).toBe("native-abc");

    // ready → busy is the injection-driven transition the session manager makes
    // when the engine injects the prompt; telemetry then tracks the busy turn.
    hub.getStateMachine(sessionId)!.injectPrompt();
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("busy");

    feed({ hook_event_name: "PreToolUse", session_id: "native-abc", tool_name: "Bash" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("busy"); // activity, no advance

    feed({ hook_event_name: "Stop", session_id: "native-abc" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("done");
  });

  it("PermissionRequest → waitingOnInput; idle_prompt notification → waitingOnInput", () => {
    feed({ hook_event_name: "SessionStart", session_id: "n2" });
    hub.getStateMachine(sessionId)!.injectPrompt(); // ready → busy
    feed({ hook_event_name: "PermissionRequest", session_id: "n2" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("waitingOnInput");

    // user answers (waitingOnInput → busy via the hub's `busy` route), then an
    // idle_prompt notification re-enters waiting.
    feed({ hook_event_name: "UserPromptSubmit", session_id: "n2" }); // busy
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("busy");
    feed({ hook_event_name: "Notification", session_id: "n2", notification_type: "idle_prompt" });
    expect(hub.getStateMachine(sessionId)?.getState()).toBe("waitingOnInput");
  });
});
