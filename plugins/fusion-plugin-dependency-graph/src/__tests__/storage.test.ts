import { describe, expect, it, beforeEach } from "vitest";
import { projectScopedKey, loadPositions, savePositions } from "../storage";

const createMemoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    clear: () => map.clear(),
  };
};

describe("storage", () => {
  const localStorage = createMemoryStorage();

  beforeEach(() => {
    (globalThis as { window?: { localStorage?: typeof localStorage } }).window = { localStorage };
    localStorage.clear();
  });

  it("builds project-scoped key", () => {
    expect(projectScopedKey("proj_123")).toBe("kb:proj_123:dependency-graph-positions");
  });

  it("persists and restores positions", () => {
    savePositions("proj_123", { "FN-1": { x: 10, y: 20 } });
    expect(loadPositions("proj_123")).toEqual({ "FN-1": { x: 10, y: 20 } });
  });
});
