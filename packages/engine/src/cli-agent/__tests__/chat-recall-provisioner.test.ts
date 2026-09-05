/**
 * RUFU-128 Step 3 — chat recall provisioner tests.
 *
 * Spec test list: (a) fresh resolve mkdtemps + maps; (b) double-resolve
 * reuses; (c) terminate → re-resolve → fresh dir, old dir gone, no ENOENT
 * (the round-1 blocker regression); (d) finalize after an external rm still
 * writes (defensive mkdir); (e) boot sweep removes orphaned recall dirs and
 * leaves other entries alone; (f) all created dirs/files are 0o700;
 * (g) claude artifacts: settings file has exactly one UserPromptSubmit hook,
 * script embeds the correct URL + headers; pi artifact: factory shape,
 * display-false, token embedded.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CliSession, Settings } from "@fusion/core";
import {
  CHAT_RECALL_SCRATCH_PREFIX,
  ChatRecallProvisioner,
  type ChatRecallHubHolder,
} from "../chat-recall-provisioner.js";
import type { TelemetryHub } from "../telemetry-hub.js";

const ENDPOINT = "http://127.0.0.1:1/api/cli-agent/memory-recall";
const RECORD_CWD = mkdtempSync(join(tmpdir(), "chat-recall-provisioner-cwd-"));
afterAll(() => rmSync(RECORD_CWD, { recursive: true, force: true }));

/** A token-issuing stand-in for the telemetry hub (idempotent issue, invalidate). */
class FakeHub {
  readonly tokens = new Map<string, string>();
  readonly invalidated: string[] = [];
  private n = 0;
  issueToken(sessionId: string): string {
    const existing = this.tokens.get(sessionId);
    if (existing) return existing;
    const token = `tok-${++this.n}`;
    this.tokens.set(sessionId, token);
    return token;
  }
  validateToken(sessionId: string, token: string | null | undefined): boolean {
    return typeof token === "string" && token !== "" && this.tokens.get(sessionId) === token;
  }
  invalidate(sessionId: string): void {
    this.invalidated.push(sessionId);
    this.tokens.delete(sessionId);
  }
  hasSession(sessionId: string): boolean {
    return this.tokens.has(sessionId);
  }
}

function makeRecord(overrides: Partial<CliSession> = {}): CliSession {
  return {
    id: "cli-test-1",
    taskId: null,
    chatSessionId: "chat-1",
    purpose: "chat",
    projectId: "proj-1",
    adapterId: "claude-code",
    command: "claude",
    args: [],
    cwd: RECORD_CWD,
    extraEnv: {},
    hookDir: null,
    agentState: "idle",
    agentStateSince: null,
    terminalBusy: false,
    lastActiveAt: null,
    terminationReason: null,
    nativeSessionId: null,
    lastKnownTitle: null,
    resumeCoordinator: null,
    lastTelemetry: null,
    ...overrides,
  } as unknown as CliSession;
}

interface Harness {
  root: string;
  scratchRoot: string;
  sessions: Map<string, CliSession>;
  hub: FakeHub;
  holder: ChatRecallHubHolder;
  settings: { value: Partial<Settings> | null | undefined; fn: () => Promise<Partial<Settings> | null | undefined> };
  makeProvisioner: () => ChatRecallProvisioner;
  dispose: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "chat-recall-test-"));
  const scratchRoot = join(root, "tmp");
  const sessions = new Map<string, CliSession>();
  const hub = new FakeHub();
  const holder: ChatRecallHubHolder = { hub: hub as unknown as TelemetryHub };
  const settings = {
    value: undefined as Partial<Settings> | null | undefined,
    fn: async () => settings.value,
  };
  return {
    root,
    scratchRoot,
    sessions,
    hub,
    holder,
    settings,
    makeProvisioner: () =>
      new ChatRecallProvisioner({
        rootDir: root,
        recallEndpointUrl: ENDPOINT,
        hub: holder,
        getSession: (id) => sessions.get(id),
        getSettings: settings.fn,
      }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function recallDirs(h: Harness): string[] {
  try {
    return readdirSync(h.scratchRoot).filter((name) =>
      name.startsWith(CHAT_RECALL_SCRATCH_PREFIX),
    );
  } catch {
    return [];
  }
}

/** Await the fire-and-forget rm of a terminated scratch dir. */
async function waitForDirGone(dir: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(dir)).toBe(false), { timeout: 5000 });
}

let h: Harness | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (h) {
    await h.dispose();
    h = undefined;
  }
});

describe("launchSettingsFor — gating", () => {
  it("returns null for a non-chat (task) session — no token issued, no dir created", async () => {
    h = await makeHarness();
    h.sessions.set("cli-t1", makeRecord({ id: "cli-t1", purpose: "execute", taskId: "FN-1" }));
    const result = await h.makeProvisioner().launchSettingsFor("cli-t1");
    expect(result).toBeNull();
    expect(h.hub.tokens.size).toBe(0);
    expect(recallDirs(h)).toEqual([]);
  });

  it("throws for a missing record (internal error — fail the spawn loudly)", async () => {
    h = await makeHarness();
    await expect(h.makeProvisioner().launchSettingsFor("cli-missing")).rejects.toThrow(/no session record/);
  });

  /*
  FNXC:CliChatRecall 2026-08-19-19:30:
  RUFU-128 Step 7: the spawn-time settings gate must produce a BARE chat
  spawn on BOTH supported adapters — null launch settings (no settings flag
  / extension flag) and no scratch dir — with settings off.
  */
  it.each(["claude-code", "pi"])(
    "returns null when memoryEnabled is false — bare spawn on %s, no token, no scratch dir (spawn-time gate)",
    async (adapterId) => {
      h = await makeHarness();
      h.sessions.set("cli-test-1", makeRecord({ adapterId }));
      h.settings.value = { memoryEnabled: false };
      const result = await h.makeProvisioner().launchSettingsFor("cli-test-1");
      expect(result).toBeNull();
      expect(h.hub.tokens.size).toBe(0);
      expect(recallDirs(h)).toEqual([]);
    },
  );

  it.each(["claude-code", "pi"])(
    "returns null when memoryPerTurnRecallEnabled is false — bare spawn on %s, no token, no scratch dir",
    async (adapterId) => {
      h = await makeHarness();
      h.sessions.set("cli-test-1", makeRecord({ adapterId }));
      h.settings.value = { memoryPerTurnRecallEnabled: false };
      const result = await h.makeProvisioner().launchSettingsFor("cli-test-1");
      expect(result).toBeNull();
      expect(h.hub.tokens.size).toBe(0);
      expect(recallDirs(h)).toEqual([]);
    },
  );

  it("defaults ON when settings are absent (undefined) and provisions", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord());
    const result = await h.makeProvisioner().launchSettingsFor("cli-test-1");
    expect(result).not.toBeNull();
    expect(h.hub.tokens.size).toBe(1);
  });

  it("returns null for an unsupported adapter (graceful bare degrade)", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord({ adapterId: "codex" }));
    const result = await h.makeProvisioner().launchSettingsFor("cli-test-1");
    expect(result).toBeNull();
    expect(h.hub.tokens.size).toBe(0);
    expect(recallDirs(h)).toEqual([]);
  });

  it("throws when the hub holder is null (internal error — loud, not silent-bare)", async () => {
    h = await makeHarness();
    const harness = h;
    h.sessions.set("cli-test-1", makeRecord());
    const provisioner = new ChatRecallProvisioner({
      rootDir: harness.root,
      recallEndpointUrl: ENDPOINT,
      hub: { hub: null },
      getSession: (id) => harness.sessions.get(id),
    });
    await expect(provisioner.launchSettingsFor("cli-test-1")).rejects.toThrow(/hub not available/);
  });
});

describe("scratch-dir resolution — idempotent + terminate→resume (round-1 blocker)", () => {
  it("(a) fresh resolve mkdtemps under the root with the prefix and maps it", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord());
    const result = (await h.makeProvisioner().launchSettingsFor("cli-test-1")) as { settingsPath: string };
    const dirs = recallDirs(h);
    expect(dirs).toHaveLength(1);
    expect(dirname(result.settingsPath)).toBe(join(h.scratchRoot, dirs[0]));
    expect(basename(result.settingsPath)).toBe("recall-settings.json");
  });

  it("(b) double-resolve reuses the same dir (no second dir)", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord());
    const provisioner = h.makeProvisioner();
    const first = await provisioner.launchSettingsFor("cli-test-1");
    const second = await provisioner.launchSettingsFor("cli-test-1");
    expect(second).toEqual(first);
    expect(recallDirs(h)).toHaveLength(1);
  });

  it("(c) terminate → re-resolve → fresh dir, old dir gone, no ENOENT (regression)", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord());
    const provisioner = h.makeProvisioner();
    const first = (await provisioner.launchSettingsFor("cli-test-1")) as {
      settingsPath: string;
      hookScripts: { memoryRecallScript: string };
    };
    await provisioner.finalize("cli-test-1");
    const firstDir = dirname(first.settingsPath);
    const firstToken = h.hub.tokens.get("cli-test-1")!;
    expect(firstToken).toBeDefined();

    provisioner.terminate("cli-test-1");
    await waitForDirGone(firstDir);

    // Re-provision (resume): a fresh dir, a re-issued (different) token, no ENOENT.
    const second = (await provisioner.launchSettingsFor("cli-test-1")) as {
      settingsPath: string;
      hookScripts: { memoryRecallScript: string };
    };
    const secondDir = dirname(second.settingsPath);
    expect(secondDir).not.toBe(firstDir);
    expect(existsSync(secondDir)).toBe(true);
    expect(recallDirs(h)).toEqual([basename(secondDir)]);
    const secondToken = h.hub.tokens.get("cli-test-1")!;
    expect(secondToken).not.toBe(firstToken);
    // The old token is dead.
    expect(h.hub.validateToken("cli-test-1", firstToken)).toBe(false);
    // finalize on the fresh dir works (no ENOENT) and embeds the fresh token.
    await provisioner.finalize("cli-test-1");
    expect(readFileSync(second.hookScripts.memoryRecallScript, "utf8")).toContain(secondToken);
  });

  it("terminate is a FULL no-op for an un-provisioned session (task session hub state untouched)", async () => {
    h = await makeHarness();
    h.sessions.set("cli-task-1", makeRecord({ id: "cli-task-1", purpose: "execute", taskId: "FN-1" }));
    const provisioner = h.makeProvisioner();
    expect(() => provisioner.terminate("cli-task-1")).not.toThrow();
    expect(h.hub.invalidated).toEqual([]);
    expect(h.hub.tokens.size).toBe(0);
  });

  it("terminate invalidates the hub token for a provisioned chat session", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord());
    const provisioner = h.makeProvisioner();
    await provisioner.launchSettingsFor("cli-test-1");
    const token = h.hub.tokens.get("cli-test-1")!;
    expect(h.hub.validateToken("cli-test-1", token)).toBe(true);
    provisioner.terminate("cli-test-1");
    expect(h.hub.invalidated).toEqual(["cli-test-1"]);
    expect(h.hub.validateToken("cli-test-1", token)).toBe(false);
  });
});

describe("finalize — artifacts", () => {
  it("(d) writes after an external rm of the dir (defensive mkdir)", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord());
    const provisioner = h.makeProvisioner();
    const launch = (await provisioner.launchSettingsFor("cli-test-1")) as { settingsPath: string };
    // Simulate a racing teardown / external removal between launch and finalize.
    rmSync(dirname(launch.settingsPath), { recursive: true, force: true });
    expect(existsSync(launch.settingsPath)).toBe(false);
    await provisioner.finalize("cli-test-1");
    expect(existsSync(launch.settingsPath)).toBe(true);
  });

  it("throws when finalize runs before launchSettingsFor (no scratch dir)", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord());
    await expect(h.makeProvisioner().finalize("cli-test-1")).rejects.toThrow(/no scratch dir/);
  });

  it("(g-claude) settings file has exactly ONE UserPromptSubmit hook; script embeds URL + headers + token", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord());
    const provisioner = h.makeProvisioner();
    const launch = (await provisioner.launchSettingsFor("cli-test-1")) as {
      hookScripts: { memoryRecallScript: string };
      settingsPath: string;
    };
    await provisioner.finalize("cli-test-1");

    const settingsJson = JSON.parse(readFileSync(launch.settingsPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(settingsJson.hooks)).toEqual(["UserPromptSubmit"]);
    const entries = settingsJson.hooks.UserPromptSubmit as Array<{
      hooks: Array<{ type: string; command: string }>;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks).toEqual([{ type: "command", command: launch.hookScripts.memoryRecallScript }]);

    const script = readFileSync(launch.hookScripts.memoryRecallScript, "utf8");
    expect(script).toContain(`ENDPOINT='${ENDPOINT}'`);
    expect(script).toContain("X-Fusion-Cli-Session-Token: $TOKEN");
    expect(script).toContain("X-Fusion-Cli-Session-Id: $SESSION_ID");
    expect(script).toContain(`TOKEN='${h.hub.tokens.get("cli-test-1")}'`);
    expect(script).toContain("SESSION_ID='cli-test-1'");
    expect(script).toContain("curl -sS -f -X POST");
  });

  it("(g-pi) extension: factory shape, display-false custom message, token embedded", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord({ adapterId: "pi" }));
    const provisioner = h.makeProvisioner();
    const launch = (await provisioner.launchSettingsFor("cli-test-1")) as { extensionPath: string };
    await provisioner.finalize("cli-test-1");

    const src = readFileSync(launch.extensionPath, "utf8");
    expect(src).toContain("before_agent_start");
    expect(src).toContain("display: false");
    expect(src).toContain(`const TOKEN = ${JSON.stringify(h.hub.tokens.get("cli-test-1"))};`);
    expect(src).toContain(`const SESSION_ID = "cli-test-1";`);
    expect(src).toContain(`const ENDPOINT = ${JSON.stringify(ENDPOINT)};`);

    // Factory shape: the default export is a function taking the api object.
    const mod = await import(pathToFileURL(launch.extensionPath).href);
    expect(typeof mod.default).toBe("function");
    let handler:
      | ((event: { prompt?: unknown }) => Promise<{ message?: { customType: string; content: string; display: boolean } } | undefined>)
      | undefined;
    mod.default({
      on: (event: string, fn: unknown) => {
        expect(event).toBe("before_agent_start");
        handler = fn as typeof handler;
      },
    });
    expect(handler).toBeDefined();

    // Cue returned → hidden custom message; correct URL, body, and headers.
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "CUE-123" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await handler!({ prompt: "hello" });
    expect(result).toEqual({
      message: { customType: "fusion-memory-recall", content: "CUE-123", display: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe(ENDPOINT);
    expect(JSON.parse(init.body)).toEqual({ prompt: "hello" });
    expect(init.headers["x-fusion-cli-session-token"]).toBe(h.hub.tokens.get("cli-test-1"));
    expect(init.headers["x-fusion-cli-session-id"]).toBe("cli-test-1");

    // Fetch failure → no cue (undefined), no throw.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(await handler!({ prompt: "hello again" })).toBeUndefined();

    // Empty cue → undefined.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "  " })));
    expect(await handler!({ prompt: "hello thrice" })).toBeUndefined();

    // Non-2xx → undefined.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, text: async () => "" })));
    expect(await handler!({ prompt: "hello fourth" })).toBeUndefined();
  });
});

describe("boot-time orphan sweep", () => {
  it("(e) removes orphaned fusion-cli-recall-* dirs and leaves other entries alone", async () => {
    h = await makeHarness();
    mkdirSync(h.scratchRoot, { recursive: true });
    const orphanDir = join(h.scratchRoot, `${CHAT_RECALL_SCRATCH_PREFIX}abc123`);
    mkdirSync(join(orphanDir, "nested"), { recursive: true });
    const keepDir = join(h.scratchRoot, "some-other-dir");
    mkdirSync(keepDir, { recursive: true });
    // A non-dir with the prefix is left (the sweep matches directories only).
    const prefixNamedFile = join(h.scratchRoot, `${CHAT_RECALL_SCRATCH_PREFIX}not-a-dir`);
    writeFileSync(prefixNamedFile, "keep me");

    h.makeProvisioner(); // construction runs the sweep
    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(keepDir)).toBe(true);
    expect(existsSync(prefixNamedFile)).toBe(true);
  });
});

describe("file modes (0o700)", () => {
  it("(f) scratch root, dir, script, and settings are all 0o700", async () => {
    h = await makeHarness();
    h.sessions.set("cli-test-1", makeRecord());
    const provisioner = h.makeProvisioner();
    const launch = (await provisioner.launchSettingsFor("cli-test-1")) as {
      hookScripts: { memoryRecallScript: string };
      settingsPath: string;
    };
    await provisioner.finalize("cli-test-1");
    expect(statSync(h.scratchRoot).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(launch.settingsPath)).mode & 0o777).toBe(0o700);
    expect(statSync(launch.settingsPath).mode & 0o777).toBe(0o700);
    expect(statSync(launch.hookScripts.memoryRecallScript).mode & 0o777).toBe(0o700);
  });
});

describe("claude hook script — real execution (no PTY: sh + local HTTP only)", () => {
  interface Capture {
    method?: string;
    url?: string;
    headers: NonNullable<IncomingMessage["headers"]>;
    body: string;
    requests: number;
  }

  async function startServer(response: { status: number; body: string }): Promise<{
    endpoint: string;
    capture: Capture;
    close: () => Promise<void>;
  }> {
    const capture: Capture = { headers: {} as NonNullable<IncomingMessage["headers"]>, body: "", requests: 0 };
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      capture.requests += 1;
      capture.method = req.method;
      capture.url = req.url;
      capture.headers = { ...req.headers };
      let body = "";
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        capture.body = body;
        res.writeHead(response.status, { "content-type": "text/plain" });
        res.end(response.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      endpoint: `http://127.0.0.1:${port}/api/cli-agent/memory-recall`,
      capture,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  async function provisionAgainst(endpoint: string, harness: Harness): Promise<{
    scriptPath: string;
    provisioner: ChatRecallProvisioner;
  }> {
    harness.sessions.set("cli-test-1", makeRecord());
    const provisioner = new ChatRecallProvisioner({
      rootDir: harness.root,
      recallEndpointUrl: endpoint,
      hub: harness.holder,
      getSession: (id) => harness.sessions.get(id),
    });
    const launch = (await provisioner.launchSettingsFor("cli-test-1")) as {
      hookScripts: { memoryRecallScript: string };
    };
    await provisioner.finalize("cli-test-1");
    return { scriptPath: launch.hookScripts.memoryRecallScript, provisioner };
  }

  /**
   * Run the generated hook script under a real `sh` with the stdin payload —
   * no PTY, no AI CLI. `spawn` + manual stdin because the shared vitest setup's
   * `execFile` wrapper drops the `input` option (stdin never closes, so the
   * script hangs until timeout); `spawn`'s stdin stream is unaffected.
   */
  function runScript(
    scriptPath: string,
    input: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn("sh", [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGKILL");
        resolve({ code: null, stdout, stderr: `${stderr}\n[harness] script timed out` });
      }, 15000);
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      proc.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: `${stderr}\n${String(err)}` });
      });
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      proc.stdin.write(input);
      proc.stdin.end();
    });
  }

  it("extracts the prompt from stdin, POSTs with token/session headers, prints the cue to stdout", async () => {
    h = await makeHarness();
    const serverInfo = await startServer({ status: 202, body: "REC: recall cue line" });
    const { scriptPath } = await provisionAgainst(serverInfo.endpoint, h);

    const payload = JSON.stringify({ prompt: "hello world", session_id: "irrelevant" });
    const { stdout, code } = await runScript(scriptPath, payload);
    expect(code).toBe(0);
    expect(stdout).toBe("REC: recall cue line");
    expect(serverInfo.capture.requests).toBe(1);
    expect(serverInfo.capture.method).toBe("POST");
    expect(serverInfo.capture.url).toBe("/api/cli-agent/memory-recall");
    expect(serverInfo.capture.headers["content-type"]).toBe("application/json");
    expect(serverInfo.capture.headers["x-fusion-cli-session-token"]).toBe(
      h!.hub.tokens.get("cli-test-1") ?? undefined,
    );
    expect(serverInfo.capture.headers["x-fusion-cli-session-id"]).toBe("cli-test-1");
    expect(serverInfo.capture.headers.origin).toBeUndefined();
    expect(JSON.parse(serverInfo.capture.body)).toEqual({ prompt: "hello world" });
    await serverInfo.close();
  });

  it("non-2xx → silent no-op: exit 0, no stdout, cue never reaches the conversation", async () => {
    h = await makeHarness();
    const serverInfo = await startServer({ status: 401, body: "unauthorized" });
    const { scriptPath } = await provisionAgainst(serverInfo.endpoint, h);

    const { stdout, code } = await runScript(scriptPath, JSON.stringify({ prompt: "hi" }));
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(serverInfo.capture.requests).toBe(1);
    await serverInfo.close();
  });

  it("missing prompt → no request at all (silent no-op)", async () => {
    h = await makeHarness();
    const serverInfo = await startServer({ status: 202, body: "" });
    const { scriptPath } = await provisionAgainst(serverInfo.endpoint, h);

    const { stdout, code } = await runScript(scriptPath, JSON.stringify({ session_id: "only" }));
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(serverInfo.capture.requests).toBe(0);
    await serverInfo.close();
  });
});
