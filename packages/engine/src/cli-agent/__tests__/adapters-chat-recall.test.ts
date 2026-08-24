/**
 * RUFU-128 Step 4 — adapter changes: claude-code hook-ref optionality (with
 * byte-compat pin) and the pi `--extension` flag.
 *
 * PROMPT.md Step 4 tests (a)-(f).
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildClaudeCodeSettings,
  claudeCodeAdapter,
  type HookScriptRefs,
} from "../adapters/claude-code.js";
import { mapSessionLine, PiSessionTailer, piAdapter } from "../adapters/pi.js";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "adapters-chat-recall-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const COUNT = (args: readonly string[], flag: string): number =>
  args.reduce((n, a) => (a === flag ? n + 1 : n), 0);

describe("claude-code — hook-ref optionality (RUFU-128)", () => {
  it("(a) bare launch regression — no hook scripts → no settings flag, no settings file", () => {
    return withTmp(async (dir) => {
      const settingsPath = join(dir, "settings.json");
      // No hookScripts at all: the apender must not even consider writing.
      const bare = claudeCodeAdapter.buildLaunch({
        settings: { settingsPath },
        posture: null,
      });
      expect(bare.args).not.toContain("--settings");
      expect(existsSync(settingsPath)).toBe(false);

      // Fully empty settings: just the binary.
      const empty = claudeCodeAdapter.buildLaunch({ settings: {}, posture: null });
      expect(empty.command).toBe("claude");
      expect(empty.args).toEqual([]);
    });
  });

  it("(b) only the memory-recall script → settings file with a SINGLE UserPromptSubmit entry, no fabricated core events", () => {
    return withTmp(async (dir) => {
      const scriptPath = join(dir, "recall-hook.sh");
      const settingsPath = join(dir, "recall-settings.json");
      const launch = claudeCodeAdapter.buildLaunch({
        settings: {
          hookScripts: { memoryRecallScript: scriptPath },
          settingsPath,
        },
        posture: null,
      });

      const i = launch.args.indexOf("--settings");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(launch.args[i + 1]).toBe(settingsPath);
      expect(existsSync(settingsPath)).toBe(true);

      const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
      };
      expect(Object.keys(doc.hooks)).toEqual(["UserPromptSubmit"]);
      expect(doc.hooks.UserPromptSubmit).toEqual([
        { hooks: [{ type: "command", command: scriptPath }] },
      ]);
      // No fabricated core hook events.
      for (const forbidden of ["SessionStart", "Stop", "Notification", "PermissionRequest", "PreToolUse", "PostToolUse"]) {
        expect(doc.hooks[forbidden]).toBeUndefined();
      }
    });
  });

  it("(c) all core refs present → settings BYTE-IDENTICAL to the pre-RUFU-128 builder output", () => {
    const refs: HookScriptRefs = {
      sessionStartScript: "/tmp/x/session-start.sh",
      stopScript: "/tmp/x/stop.sh",
      notificationScript: "/tmp/x/notification.sh",
      permissionScript: "/tmp/x/permission.sh",
      toolActivityScript: "/tmp/x/tool-activity.sh",
    };
    // Captured by running the PRE-change builder (git 9dbd07b68) on this exact
    // input: the unconditional core four + tool-activity trio, historical key
    // order. A shape or ordering drift in buildClaudeCodeSettings fails here.
    const EXPECTED_PRE_CHANGE_BYTES =
      '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/tmp/x/session-start.sh"}]}],"Stop":[{"hooks":[{"type":"command","command":"/tmp/x/stop.sh"}]}],"Notification":[{"hooks":[{"type":"command","command":"/tmp/x/notification.sh"}]}],"PermissionRequest":[{"hooks":[{"type":"command","command":"/tmp/x/permission.sh"}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"/tmp/x/tool-activity.sh"}]}],"PostToolUse":[{"hooks":[{"type":"command","command":"/tmp/x/tool-activity.sh"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"/tmp/x/tool-activity.sh"}]}]}}';

    expect(JSON.stringify(buildClaudeCodeSettings(refs))).toBe(EXPECTED_PRE_CHANGE_BYTES);

    // Same bytes through the adapter's inline settings path (no settingsPath).
    const launch = claudeCodeAdapter.buildLaunch({ settings: { hookScripts: refs }, posture: null });
    const i = launch.args.indexOf("--settings");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(launch.args[i + 1]).toBe(EXPECTED_PRE_CHANGE_BYTES);
  });

  it("(c2) all core refs + recall script → UserPromptSubmit holds BOTH entries (merge, in order)", () => {
    const refs: HookScriptRefs = {
      sessionStartScript: "/tmp/x/session-start.sh",
      stopScript: "/tmp/x/stop.sh",
      notificationScript: "/tmp/x/notification.sh",
      permissionScript: "/tmp/x/permission.sh",
      toolActivityScript: "/tmp/x/tool-activity.sh",
      memoryRecallScript: "/tmp/x/recall-hook.sh",
    };
    const doc = buildClaudeCodeSettings(refs);
    expect(Object.keys(doc.hooks)).toEqual([
      "SessionStart",
      "Stop",
      "Notification",
      "PermissionRequest",
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
    ]);
    expect(doc.hooks.UserPromptSubmit.map((e) => e.hooks[0].command)).toEqual([
      "/tmp/x/tool-activity.sh",
      "/tmp/x/recall-hook.sh",
    ]);
  });

  it("(d) resume with hook scripts → argv still carries the settings flag (resume re-wires)", () => {
    const launch = claudeCodeAdapter.buildLaunch({
      settings: { hookScripts: { stopScript: "/tmp/x/stop.sh" } },
      posture: null,
    });
    expect(launch.args).toContain("--settings");

    const resume = claudeCodeAdapter.buildResume!({
      settings: { hookScripts: { stopScript: "/tmp/x/stop.sh" } },
      posture: null,
      nativeSessionId: "sess-native-1",
    });
    const r = resume.args.indexOf("--resume");
    expect(r).toBeGreaterThanOrEqual(0);
    expect(resume.args[r + 1]).toBe("sess-native-1");
    const s = resume.args.indexOf("--settings");
    expect(s).toBeGreaterThanOrEqual(0);
    const doc = JSON.parse(resume.args[s + 1]) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(doc.hooks.Stop[0].hooks[0].command).toBe("/tmp/x/stop.sh");
  });
});

describe("pi — --extension flag (RUFU-128)", () => {
  it("(e) launch AND resume with an extension path → the flag appears exactly once in each; without → none", () => {
    const ext = "/tmp/x/recall-extension.ts";

    const launchWith = piAdapter.buildLaunch({
      settings: { extensionPath: ext },
      posture: null,
    });
    expect(COUNT(launchWith.args, "--extension")).toBe(1);
    const li = launchWith.args.indexOf("--extension");
    expect(launchWith.args[li + 1]).toBe(ext);

    const resumeWith = piAdapter.buildResume!({
      settings: { extensionPath: ext },
      posture: null,
      nativeSessionId: "sess-native-2",
    });
    expect(COUNT(resumeWith.args, "--extension")).toBe(1);
    const ri = resumeWith.args.indexOf("--extension");
    expect(resumeWith.args[ri + 1]).toBe(ext);
    // Resume still re-attaches the session.
    const sr = resumeWith.args.indexOf("--session");
    expect(resumeWith.args[sr + 1]).toBe("sess-native-2");

    const launchBare = piAdapter.buildLaunch({ settings: {}, posture: null });
    expect(COUNT(launchBare.args, "--extension")).toBe(0);
    const resumeBare = piAdapter.buildResume!({
      settings: {},
      posture: null,
      nativeSessionId: "sess-native-2",
    });
    expect(COUNT(resumeBare.args, "--extension")).toBe(0);
  });
});

describe("pi tailer — custom_message entries (RUFU-128 regression pin)", () => {
  it("(f) a display-false custom_message line maps to null (no throw, no event); known types still map", () => {
    // The pi extension's recall message persists in the session JSONL as a
    // CustomMessageEntry (pi dist: { type:"custom_message", customType,
    // content, display }). Interleaved with known entry types:
    const fixtureLines = [
      '{"type":"session","version":3,"id":"uuid-1","timestamp":"2026-08-19T00:00:00Z","cwd":"/x"}',
      '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-08-19T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
      '{"type":"custom_message","customType":"fusion-memory-recall","content":"REC: recall cue line","display":false,"id":"cm1","parentId":"m1","timestamp":"2026-08-19T00:00:02Z"}',
      '{"type":"message","id":"m2","parentId":"cm1","timestamp":"2026-08-19T00:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}]}}',
      '{"type":"turn_end"}',
    ];

    // Direct mapper: the custom line is a no-signal line — null, no throw.
    const customObj = JSON.parse(fixtureLines[2]) as Record<string, unknown>;
    expect(() => mapSessionLine(customObj)).not.toThrow();
    expect(mapSessionLine(customObj)).toBeNull();

    // Full tailer pass over the fixture: exactly the known events, in order —
    // the custom_message line contributes nothing and must not disturb the
    // transcript or state-machine stream.
    const tailer = new PiSessionTailer();
    const events: { kind: string }[] = [];
    for (const line of fixtureLines) {
      for (const ev of tailer.push(line + "\n")) {
        events.push(ev as { kind: string });
      }
    }
    for (const ev of tailer.flush()) events.push(ev as { kind: string });

    expect(events.map((e) => e.kind)).toEqual([
      "sessionStart",
      "transcript",
      "transcript",
      "done",
    ]);
    // And the cue text never leaks into a transcript event.
    const transcriptTexts = events
      .filter((e) => e.kind === "transcript")
      .map((e) => (e as { text?: string }).text);
    expect(transcriptTexts).toEqual(["hello", "hi back"]);
    expect(transcriptTexts.join(" ")).not.toContain("REC:");
  });
});
