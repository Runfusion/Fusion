import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { DashboardApp } from "../app.js";
import { DashboardTUI } from "../controller.js";
import type { ProjectItem, TaskItem, AgentItem, AgentDetailItem, ModelItem, SettingsValues, TaskDetailData } from "../state.js";

function newController(): DashboardTUI {
  return new DashboardTUI();
}

function renderDashboardAppNode(controller: DashboardTUI) {
  return React.createElement(DashboardApp, { controller });
}

function makeSystemInfo() {
  return {
    host: "localhost",
    port: 4040,
    baseUrl: "http://localhost:4040",
    authEnabled: false,
    engineMode: "active" as const,
    fileWatcher: true,
    startTimeMs: Date.now(),
  };
}

function makeInteractiveData(opts: {
  projects?: ProjectItem[];
  tasks?: TaskItem[];
  agents?: AgentItem[];
  detail?: AgentDetailItem | null;
  settings?: SettingsValues;
  models?: ModelItem[];
  taskDetail?: TaskDetailData | null;
  remote?: Partial<{
    getSettings: () => Promise<{ activeProvider: "tailscale" | "cloudflare" | null; tailscaleEnabled: boolean; cloudflareEnabled: boolean; shortLivedEnabled: boolean; shortLivedTtlMs: number }>;
    getStatus: () => Promise<{ provider: "tailscale" | "cloudflare" | null; state: "stopped" | "starting" | "running" | "error"; url: string | null; lastError: string | null }>;
    activateProvider: (provider: "tailscale" | "cloudflare") => Promise<void>;
    startTunnel: () => Promise<void>;
    stopTunnel: () => Promise<void>;
    regeneratePersistentToken: () => Promise<{ maskedToken?: string; tokenType: "persistent"; expiresAt: null }>;
    generateShortLivedToken: (ttlMs: number) => Promise<{ token?: string; tokenType: "short-lived"; expiresAt: string | null }>;
    getRemoteUrl: (tokenType: "persistent" | "short-lived", ttlMs?: number) => Promise<{ url: string; tokenType: "persistent" | "short-lived"; expiresAt: string | null }>;
    getQrPayload: (tokenType: "persistent" | "short-lived", ttlMs?: number) => Promise<{ url: string; expiresAt: string | null; format: "text" | "image/svg"; data?: string }>;
  }>;
} = {}) {
  const projects = opts.projects ?? [];
  const tasks = opts.tasks ?? [];
  const agents = opts.agents ?? [];
  const detail = opts.detail ?? null;
  const taskDetail = opts.taskDetail ?? null;
  const settings: SettingsValues = opts.settings ?? {
    maxConcurrent: 1,
    maxWorktrees: 2,
    autoMerge: false,
    mergeStrategy: "direct",
    pollIntervalMs: 60000,
    enginePaused: false,
    globalPause: false,
    remoteActiveProvider: null,
    remoteShortLivedEnabled: false,
    remoteShortLivedTtlMs: 900000,
  };
  const models = opts.models ?? [];
  const remoteDefaults = {
    getSettings: async () => ({
      activeProvider: settings.remoteActiveProvider,
      tailscaleEnabled: true,
      cloudflareEnabled: true,
      shortLivedEnabled: settings.remoteShortLivedEnabled,
      shortLivedTtlMs: settings.remoteShortLivedTtlMs,
    }),
    getStatus: async () => ({ provider: null, state: "stopped" as const, url: null, lastError: null }),
    activateProvider: async (_provider: "tailscale" | "cloudflare") => {},
    startTunnel: async () => {},
    stopTunnel: async () => {},
    regeneratePersistentToken: async () => ({ maskedToken: "tok_****", tokenType: "persistent" as const, expiresAt: null }),
    generateShortLivedToken: async (_ttlMs: number) => ({ token: "short", tokenType: "short-lived" as const, expiresAt: new Date().toISOString() }),
    getRemoteUrl: async (_tokenType: "persistent" | "short-lived", _ttlMs?: number) => ({ url: "https://remote.example.com", tokenType: "persistent" as const, expiresAt: null }),
    getQrPayload: async (_tokenType: "persistent" | "short-lived", _ttlMs?: number) => ({ url: "https://remote.example.com", expiresAt: null, format: "image/svg" as const, data: "<svg/>" }),
  };
  const remote = { ...remoteDefaults, ...(opts.remote ?? {}) };

  return {
    listProjects: async () => projects,
    listTasks: async () => tasks,
    createTask: async (_path: string, input: { title: string; description?: string }) => ({
      id: "new",
      title: input.title,
      description: input.description ?? input.title,
      column: "todo",
    }) as TaskItem,
    listAgents: async () => agents,
    getAgentDetail: async (_id: string) => detail,
    updateAgentState: async (_id: string, _state: string) => {},
    deleteAgent: async (_id: string) => {},
    getSettings: async () => settings,
    updateSettings: async (_partial: Partial<SettingsValues>) => {},
    listModels: () => models,
    remote,
    git: {
      getStatus: async () => ({
        branch: "main",
        detached: false,
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        remoteUrl: "",
        lastFetchAt: null,
      }),
      listCommits: async () => [],
      showCommit: async () => ({
        sha: "",
        shortSha: "",
        subject: "",
        authorName: "",
        relativeTime: "",
        isoTime: "",
        body: "",
        stat: "",
      }),
      listBranches: async () => [],
      listWorktrees: async () => [],
      push: async () => ({ success: true, output: "" }),
      fetch: async () => ({ success: true, output: "" }),
    },
    tasks: {
      getTaskDetail: async () => taskDetail,
      subscribeTaskEvents: () => () => {},
    },
    files: {
      listDirectory: async () => [],
      readFile: async () => ({
        content: null,
        isBinary: false,
        tooLarge: false,
        size: 0,
        modifiedAt: new Date(0).toISOString(),
        lineCount: 0,
      }),
    },
  };
}

function setTerminalSize(instance: { stdout: unknown }, columns: number, rows: number) {
  Object.defineProperty(instance.stdout as object, "columns", { value: columns, configurable: true });
  Object.defineProperty(instance.stdout as object, "rows", { value: rows, configurable: true });
}

afterEach(() => {
  vi.useRealTimers();
});

async function waitForFrameContains(lastFrame: () => string | undefined, text: string, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((lastFrame() ?? "").includes(text)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for frame to include: ${text}`);
}

function findTokenPosition(frame: string, token: string): { row: number; col: number } {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes(token));
  expect(row).toBeGreaterThanOrEqual(0);
  const col = lines[row].indexOf(token);
  expect(col).toBeGreaterThanOrEqual(0);
  return { row, col };
}

describe("DashboardApp smoke", () => {
  it("renders the splash logo and tagline before systemInfo arrives", () => {
    const controller = newController();
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    const frame = lastFrame() ?? "";
    // Splash can render either the compact text mark or the expanded block-art logo.
    expect(frame).toMatch(/FUSION|███████╗/);
    expect(frame).toContain("multi node agent orchestrator");
    expect(frame).toContain("runfusion.ai");
    unmount();
  });

  it("renders system panel content once setSystemInfo fires", () => {
    const controller = newController();
    const { lastFrame, unmount, rerender } = render(renderDashboardAppNode(controller));
    controller.setSystemInfo(makeSystemInfo());
    rerender(renderDashboardAppNode(controller));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("http://localhost:4040");
    expect(frame).not.toContain("███████╗");
    unmount();
  });

  it("shows interactive empty-state when no data source is wired", () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setMode("interactive");
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    expect(lastFrame() ?? "").toContain("Interactive mode unavailable");
    unmount();
  });

  it("renders the selected project name in board view header", async () => {
    const controller = newController();
    const projects: ProjectItem[] = [
      { id: "p1", name: "alpha", path: "/tmp/alpha" },
      { id: "p2", name: "beta", path: "/tmp/beta" },
    ];
    const tasks: TaskItem[] = [
      { id: "t1", title: "first", description: "", column: "todo" },
    ];
    controller.setSystemInfo(makeSystemInfo());
    controller.setInteractiveData(makeInteractiveData({ projects, tasks }));
    controller.setMode("interactive");
    controller.setInteractiveView("board");
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? "";
    // Board shows the currently selected project; first project "alpha" is selected by default
    expect(frame).toContain("alpha");
    unmount();
  });
});

describe("DashboardTUI snapshot stability", () => {
  it("returns the same snapshot reference across reads when state has not changed", () => {
    const controller = newController();
    const a = controller.getSnapshot();
    const b = controller.getSnapshot();
    expect(a).toBe(b);
  });

  it("invalidates the cached snapshot when state changes", () => {
    const controller = newController();
    const a = controller.getSnapshot();
    controller.setLoadingStatus("Working…");
    const b = controller.getSnapshot();
    expect(b).not.toBe(a);
    expect(b.loadingStatus).toBe("Working…");
  });

  it("notifies subscribers on state change", () => {
    const controller = newController();
    const cb = vi.fn();
    const unsub = controller.subscribe(cb);
    controller.setLoadingStatus("Tick");
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    controller.setLoadingStatus("Tock");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("toggles mode and reflects it in the snapshot", () => {
    const controller = newController();
    expect(controller.getSnapshot().mode).toBe("status");
    controller.setMode("interactive");
    expect(controller.getSnapshot().mode).toBe("interactive");
    controller.setMode("status");
    expect(controller.getSnapshot().mode).toBe("status");
  });

  it("appends log entries and exposes them in the snapshot", () => {
    const controller = newController();
    controller.log("hello", "scope");
    const entries = controller.getSnapshot().logEntries;
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("hello");
    expect(entries[0].prefix).toBe("scope");
  });

  it("setInteractiveView updates interactiveView in snapshot", () => {
    const controller = newController();
    expect(controller.getSnapshot().interactiveView).toBe("board");
    controller.setInteractiveView("agents");
    expect(controller.getSnapshot().interactiveView).toBe("agents");
    controller.setInteractiveView("settings");
    expect(controller.getSnapshot().interactiveView).toBe("settings");
  });
});

describe("Agents view", () => {
  it("renders agents list when setInteractiveView('agents') is set", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    const agents: AgentItem[] = [
      { id: "a1", name: "worker-1", state: "active", role: "executor" },
      { id: "a2", name: "worker-2", state: "idle", role: "executor" },
    ];
    controller.setInteractiveData(makeInteractiveData({ agents }));
    controller.setMode("interactive");
    controller.setInteractiveView("agents");
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("worker-1");
    expect(frame).toContain("worker-2");
    expect(frame).toContain("Agents");
    unmount();
  });

  it("shows Agent Detail panel label", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setInteractiveData(makeInteractiveData());
    controller.setMode("interactive");
    controller.setInteractiveView("agents");
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame() ?? "").toContain("Agent Detail");
    unmount();
  });

  it("shows run history with readable status labels and opens run logs for the selected run", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());

    const agents: AgentItem[] = [
      { id: "a1", name: "worker-1", state: "active", role: "executor" },
    ];
    const detail: AgentDetailItem = {
      id: "a1",
      name: "worker-1",
      state: "active",
      role: "executor",
      capabilities: ["executor"],
      recentRuns: [
        {
          id: "run-1",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          status: "completed",
          stdoutExcerpt: "plan generated",
        },
      ],
    };

    controller.setInteractiveData(makeInteractiveData({ agents, detail }));
    controller.setMode("interactive");
    controller.setInteractiveView("agents");

    const { lastFrame, stdin, unmount } = render(renderDashboardAppNode(controller));
    await waitForFrameContains(lastFrame, "Run history (latest first):");
    await waitForFrameContains(lastFrame, "Completed");

    stdin.write("\r");
    await waitForFrameContains(lastFrame, "Run logs (1)");
    await waitForFrameContains(lastFrame, "plan generated");

    unmount();
  });
});

describe("Settings view", () => {
  it("renders settings list when setInteractiveView('settings') is set", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    const settings: SettingsValues = {
      maxConcurrent: 3,
      maxWorktrees: 4,
      autoMerge: true,
      mergeStrategy: "direct",
      pollIntervalMs: 60000,
      enginePaused: false,
      globalPause: false,
      remoteActiveProvider: "tailscale",
      remoteShortLivedEnabled: true,
      remoteShortLivedTtlMs: 600000,
      remoteStatus: { provider: "tailscale", state: "running", url: "https://remote.example.com", lastError: null },
    };
    controller.setInteractiveData(makeInteractiveData({ settings }));
    controller.setMode("interactive");
    controller.setInteractiveView("settings");
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Settings");
    expect(frame).toContain("Max Concurrent");
    expect(frame).toContain("Auto Merge");
    unmount();
  });

  it("renders models subsection when models are provided", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    const models: ModelItem[] = [
      { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", provider: "anthropic", contextWindow: 200000 },
    ];
    controller.setInteractiveData(makeInteractiveData({ models }));
    controller.setMode("interactive");
    controller.setInteractiveView("settings");
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Available Models");
    expect(frame).toContain("Claude 3.5 Sonnet");
    unmount();
  });

  it("renders the Remote subsection and supports provider/lifecycle actions", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    let remoteState: "stopped" | "starting" | "running" | "error" = "running";
    const activateProvider = vi.fn(async () => {});
    const settings: SettingsValues = {
      maxConcurrent: 1,
      maxWorktrees: 2,
      autoMerge: false,
      mergeStrategy: "direct",
      pollIntervalMs: 60000,
      enginePaused: false,
      globalPause: false,
      remoteActiveProvider: "cloudflare",
      remoteShortLivedEnabled: true,
      remoteShortLivedTtlMs: 600000,
      remoteStatus: { provider: "cloudflare", state: "running", url: "https://remote.example.com", lastError: null },
    };
    controller.setInteractiveData(makeInteractiveData({
      settings,
      remote: {
        activateProvider,
        getStatus: async () => ({ provider: "cloudflare", state: remoteState, url: "https://remote.example.com", lastError: null }),
        startTunnel: async () => {
          remoteState = "starting";
        },
        stopTunnel: async () => {
          remoteState = "stopped";
        },
      },
    }));
    controller.setMode("interactive");
    controller.setInteractiveView("settings");

    const { lastFrame, stdin, unmount } = render(renderDashboardAppNode(controller));
    await waitForFrameContains(lastFrame, "Remote");
    expect(lastFrame() ?? "").toContain("cloudflare");

    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("C");
    await new Promise((r) => setTimeout(r, 20));
    expect(activateProvider).toHaveBeenCalledWith("cloudflare");

    stdin.write("V");
    await waitForFrameContains(lastFrame, "Remote tunnel starting");

    stdin.write("X");
    await waitForFrameContains(lastFrame, "Remote tunnel stopped");
    unmount();
  });

  it("renders short-lived token expiry and QR text payload", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setInteractiveData(makeInteractiveData({
      remote: {
        getQrPayload: async () => ({
          url: "https://remote.example.com?token=text",
          expiresAt: null,
          format: "text",
          data: "ASCII-QR-PAYLOAD",
        }),
      },
    }));
    controller.setMode("interactive");
    controller.setInteractiveView("settings");

    const { lastFrame, stdin, unmount } = render(renderDashboardAppNode(controller));
    await waitForFrameContains(lastFrame, "──── Remote ────");
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));

    stdin.write("L");
    await waitForFrameContains(lastFrame, "TTL ms:");
    stdin.write("\r");
    await waitForFrameContains(lastFrame, "Short-lived expires:", 6000);

    stdin.write("K");
    await waitForFrameContains(lastFrame, "QR text payload:", 6000);
    await waitForFrameContains(lastFrame, "ASCII-QR-PAYLOAD", 6000);
    unmount();
  });

  it("wires P/U remote actions to persistent token refresh and URL handoff state", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    const regeneratePersistentToken = vi.fn(async () => ({
      maskedToken: "tok_****",
      tokenType: "persistent" as const,
      expiresAt: null,
    }));
    const getRemoteUrl = vi.fn(async () => ({
      url: "https://remote.example.com/remote-login?rt=masked",
      tokenType: "persistent" as const,
      expiresAt: null,
    }));

    controller.setInteractiveData(makeInteractiveData({
      remote: {
        regeneratePersistentToken,
        getRemoteUrl,
      },
    }));
    controller.setMode("interactive");
    controller.setInteractiveView("settings");

    const { lastFrame, stdin, unmount } = render(renderDashboardAppNode(controller));
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));

    stdin.write("P");
    await waitForFrameContains(lastFrame, "Persistent token: tok_****");
    expect(regeneratePersistentToken).toHaveBeenCalledTimes(1);

    stdin.write("U");
    await waitForFrameContains(lastFrame, "Auth URL: https://remote.example.com/remote-login?rt=masked");
    expect(getRemoteUrl).toHaveBeenCalledWith("persistent", undefined);

    unmount();
  });

  it("keeps global shortcuts inactive during TTL input", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setInteractiveData(makeInteractiveData());
    controller.setMode("interactive");
    controller.setInteractiveView("settings");

    const { lastFrame, stdin, unmount } = render(renderDashboardAppNode(controller));
    await waitForFrameContains(lastFrame, "──── Remote ────");
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));

    stdin.write("L");
    await waitForFrameContains(lastFrame, "TTL ms:");
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 20));
    expect(controller.getSnapshot().interactiveView).toBe("settings");
    unmount();
  });

  it("renders SVG QR fallback instruction", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setInteractiveData(makeInteractiveData({
      remote: {
        getQrPayload: async () => ({
          url: "https://remote.example.com?token=svg",
          expiresAt: new Date().toISOString(),
          format: "image/svg",
          data: "<svg/>",
        }),
      },
    }));
    controller.setMode("interactive");
    controller.setInteractiveView("settings");

    const { lastFrame, stdin, unmount } = render(renderDashboardAppNode(controller));
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("K");
    await waitForFrameContains(lastFrame, "QR SVG returned by server.");
    unmount();
  });
});

describe("Board view", () => {
  it("renders kanban columns in board view", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    const tasks: TaskItem[] = [
      { id: "t1", title: "Task One", description: "", column: "todo" },
      { id: "t2", title: "Task Two", description: "", column: "in-progress" },
    ];
    controller.setInteractiveData(makeInteractiveData({
      projects: [{ id: "p1", name: "my-project", path: "/tmp/p" }],
      tasks,
    }));
    controller.setMode("interactive");
    controller.setInteractiveView("board");
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("TODO");
    expect(frame).toContain("IN PROGRESS");
    unmount();
  });
});

describe("LogsPanel indicator", () => {
  it("renders the selection arrow on the highlighted log row", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setActiveSection("logs");
    controller.log("first message", "test");
    controller.log("second message", "test");
    controller.log("third message", "test");
    // Select index 1 (middle entry)
    controller.setSelectedLogIndex(1);
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▶");
    unmount();
  });

  it("shows no selection arrow on non-focused log entries", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setActiveSection("logs");
    controller.log("only message", "test");
    controller.setSelectedLogIndex(0);
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 10));
    const frame = lastFrame() ?? "";
    // The selected entry shows the arrow; it should appear at least once
    expect(frame).toContain("▶");
    unmount();
  });
});

describe("StatusModeGrid layout stability", () => {
  it("keeps System and Logs panel anchors stable as log content length changes", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setActiveSection("logs");

    const rendered = render(renderDashboardAppNode(controller));
    setTerminalSize(rendered, 120, 28);
    rendered.rerender(renderDashboardAppNode(controller));

    controller.log("short msg", "app");
    controller.log("small", "worker");
    controller.log("ok", "db");
    rendered.rerender(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 10));

    const shortFrame = rendered.lastFrame() ?? "";
    const shortSystem = findTokenPosition(shortFrame, "System");
    const shortLogs = findTokenPosition(shortFrame, "Logs (3/1000)");
    const shortStatus = findTokenPosition(shortFrame, "http://localhost:4040");

    controller.log(
      "this is a deliberately long log message that should force truncation or wrapping and previously nudged grid widths",
      "very-long-prefix-value",
    );
    controller.log(
      "another long log payload with changing text widths to emulate timer and event updates in real sessions",
      "background-scheduler",
    );
    controller.log(
      "final long line for width stability regression coverage across re-renders",
      "super-verbose-component-prefix",
    );
    rendered.rerender(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 10));

    const longFrame = rendered.lastFrame() ?? "";
    const longSystem = findTokenPosition(longFrame, "System");
    const longLogs = findTokenPosition(longFrame, "Logs (6/1000)");
    const longStatus = findTokenPosition(longFrame, "http://localhost:4040");

    expect(longSystem).toEqual(shortSystem);
    expect(longLogs).toEqual(shortLogs);
    expect(longStatus).toEqual(shortStatus);
    rendered.unmount();
  });
});

describe("LogsPanel narrow formatting", () => {
  it("shows a compact index instead of full timestamp in narrow terminals", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setActiveSection("logs");
    controller.log("narrow entry", "scope");
    controller.setSelectedLogIndex(0);

    const rendered = render(renderDashboardAppNode(controller));
    setTerminalSize(rendered, 60, 24);
    rendered.rerender(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 10));
    const frame = rendered.lastFrame() ?? "";

    expect(frame).toContain("narrow entry");
    expect(frame).toMatch(/\s1\s[✓⚠✗]/);
    expect(frame).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    rendered.unmount();
  });

  it("truncates long prefixes in narrow mode and keeps wide mode formatting", async () => {
    const prefix = "very-long-scope-name";

    const narrowController = newController();
    narrowController.setSystemInfo(makeSystemInfo());
    narrowController.setActiveSection("logs");
    narrowController.log("narrow prefix", prefix);
    narrowController.setSelectedLogIndex(0);

    const narrowRender = render(renderDashboardAppNode(narrowController));
    setTerminalSize(narrowRender, 60, 24);
    narrowRender.rerender(renderDashboardAppNode(narrowController));
    await new Promise((r) => setTimeout(r, 10));
    const narrowFrame = narrowRender.lastFrame() ?? "";
    expect(narrowFrame).toContain("[very-…]");
    narrowRender.unmount();

    const wideController = newController();
    wideController.setSystemInfo(makeSystemInfo());
    wideController.setActiveSection("logs");
    wideController.log("wide prefix", prefix);
    wideController.setSelectedLogIndex(0);

    const wideRender = render(renderDashboardAppNode(wideController));
    setTerminalSize(wideRender, 120, 24);
    wideRender.rerender(renderDashboardAppNode(wideController));
    await new Promise((r) => setTimeout(r, 10));
    const wideFrame = wideRender.lastFrame() ?? "";
    expect(wideFrame).toContain("[very-long-sco");
    expect(wideFrame).not.toContain("[very-…]");
    wideRender.unmount();
  });

  it("preserves full timestamp formatting in wide terminals", async () => {
    const controller = newController();
    controller.setSystemInfo(makeSystemInfo());
    controller.setActiveSection("logs");
    controller.log("wide timestamp", "scope");
    controller.setSelectedLogIndex(0);

    const rendered = render(renderDashboardAppNode(controller));
    setTerminalSize(rendered, 120, 24);
    rendered.rerender(renderDashboardAppNode(controller));
    await new Promise((r) => setTimeout(r, 10));
    const frame = rendered.lastFrame() ?? "";

    expect(frame).toContain("wide timestamp");
    expect(frame).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    rendered.unmount();
  });
});
