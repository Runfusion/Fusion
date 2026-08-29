import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPositions, loadPositions, mergePositions, savePositions } from "../utils/graphPositionStorage";

function createStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe("graphPositionStorage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("window", { localStorage: createStorage() });
  });

  it("loadPositions returns parsed positions from localStorage", () => {
    window.localStorage.setItem("kb:p1:fusion-plugin-dependency-graph:positions", JSON.stringify({ a: { x: 1, y: 2 } }));
    expect(loadPositions("p1")).toEqual({ a: { x: 1, y: 2 } });
  });

  it("loadPositions returns empty object when localStorage is empty", () => {
    expect(loadPositions("p1")).toEqual({});
  });

  it("loadPositions returns empty object for invalid json", () => {
    window.localStorage.setItem("kb:p1:fusion-plugin-dependency-graph:positions", "{oops");
    expect(loadPositions("p1")).toEqual({});
  });

  it("loadPositions skips entries with invalid position shape", () => {
    window.localStorage.setItem(
      "kb:p1:fusion-plugin-dependency-graph:positions",
      JSON.stringify({
        good: { x: 1, y: 2 },
        badX: { x: "1", y: 2 },
        badY: { x: 1, y: null },
      }),
    );

    expect(loadPositions("p1")).toEqual({ good: { x: 1, y: 2 } });
  });

  it("savePositions writes filtered positions json to scoped localStorage key", () => {
    savePositions({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }, new Set(["a"]), "p1");
    expect(window.localStorage.getItem("kb:p1:fusion-plugin-dependency-graph:positions")).toBe(JSON.stringify({ a: { x: 1, y: 2 } }));
  });

  it("clearPositions removes scoped localStorage key", () => {
    window.localStorage.setItem("kb:p1:fusion-plugin-dependency-graph:positions", JSON.stringify({ a: { x: 1, y: 2 } }));
    clearPositions("p1");
    expect(window.localStorage.getItem("kb:p1:fusion-plugin-dependency-graph:positions")).toBeNull();
  });

  it("mergePositions prefers saved for overlap and keeps auto-layout for new tasks", () => {
    expect(
      mergePositions(
        { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } },
        { a: { x: 10, y: 10 } },
        new Set(["a", "b"]),
      ),
    ).toEqual({ a: { x: 10, y: 10 }, b: { x: 2, y: 2 } });
  });

  it("mergePositions omits non-visible ids", () => {
    expect(
      mergePositions(
        { a: { x: 1, y: 1 }, hidden: { x: 9, y: 9 } },
        { hidden: { x: 10, y: 10 } },
        new Set(["a"]),
      ),
    ).toEqual({ a: { x: 1, y: 1 } });
  });

  it("mergePositions returns auto-layout unchanged when saved is empty", () => {
    expect(mergePositions({ a: { x: 1, y: 2 } }, {}, new Set(["a"]))).toEqual({ a: { x: 1, y: 2 } });
  });

  it("loadPositions returns empty object when localStorage.getItem is unavailable", () => {
    vi.stubGlobal("window", { localStorage: {} });
    expect(loadPositions("p1")).toEqual({});
  });

  it("savePositions and clearPositions are no-ops when localStorage methods are unavailable", () => {
    vi.stubGlobal("window", { localStorage: {} });
    expect(() => savePositions({ a: { x: 1, y: 2 } }, new Set(["a"]), "p1")).not.toThrow();
    expect(() => clearPositions("p1")).not.toThrow();
  });
});
