import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GLOBAL_STORAGE_KEYS,
  PROJECT_STORAGE_KEYS,
  getScopedItem,
  removeScopedItem,
  scopedKey,
  setScopedItem,
} from "../projectStorage";

describe("projectStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("scopedKey", () => {
    it("returns scoped key when projectId is provided", () => {
      expect(scopedKey("kb-dashboard-list-columns", "proj-abc")).toBe(
        "kb:proj-abc:kb-dashboard-list-columns",
      );
    });

    it("returns base key unchanged when projectId is undefined", () => {
      expect(scopedKey("kb-dashboard-list-columns", undefined)).toBe("kb-dashboard-list-columns");
    });

    it("returns base key unchanged when projectId is omitted", () => {
      expect(scopedKey("kb-dashboard-list-columns")).toBe("kb-dashboard-list-columns");
    });

    it("returns base key unchanged when projectId is empty", () => {
      expect(scopedKey("kb-dashboard-list-columns", "")).toBe("kb-dashboard-list-columns");
    });

    it("returns base key unchanged when projectId is null", () => {
      expect(scopedKey("kb-dashboard-list-columns", null as any)).toBe("kb-dashboard-list-columns");
    });
  });

  it("uses scoped keys for get/set/remove with projectId", () => {
    setScopedItem("kb-dashboard-list-columns", "value", "proj-abc");

    expect(localStorage.getItem("kb:proj-abc:kb-dashboard-list-columns")).toBe("value");
    expect(getScopedItem("kb-dashboard-list-columns", "proj-abc")).toBe("value");

    removeScopedItem("kb-dashboard-list-columns", "proj-abc");
    expect(localStorage.getItem("kb:proj-abc:kb-dashboard-list-columns")).toBeNull();
  });

  it("uses unscoped keys for get/set/remove without projectId", () => {
    setScopedItem("kb-dashboard-list-columns", "value");

    expect(localStorage.getItem("kb-dashboard-list-columns")).toBe("value");
    expect(getScopedItem("kb-dashboard-list-columns")).toBe("value");

    removeScopedItem("kb-dashboard-list-columns");
    expect(localStorage.getItem("kb-dashboard-list-columns")).toBeNull();
  });

  it("includes all global storage keys", () => {
    expect(GLOBAL_STORAGE_KEYS).toEqual(
      expect.arrayContaining([
        "kb-dashboard-theme-mode",
        "kb-dashboard-color-theme",
        "kb-dashboard-view-mode",
        "kb-dashboard-current-project",
        "kb-dashboard-recent-projects",
        "fn-agent-log-markdown",
        "fn-agent-log-tool-output",
      ]),
    );
    expect(GLOBAL_STORAGE_KEYS).toHaveLength(7);
  });

  it("includes all project-scoped storage keys", () => {
    expect(PROJECT_STORAGE_KEYS).toEqual(
      expect.arrayContaining([
        "kb-dashboard-task-view",
        "kb-dashboard-list-columns",
        "kb-dashboard-hide-done",
        "kb-dashboard-list-collapsed",
        "kb-dashboard-selected-tasks",
        "kb-dashboard-list-selected-task",
        "kb-dashboard-list-sidebar-width",
        "kb-dashboard-mailbox-sidebar-width",
        "kb-quick-entry-text",
        "kb-inline-create-text",
        "fn-agent-view",
        "kb-terminal-tabs",
        "kb-planning-last-description",
        "kb-subtask-last-description",
        "kb-mission-last-goal",
        "kb-usage-view-mode",
        "kb-usage-hidden-windows",
        "kb-usage-modal-size",
        "kb-usage-provider-order",
        "kb-chat-active-session",
        "kb-dashboard-working-branch-filter",
        "kb-dashboard-base-branch-filter",
        "kb-capacity-risk-banner-dismissed",
        "kb-files-line-numbers",
        "fusion-plugin-dependency-graph:positions",
      ]),
    );
    expect(PROJECT_STORAGE_KEYS).toHaveLength(25);
  });

  it("stores branch filter values as scoped strings per project", () => {
    setScopedItem("kb-dashboard-working-branch-filter", "feature/a", "proj-1");
    setScopedItem("kb-dashboard-base-branch-filter", "__fusion:no-branch__", "proj-1");
    setScopedItem("kb-dashboard-working-branch-filter", "feature/b", "proj-2");

    expect(getScopedItem("kb-dashboard-working-branch-filter", "proj-1")).toBe("feature/a");
    expect(getScopedItem("kb-dashboard-base-branch-filter", "proj-1")).toBe("__fusion:no-branch__");
    expect(getScopedItem("kb-dashboard-working-branch-filter", "proj-2")).toBe("feature/b");
    expect(getScopedItem("kb-dashboard-working-branch-filter", "proj-3")).toBeNull();
  });

  it("getScopedItem returns null when localStorage.getItem is unavailable", () => {
    vi.stubGlobal("window", { localStorage: {} });
    expect(getScopedItem("kb-dashboard-list-columns", "proj-abc")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("setScopedItem is a no-op when localStorage.setItem is unavailable", () => {
    vi.stubGlobal("window", { localStorage: {} });
    expect(() => setScopedItem("kb-dashboard-list-columns", "value", "proj-abc")).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("removeScopedItem is a no-op when localStorage.removeItem is unavailable", () => {
    vi.stubGlobal("window", { localStorage: {} });
    expect(() => removeScopedItem("kb-dashboard-list-columns", "proj-abc")).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("has no overlap between global and project-scoped keys", () => {
    const globalSet = new Set(GLOBAL_STORAGE_KEYS);
    const overlap = PROJECT_STORAGE_KEYS.filter((key) => globalSet.has(key));

    expect(overlap).toEqual([]);
  });
});
