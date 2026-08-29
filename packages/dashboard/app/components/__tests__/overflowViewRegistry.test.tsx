import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getVisibleOverflowViewEntries, STATIC_OVERFLOW_VIEW_ENTRIES } from "../overflowViewRegistry";
import type { PluginDashboardViewEntry } from "../../api";
import { NATIVE_STRUCTURE_DRAG_MIME } from "../../utils/nativeStructureDrag";

const { receivedPluginContexts } = vi.hoisted(() => ({
  receivedPluginContexts: [] as Array<{ beginNativeStructureDrag?: (dataTransfer: DataTransfer, ref: { kind: "roadmap-item"; id: string; projectId?: string }) => boolean }>,
}));

vi.mock("../../plugins/PluginDashboardViewHost", () => ({
  PluginDashboardViewHost: ({ context }: { context: (typeof receivedPluginContexts)[number] }) => {
    receivedPluginContexts.push(context);
    return null;
  },
}));

describe("overflowViewRegistry", () => {
  it("exposes static right-dock tools in order", () => {
    const entries = getVisibleOverflowViewEntries({ experimentalFeatures: { devServerView: true } });
    const keys = entries.map((entry) => entry.key);

    expect(keys).toEqual([
      "tasks", "files", "chat", "activity-log", "git-manager", "devserver", "secrets", "pull-requests",
    ]);
    expect(entries.filter((entry) => entry.render).map((entry) => entry.key)).toEqual(keys);
    expect(entries.filter((entry) => entry.onActivate)).toEqual([]);
  });

  it("hides flag-gated static dock tools", () => {
    const keys = getVisibleOverflowViewEntries().map((entry) => entry.key);
    expect(keys).toEqual(["tasks", "files", "chat", "activity-log", "git-manager", "secrets", "pull-requests"]);
    expect(keys).not.toContain("devserver");
    expect(keys).not.toContain("todos");
    expect(keys).not.toContain("usage");
  });

  it("does not expose left-sidebar content views or removed dock tools in the registry", () => {
    const removedKeys = ["documents", "research", "insights", "skills", "memory", "stash-recovery", "evals", "goalsView", "github-import", "automation", "usage", "todos"];
    const keys = getVisibleOverflowViewEntries({
      experimentalFeatures: { insights: true, memoryView: true, devServerView: true, researchView: true, evalsView: true, goalsView: true },
      showSkillsTab: true,
    }).map((entry) => entry.key);

    expect(keys).toEqual(STATIC_OVERFLOW_VIEW_ENTRIES.map((entry) => entry.key));
    for (const key of removedKeys) expect(keys).not.toContain(key);
    for (const key of ["secrets", "pull-requests", "devserver"]) expect(keys).toContain(key);
  });

  it("adds enabled non-primary plugin views after static tool entries", () => {
    const pluginDashboardViews: PluginDashboardViewEntry[] = [
      { pluginId: "fusion-plugin-todos", view: { viewId: "todos", label: "Todos", placement: "overflow", order: 70 } },
      { pluginId: "plugin-a", view: { viewId: "primary", label: "Primary", placement: "primary" } },
      { pluginId: "plugin-a", view: { viewId: "tools", label: "Tools", placement: "overflow", order: 2 } },
      { pluginId: "plugin-b", view: { viewId: "audit", label: "Audit", placement: "secondary", order: 1 } },
    ];

    const entries = getVisibleOverflowViewEntries({ experimentalFeatures: { devServerView: true }, pluginDashboardViews });
    expect(entries.map((entry) => entry.key)).toEqual([
      "tasks", "files", "chat", "activity-log", "git-manager", "devserver", "secrets", "pull-requests",
      "plugin:plugin-b:audit", "plugin:plugin-a:tools", "plugin:fusion-plugin-todos:todos",
    ]);
    expect(entries.some((entry) => entry.key === "plugin:plugin-a:primary")).toBe(false);
  });

  it("excludes the dependency-graph plugin from the right dock", () => {
    const pluginDashboardViews: PluginDashboardViewEntry[] = [
      { pluginId: "fusion-plugin-dependency-graph", view: { viewId: "graph", label: "Dependency Graph", placement: "overflow", order: 1 } },
      { pluginId: "plugin-c", view: { viewId: "report", label: "Report", placement: "overflow", order: 2 } },
    ];

    const keys = getVisibleOverflowViewEntries({ pluginDashboardViews }).map((entry) => entry.key);
    expect(keys).not.toContain("plugin:fusion-plugin-dependency-graph:graph");
    expect(keys).toContain("plugin:plugin-c:report");
  });

  it("injects the native-structure drag hook into a prebuilt right-dock plugin context", () => {
    receivedPluginContexts.length = 0;
    const entry = getVisibleOverflowViewEntries({
      pluginDashboardViews: [{ pluginId: "fusion-plugin-roadmap", view: { viewId: "roadmaps", label: "Roadmaps", placement: "overflow" } }],
    }).find((candidate) => candidate.key === "plugin:fusion-plugin-roadmap:roadmaps");
    expect(entry?.render).toBeTypeOf("function");

    render(<>{entry?.render?.({
      projectId: "project-1",
      addToast: vi.fn(),
      pluginContext: {
        projectId: "project-1",
        tasks: [],
        workflowSteps: [],
        openTaskDetail: vi.fn(),
        openFile: vi.fn(),
      },
    })}</>);

    const beginNativeStructureDrag = receivedPluginContexts.at(-1)?.beginNativeStructureDrag;
    expect(beginNativeStructureDrag).toBeTypeOf("function");
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "move",
      setData: (type: string, value: string) => values.set(type, value),
      getData: (type: string) => values.get(type) ?? "",
    } as unknown as DataTransfer;

    expect(beginNativeStructureDrag?.(dataTransfer, { kind: "roadmap-item", id: "RF-1", projectId: "project-1" })).toBe(true);
    expect(dataTransfer.getData(NATIVE_STRUCTURE_DRAG_MIME)).toBe(JSON.stringify({ kind: "roadmap-item", id: "RF-1", projectId: "project-1" }));
  });

  it("keeps right-dock plugin drag payloads inert on coarse pointers", () => {
    receivedPluginContexts.length = 0;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const entry = getVisibleOverflowViewEntries({
      pluginDashboardViews: [{ pluginId: "fusion-plugin-roadmap", view: { viewId: "roadmaps", label: "Roadmaps", placement: "overflow" } }],
    }).find((candidate) => candidate.key === "plugin:fusion-plugin-roadmap:roadmaps");

    render(<>{entry?.render?.({ projectId: "project-1", addToast: vi.fn() })}</>);
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "move",
      setData: (type: string, value: string) => values.set(type, value),
      getData: (type: string) => values.get(type) ?? "",
    } as unknown as DataTransfer;

    expect(receivedPluginContexts.at(-1)?.beginNativeStructureDrag?.(dataTransfer, { kind: "roadmap-item", id: "RF-1" })).toBe(false);
    expect(values.size).toBe(0);
    expect(dataTransfer.effectAllowed).toBe("move");
    vi.unstubAllGlobals();
  });
});
