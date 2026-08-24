/**
 * FNXC:RUFU121ProjectIdentity 2026-08-18-19:53:
 * RUFU-121 Step 3: TaskStore.getProjectId() — the store's project id from the
 * injected AsyncDataLayer, or null in legacy (no asyncLayer) / unscoped mode.
 * The engine task-capture seam and the dashboard chat-delete Stash sync route
 * consume this for project attribution WITHOUT a central-core lookup.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../store.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "fusion-rufu121-store-"));
  roots.push(value);
  return value;
};
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("TaskStore.getProjectId (RUFU-121)", () => {
  it("returns the injected AsyncDataLayer projectId", () => {
    const store = new TaskStore(root(), undefined, {
      asyncLayer: { projectId: "proj_abc" } as never,
    });
    expect(store.getProjectId()).toBe("proj_abc");
  });

  it("returns null for a legacy (no asyncLayer) store", () => {
    const store = new TaskStore(root());
    expect(store.getProjectId()).toBeNull();
  });

  it("returns null when the asyncLayer carries no projectId", () => {
    const store = new TaskStore(root(), undefined, { asyncLayer: {} as never });
    expect(store.getProjectId()).toBeNull();
  });
});
