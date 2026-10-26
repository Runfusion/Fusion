import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import {
  buildDashboardRuntimePlugins,
  DASHBOARD_RUNTIME_PLUGIN_PACKAGES,
  workspaceRoot,
} from "../../scripts/workspace-tools";

let children: EventEmitter[];
let directories: string[];
let active: Set<EventEmitter>;
let peak: number;

beforeEach(() => {
  children = [];
  directories = [];
  active = new Set();
  peak = 0;
  spawn.mockReset().mockImplementation((_command, args, options) => {
    expect(args).toEqual([]);
    const child = new EventEmitter();
    child.once("exit", () => active.delete(child));
    child.once("error", () => active.delete(child));
    children.push(child);
    directories.push(options.cwd);
    active.add(child);
    peak = Math.max(peak, active.size);
    return child;
  });
});

async function exit(index: number, code = 0): Promise<void> {
  children[index].emit("exit", code);
  // FNXC:DesktopBuildMemory 2026-10-23-12:00: Flush the runWorkspaceBin -> buildPackage -> caller promise boundaries.
  await Promise.resolve();
  await Promise.resolve();
}

describe("desktop runtime plugin compiler admission", () => {
  it("finishes the SDK first and builds every plugin with one resident compiler", async () => {
    const build = buildDashboardRuntimePlugins();
    expect(directories).toEqual([resolve(workspaceRoot, "packages/plugin-sdk")]);
    await exit(0);
    for (const [index, plugin] of DASHBOARD_RUNTIME_PLUGIN_PACKAGES.entries()) {
      expect(children).toHaveLength(index + 2);
      expect(directories.at(-1)).toBe(resolve(workspaceRoot, plugin));
      expect(active.size).toBe(1);
      await exit(index + 1);
    }
    await expect(build).resolves.toBeUndefined();
    expect(peak).toBe(1);
    expect(active.size).toBe(0);
    expect(directories).toEqual([
      "packages/plugin-sdk", ...DASHBOARD_RUNTIME_PLUGIN_PACKAGES,
    ].map((entry) => resolve(workspaceRoot, entry)));
  });

  it("does not start plugins when the SDK compiler fails", async () => {
    const build = buildDashboardRuntimePlugins();
    const rejected = expect(build).rejects.toThrow("exited with code 2");
    await exit(0, 2);
    await rejected;
    expect(children).toHaveLength(1);
    expect(active.size).toBe(0);
  });

  it("propagates a plugin compiler failure without starting later plugins", async () => {
    const build = buildDashboardRuntimePlugins();
    const rejected = expect(build).rejects.toThrow("exited with code 3");
    await exit(0);
    await exit(1, 3);
    await rejected;
    expect(children).toHaveLength(2);
    expect(active.size).toBe(0);
  });

  it("propagates a spawn error without admitting another plugin", async () => {
    const build = buildDashboardRuntimePlugins();
    const error = new Error("compiler could not start");
    const rejected = expect(build).rejects.toBe(error);
    await exit(0);
    children[1].emit("error", error);
    await rejected;
    expect(children).toHaveLength(2);
    expect(active.size).toBe(0);
  });
});
