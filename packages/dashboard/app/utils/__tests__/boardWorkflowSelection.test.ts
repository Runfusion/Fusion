import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOARD_WORKFLOW_SELECTION_STORAGE_KEY,
  readBoardWorkflowSelection,
  removeBoardWorkflowSelection,
  writeBoardWorkflowSelection,
} from "../boardWorkflowSelection";
import { scopedKey } from "../projectStorage";

const projectKey = (projectId: string) => scopedKey(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, projectId);

describe("boardWorkflowSelection", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("persists selected workflow ids per project", () => {
    writeBoardWorkflowSelection("project-a", "builtin:coding");
    writeBoardWorkflowSelection("project-b", "WF-123");

    expect(window.localStorage.getItem(projectKey("project-a"))).toBe("builtin:coding");
    expect(window.localStorage.getItem(projectKey("project-b"))).toBe("WF-123");
    expect(readBoardWorkflowSelection("project-a")).toBe("builtin:coding");
    expect(readBoardWorkflowSelection("project-b")).toBe("WF-123");
  });

  it("uses the unscoped default when no project is selected", () => {
    writeBoardWorkflowSelection(undefined, "default-workflow");
    writeBoardWorkflowSelection("project-a", "project-workflow");

    expect(window.localStorage.getItem(BOARD_WORKFLOW_SELECTION_STORAGE_KEY)).toBe("default-workflow");
    expect(readBoardWorkflowSelection()).toBe("default-workflow");
    expect(readBoardWorkflowSelection("project-a")).toBe("project-workflow");
  });

  it("ignores malformed or empty stored values", () => {
    window.localStorage.setItem(projectKey("empty"), "  ");
    window.localStorage.setItem(projectKey("object"), JSON.stringify({ id: "builtin:coding" }));
    window.localStorage.setItem(projectKey("array"), JSON.stringify(["builtin:coding"]));
    window.localStorage.setItem(projectKey("control"), "workflow\u0000id");

    expect(readBoardWorkflowSelection("empty")).toBeNull();
    expect(readBoardWorkflowSelection("object")).toBeNull();
    expect(readBoardWorkflowSelection("array")).toBeNull();
    expect(readBoardWorkflowSelection("control")).toBeNull();
  });

  it("trims valid workflow ids before storing and reading", () => {
    writeBoardWorkflowSelection("project-a", "  builtin:coding  ");

    expect(window.localStorage.getItem(projectKey("project-a"))).toBe("builtin:coding");
    expect(readBoardWorkflowSelection("project-a")).toBe("builtin:coding");
  });

  it("removes the stored selection when writing an empty or malformed value", () => {
    writeBoardWorkflowSelection("project-a", "builtin:coding");
    writeBoardWorkflowSelection("project-a", "   ");
    expect(readBoardWorkflowSelection("project-a")).toBeNull();

    writeBoardWorkflowSelection("project-a", "builtin:coding");
    writeBoardWorkflowSelection("project-a", "{\"id\":\"builtin:coding\"}");
    expect(readBoardWorkflowSelection("project-a")).toBeNull();

    writeBoardWorkflowSelection("project-a", "builtin:coding");
    writeBoardWorkflowSelection("project-a", "workflow\u0000id");
    expect(readBoardWorkflowSelection("project-a")).toBeNull();
  });

  it("removes stored selections for the requested project only", () => {
    writeBoardWorkflowSelection("project-a", "builtin:coding");
    writeBoardWorkflowSelection("project-b", "WF-123");

    removeBoardWorkflowSelection("project-a");

    expect(readBoardWorkflowSelection("project-a")).toBeNull();
    expect(readBoardWorkflowSelection("project-b")).toBe("WF-123");
  });

  it("returns null and no-ops when storage APIs are unavailable", () => {
    vi.stubGlobal("window", { localStorage: {} });

    expect(readBoardWorkflowSelection("project-a")).toBeNull();
    expect(() => writeBoardWorkflowSelection("project-a", "builtin:coding")).not.toThrow();
    expect(() => removeBoardWorkflowSelection("project-a")).not.toThrow();
  });

  it("returns null and no-ops without a browser window", () => {
    vi.stubGlobal("window", undefined);

    expect(readBoardWorkflowSelection("project-a")).toBeNull();
    expect(() => writeBoardWorkflowSelection("project-a", "builtin:coding")).not.toThrow();
    expect(() => removeBoardWorkflowSelection("project-a")).not.toThrow();
  });

  it("swallows localStorage read, write, and remove failures", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("private mode read");
        },
      },
    });
    expect(readBoardWorkflowSelection("project-a")).toBeNull();
    vi.unstubAllGlobals();

    vi.stubGlobal("window", {
      localStorage: {
        setItem: () => {
          throw new Error("quota");
        },
        removeItem: () => undefined,
      },
    });
    expect(() => writeBoardWorkflowSelection("project-a", "builtin:coding")).not.toThrow();
    vi.unstubAllGlobals();

    vi.stubGlobal("window", {
      localStorage: {
        removeItem: () => {
          throw new Error("private mode remove");
        },
      },
    });
    expect(() => removeBoardWorkflowSelection("project-a")).not.toThrow();
  });
});
