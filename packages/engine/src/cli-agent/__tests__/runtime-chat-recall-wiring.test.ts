/**
 * RUFU-128 Step 5 — runtime wiring: createCliAgentRuntime constructs the
 * chat-recall provisioner (scratch root + recall endpoint from the new
 * optional runtime options) and passes its launch-settings provider +
 * termination callback through the manager options. The manager is built
 * BEFORE the hub, so the provisioner reads the hub through a holder
 * populated immediately after hub construction.
 *
 * Here only the wiring is asserted (task purpose → null before any artifact;
 * holder populated — a chat-purpose provider call succeeds, which would throw
 * on a null holder; finalize wrote the artifacts with a live hub; terminate
 * tears the dir down). Step 8 covers the spawn-level integration.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliSessionStore, type AsyncDataLayer, type CliSession } from "@fusion/core";
import type { CliSessionManager } from "../session-manager.js";
import { createCliAgentRuntime } from "../runtime.js";
import { CHAT_RECALL_SCRATCH_PREFIX } from "../chat-recall-provisioner.js";

function makeRecord(overrides: Partial<CliSession>): CliSession {
  return {
    id: "session-x",
    adapterId: "claude-code",
    projectId: "project-a",
    purpose: "execute",
    taskId: null,
    chatSessionId: null,
    worktreePath: null,
    autonomyPosture: null,
    agentState: "idle",
    ...overrides,
  } as CliSession;
}

function fakeStore(sessions: Map<string, CliSession>): CliSessionStore {
  return Object.assign(new EventEmitter(), {
    flush: vi.fn(async () => {}),
    listSessions: () => [...sessions.values()],
    listByTask: () => [],
    getSession: (id: string) => sessions.get(id),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
  }) as unknown as CliSessionStore;
}

/** Read the manager's (private) RUFU-128 provider/terminate seams. */
function managerSeams(manager: CliSessionManager): {
  provider: (id: string) => Promise<Record<string, unknown> | null>;
  onTerminated: (id: string) => void;
} {
  const m = manager as unknown as {
    launchSettingsProvider: (id: string) => Promise<Record<string, unknown> | null>;
    onSessionTerminated: (id: string) => void;
  };
  return { provider: m.launchSettingsProvider, onTerminated: m.onSessionTerminated };
}

const ENDPOINT = "http://127.0.0.1:4545/api/cli-agent/memory-recall";

describe("createCliAgentRuntime — chat recall wiring (RUFU-128)", () => {
  let projectRoot: string;
  let fusionDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  /**
   * Create the `<projectRoot>/.fusion` layout the production wiring passes
   * (fusionDir = the .fusion dir, projectRoot = its parent) — the P0
   * regression lives in which of the two reaches the recall backend.
   */
  function makeLayout(): void {
    projectRoot = mkdtempSync(join(tmpdir(), "cli-runtime-project-"));
    fusionDir = join(projectRoot, ".fusion");
    mkdirSync(fusionDir, { recursive: true });
  }

  async function buildRuntime(
    sessions: Map<string, CliSession>,
    extra?: {
      getSettings?: () => Promise<Partial<import("@fusion/core").Settings> | null | undefined>;
    },
  ) {
    makeLayout();
    const fake = fakeStore(sessions);
    vi.spyOn(CliSessionStore, "create").mockResolvedValue(fake);
    return createCliAgentRuntime({
      fusionDir,
      projectRoot,
      asyncLayer: { db: {} } as AsyncDataLayer,
      projectId: "project-a",
      hookEndpointUrl: "http://127.0.0.1:4545/api/cli-agent/hooks",
      recallEndpointUrl: ENDPOINT,
      ...extra,
    });
  }

  const scratchDirs = (root: string): string[] =>
    readdirSync(root)
      .filter((name) => name.startsWith(CHAT_RECALL_SCRATCH_PREFIX))
      .map((name) => join(root, name))
      .filter((p) => statSync(p).isDirectory());

  it("no recallEndpointUrl → no provider/terminate seams (bare legacy wiring)", async () => {
    makeLayout();
    const fake = fakeStore(new Map());
    vi.spyOn(CliSessionStore, "create").mockResolvedValue(fake);
    const runtime = await createCliAgentRuntime({
      fusionDir,
      asyncLayer: { db: {} } as AsyncDataLayer,
      projectId: "project-a",
      hookEndpointUrl: "http://127.0.0.1:4545/api/cli-agent/hooks",
    });
    const m = runtime.bundle.manager as unknown as {
      launchSettingsProvider?: unknown;
      onSessionTerminated?: unknown;
    };
    expect(m.launchSettingsProvider).toBeUndefined();
    expect(m.onSessionTerminated).toBeUndefined();
    // No scratch root created either.
    expect(existsSync(join(fusionDir, "tmp"))).toBe(false);
  });

  it("task-purpose session → provider null, no artifacts, terminate no-op", async () => {
    const sessions = new Map<string, CliSession>([
      ["s-task", makeRecord({ id: "s-task", purpose: "execute", taskId: "FN-001" })],
    ]);
    const runtime = await buildRuntime(sessions);
    const { provider, onTerminated } = managerSeams(runtime.bundle.manager);

    const extra = await provider("s-task");
    expect(extra).toBeNull();
    // No scratch dir was minted for the task session.
    expect(scratchDirs(join(fusionDir, "tmp"))).toEqual([]);
    // Terminate for an un-provisioned session is a full no-op (no throw).
    expect(() => onTerminated("s-task")).not.toThrow();
    expect(scratchDirs(join(fusionDir, "tmp"))).toEqual([]);
  });

  it("chat-purpose claude session → provider non-null, holder populated (token via live hub), finalize wrote 0o700 artifacts", async () => {
    const sessions = new Map<string, CliSession>([
      ["s-chat", makeRecord({ id: "s-chat", purpose: "chat" })],
    ]);
    const runtime = await buildRuntime(sessions);
    const { provider, onTerminated } = managerSeams(runtime.bundle.manager);

    const extra = await provider("s-chat");
    expect(extra).not.toBeNull();
    const settings = extra as {
      hookScripts: { memoryRecallScript: string };
      settingsPath: string;
    };

    // A null hub holder would have thrown "hub not available" in
    // launchSettingsFor — reaching here proves the holder was populated
    // after hub construction. Assert the token round-trips through the hub.
    const token = runtime.bundle.hub.issueToken("s-chat");
    expect(runtime.bundle.hub.hasSession("s-chat")).toBe(true);
    expect(runtime.bundle.hub.validateToken("s-chat", token)).toBe(true);

    // Finalize (called by the provider body) wrote both artifacts, 0o700.
    const scriptPath = settings.hookScripts.memoryRecallScript;
    expect(statSync(scriptPath).isFile()).toBe(true);
    expect(statSync(settings.settingsPath).isFile()).toBe(true);
    expect((statSync(scriptPath).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(settings.settingsPath).mode & 0o777).toString(8)).toBe("700");
    // The generated settings doc has exactly one UserPromptSubmit entry.
    // (Import lazily to avoid a cycle through the provisioner at module load.)
    const { readFileSync } = await import("node:fs");
    const doc = JSON.parse(readFileSync(settings.settingsPath, "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(Object.keys(doc.hooks)).toEqual(["UserPromptSubmit"]);
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toBe(scriptPath);

    // Terminate tears the scratch dir down and invalidates the token.
    onTerminated("s-chat");
    await vi.waitFor(() => {
      expect(scratchDirs(join(fusionDir, "tmp"))).toEqual([]);
    });
    expect(runtime.bundle.hub.validateToken("s-chat", token)).toBe(false);
  });

  it("getSettings gate: memoryPerTurnRecallEnabled=false → provider null (bare chat spawn)", async () => {
    const sessions = new Map<string, CliSession>([
      ["s-chat", makeRecord({ id: "s-chat", purpose: "chat" })],
    ]);
    const runtime = await buildRuntime(sessions, {
      getSettings: async () => ({ memoryPerTurnRecallEnabled: false }),
    });
    const extra = await managerSeams(runtime.bundle.manager).provider("s-chat");
    expect(extra).toBeNull();
    // Gated before any token issuance or artifact write.
    expect(scratchDirs(join(fusionDir, "tmp"))).toEqual([]);
    expect(runtime.bundle.hub.hasSession("s-chat")).toBe(false);

    // memoryEnabled=false gates the same way.
    const runtime2 = await buildRuntime(sessions, {
      getSettings: async () => ({ memoryEnabled: false }),
    });
    expect(await managerSeams(runtime2.bundle.manager).provider("s-chat")).toBeNull();
  });

  /*
  FNXC:CliChatRecall 2026-08-20-09:19:
  RUFU-128 P0 regression: the bundle's recallForChatTurn must resolve the memory
  backend against the PROJECT ROOT, not the .fusion dir. With fusionDir as
  rootDir the file backend searches <project>/.fusion/.fusion/memory (never
  exists) and Stash classifies the session under the wrong project
  discriminator — both a silent empty cue. A MEMORY.md seeded at the project
  root must produce a cue through the BUNDLE handle (the exact wiring the
  production runtime uses — the pre-fix unit/e2e harnesses called the thin
  service with the correct root directly, which is why the P0 survived them).
  */
  it("bundle recallForChatTurn resolves the memory backend against the project root (P0 regression)", async () => {
    const sessions = new Map<string, CliSession>([
      ["s-chat", makeRecord({ id: "s-chat", purpose: "chat" })],
    ]);
    makeLayout();
    // Seed project memory exactly where the file backend reads it.
    const memoryDir = join(fusionDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "zebraflame: the deploy script is pnpm deploy:prod\n");
    const fake = fakeStore(sessions);
    vi.spyOn(CliSessionStore, "create").mockResolvedValue(fake);
    const runtime = await createCliAgentRuntime({
      fusionDir,
      projectRoot,
      asyncLayer: { db: {} } as AsyncDataLayer,
      projectId: "project-a",
      hookEndpointUrl: "http://127.0.0.1:4545/api/cli-agent/hooks",
      recallEndpointUrl: ENDPOINT,
    });
    expect(runtime.bundle.memoryRecall).toBeDefined();
    const cue = await runtime.bundle.memoryRecall!.recallForChatTurn({
      topic: "what does zebraflame do",
      sessionId: "s-chat-p0-regression",
    });
    // An empty cue here == the P0 (backend resolved against the .fusion dir).
    // Non-empty + the seeded fact proves the project-root resolution.
    expect(cue).not.toBe("");
    expect(cue).toContain("pnpm deploy:prod");
  });

  /*
  FNXC:CliChatRecall 2026-08-20-09:19:
  RUFU-128 P0 guard: recall wiring without a project root must fail loud at
  construction rather than ship a silently broken (always-empty) recall path.
  */
  it("recallEndpointUrl without projectRoot → construction throws (fail loud, never silent no-op)", async () => {
    await expect(
      createCliAgentRuntime({
        fusionDir: "/tmp/fusion-cli-agent-test",
        asyncLayer: { db: {} } as AsyncDataLayer,
        projectId: "project-a",
        hookEndpointUrl: "http://127.0.0.1:4545/api/cli-agent/hooks",
        recallEndpointUrl: ENDPOINT,
      }),
    ).rejects.toThrow(/projectRoot is required/);
  });
});
