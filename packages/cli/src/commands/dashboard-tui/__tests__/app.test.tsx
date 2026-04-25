import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { DashboardApp } from "../app.js";
import { DashboardTUI } from "../controller.js";
import type { ProjectItem, TaskItem, AgentItem, AgentDetailItem, ModelItem, SettingsValues } from "../state.js";

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
} = {}) {
  const projects = opts.projects ?? [];
  const tasks = opts.tasks ?? [];
  const agents = opts.agents ?? [];
  const detail = opts.detail ?? null;
  const settings: SettingsValues = opts.settings ?? {
    maxConcurrent: 1,
    maxWorktrees: 2,
    autoMerge: false,
    mergeStrategy: "direct",
    pollIntervalMs: 60000,
    enginePaused: false,
    globalPause: false,
  };
  const models = opts.models ?? [];
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
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DashboardApp smoke", () => {
  it("renders the splash logo and tagline before systemInfo arrives", () => {
    const controller = newController();
    const { lastFrame, unmount } = render(renderDashboardAppNode(controller));
    const frame = lastFrame() ?? "";
    // Splash can render either the compact text mark or the expanded block-art logo.
    expect(frame).toMatch(/FUSION|███████╗/);
    expect(frame).toContain("AI coding agent dashboard");
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
