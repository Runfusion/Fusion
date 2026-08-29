import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardWorkflowsPayload } from "../../api";
import { clearBoardWorkflowsCache, readBoardWorkflowsCache, writeBoardWorkflowsCache } from "../boardWorkflowsCache";

const payload: BoardWorkflowsPayload = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [
    {
      id: "builtin:coding",
      name: "Coding",
      columns: [{ id: "todo", name: "Todo", flags: {} }],
    },
  ],
  taskWorkflowIds: { "FN-1": "builtin:coding" },
};

describe("boardWorkflowsCache", () => {
  afterEach(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.clear();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("round-trips board-workflows payloads per project", () => {
    writeBoardWorkflowsCache("project-a", payload);

    expect(readBoardWorkflowsCache("project-a")).toEqual(payload);
  });

  it("keeps project cache keys isolated", () => {
    writeBoardWorkflowsCache("project-a", payload);

    expect(readBoardWorkflowsCache("project-b")).toBeNull();
  });

  it("clears only the requested project cache after out-of-component workflow mutations", () => {
    writeBoardWorkflowsCache("project-a", payload);
    writeBoardWorkflowsCache("project-b", { ...payload, defaultWorkflowId: "wf-b" });

    clearBoardWorkflowsCache("project-a");

    expect(readBoardWorkflowsCache("project-a")).toBeNull();
    expect(readBoardWorkflowsCache("project-b")).toEqual({ ...payload, defaultWorkflowId: "wf-b" });
  });

  it("returns null for missing, corrupt, or invalid entries", () => {
    expect(readBoardWorkflowsCache("missing")).toBeNull();

    window.sessionStorage.setItem("fusion:board-workflows:corrupt", "{");
    expect(readBoardWorkflowsCache("corrupt")).toBeNull();

    window.sessionStorage.setItem("fusion:board-workflows:invalid", JSON.stringify({ flagEnabled: true, workflows: {} }));
    expect(readBoardWorkflowsCache("invalid")).toBeNull();
  });

  it("swallows sessionStorage write failures", () => {
    vi.spyOn(window.sessionStorage.__proto__, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    expect(() => writeBoardWorkflowsCache("project-a", payload)).not.toThrow();
  });

  it("swallows sessionStorage read failures", () => {
    vi.spyOn(window.sessionStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });

    expect(readBoardWorkflowsCache("project-a")).toBeNull();
  });

  it("returns null without window for SSR callers", () => {
    vi.stubGlobal("window", undefined);

    expect(readBoardWorkflowsCache("project-a")).toBeNull();
    expect(() => writeBoardWorkflowsCache("project-a", payload)).not.toThrow();
  });
});
