import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GLOBAL_STORAGE_KEYS,
  MAX_PERSISTED_DRAFT_BYTES,
  PROJECT_STORAGE_KEYS,
  VOLATILE_DRAFT_STORAGE_KEYS,
  getScopedItem,
  removeScopedItem,
  scopedKey,
  setScopedItem,
} from "../projectStorage";

describe("projectStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
        "kb-dashboard-todo-hide-done",
        "kb-dashboard-list-collapsed",
        "kb-dashboard-selected-tasks",
        "kb-dashboard-list-selected-task",
        "kb-dashboard-list-sidebar-width",
        "kb-dashboard-mailbox-sidebar-width",
        "kb-dashboard-agents-sidebar-width",
        "kb-dashboard-github-import-list-width",
        "kb-dashboard-github-import-state",
        "kb-quick-entry-text",
        "kb-inline-create-text",
        "fn-agent-view",
        "kb-terminal-tabs",
        "kb-planning-last-description",
        "kb-planning-active-session",
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
        "kb-github-setup-warning-missing-since",
        "kb-files-line-numbers",
        "kb-dashboard-dock-files-current",
        "kb-dashboard-board-workflow-selection",
        "fusion-plugin-dependency-graph:positions",
      ]),
    );
    /*
    FNXC:ProjectStorage 2026-07-14-19:20:
    Keep PROJECT_STORAGE_KEYS length lockstep with the source array (todo hide-done, github import state, github setup warning dismissals).
    */
    expect(PROJECT_STORAGE_KEYS).toHaveLength(33);
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

  it("returns false when localStorage.setItem is unavailable", () => {
    vi.stubGlobal("window", { localStorage: {} });
    expect(setScopedItem("kb-dashboard-list-columns", "value", "proj-abc")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("evicts an over-cap draft instead of persisting it", () => {
    const key = scopedKey("kb-quick-entry-text", "proj-abc");
    localStorage.setItem(key, "previous draft");

    expect(setScopedItem("kb-quick-entry-text", "x".repeat(MAX_PERSISTED_DRAFT_BYTES + 1), "proj-abc", {
      maxBytes: MAX_PERSISTED_DRAFT_BYTES,
    })).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("persists a draft exactly at its byte cap", () => {
    const value = "x".repeat(MAX_PERSISTED_DRAFT_BYTES);
    expect(setScopedItem("kb-quick-entry-text", value, "proj-abc", {
      maxBytes: MAX_PERSISTED_DRAFT_BYTES,
    })).toBe(true);
    expect(getScopedItem("kb-quick-entry-text", "proj-abc")).toBe(value);
  });

  it("evicts the same key and retries after an initial quota failure", () => {
    const key = scopedKey("kb-quick-entry-text", "proj-abc");
    const nativeSetItem = localStorage.setItem.bind(localStorage);
    const setItem = vi.spyOn(localStorage, "setItem")
      .mockImplementationOnce(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); })
      .mockImplementation((nextKey, value) => nativeSetItem(nextKey, value));

    expect(setScopedItem("kb-quick-entry-text", "draft", "proj-abc")).toBe(true);
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(key)).toBe("draft");
  });

  it("reclaims other-project volatile drafts and stale SWR entries before a final retry", () => {
    const nativeSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem(scopedKey("kb-quick-entry-text", "other-project"), "old draft");
    localStorage.setItem(scopedKey("kb-inline-create-text", "other-project"), "old inline draft");
    localStorage.setItem(scopedKey("kb-quick-entry-text", "keep-project"), "keep draft");
    localStorage.setItem(scopedKey("kb-dashboard-list-columns", "other-project"), "keep preference");
    localStorage.setItem("kb-dashboard-tasks-cache:old", JSON.stringify({ savedAt: 0, data: [] }));
    const setItem = vi.spyOn(localStorage, "setItem")
      .mockImplementationOnce(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); })
      .mockImplementationOnce(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); })
      .mockImplementation((key, value) => nativeSetItem(key, value));

    expect(setScopedItem("kb-quick-entry-text", "fresh", "keep-project")).toBe(true);
    expect(setItem).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem(scopedKey("kb-quick-entry-text", "other-project"))).toBeNull();
    expect(localStorage.getItem(scopedKey("kb-inline-create-text", "other-project"))).toBeNull();
    expect(localStorage.getItem(scopedKey("kb-quick-entry-text", "keep-project"))).toBe("fresh");
    expect(localStorage.getItem(scopedKey("kb-dashboard-list-columns", "other-project"))).toBe("keep preference");
    expect(localStorage.getItem("kb-dashboard-tasks-cache:old")).toBeNull();
  });

  it("returns false instead of throwing when storage remains full", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(() => expect(setScopedItem("kb-quick-entry-text", "draft", "proj-abc")).toBe(false)).not.toThrow();
  });

  it("declares every volatile draft key as project-scoped storage", () => {
    expect(PROJECT_STORAGE_KEYS).toEqual(expect.arrayContaining(VOLATILE_DRAFT_STORAGE_KEYS));
  });

  it("removeScopedItem is a no-op when localStorage.removeItem is unavailable", () => {
    vi.stubGlobal("window", { localStorage: {} });
    expect(() => removeScopedItem("kb-dashboard-list-columns", "proj-abc")).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("keeps scoped reads and cleanup throw-safe when browser storage is blocked", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });
    vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });

    expect(getScopedItem("kb-quick-entry-text", "proj-abc")).toBeNull();
    expect(() => removeScopedItem("kb-quick-entry-text", "proj-abc")).not.toThrow();
  });

  it("has no overlap between global and project-scoped keys", () => {
    const globalSet = new Set(GLOBAL_STORAGE_KEYS);
    const overlap = PROJECT_STORAGE_KEYS.filter((key) => globalSet.has(key));

    expect(overlap).toEqual([]);
  });
});
