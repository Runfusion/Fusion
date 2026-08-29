import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, loadWorkspaceConfig: loader.load };
});

import { applyWorkspaceModeToggle } from "@fusion/core";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { invalidateWorkspaceConfigCache, resolveWorkspaceConfigOnce } from "../executor/workspace-config-resolver.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  loader.load.mockImplementation(actual.loadWorkspaceConfig);
});

describe("workspace config cache invalidation", () => {
  it("keeps a host memoized until a real workspace transition invalidates it", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-workspace-cache-")); roots.push(root);
    mkdirSync(join(root, ".fusion"), { recursive: true });
    writeFileSync(join(root, ".fusion", "workspace.json"), JSON.stringify({ repos: ["repo-a"] }));
    const host: { config: { repos: string[] } | null | undefined } = { config: undefined };
    const deps = { rootDir: root, workspaceConfigOwner: host, getWorkspaceConfig: () => host.config, setWorkspaceConfig: (config: { repos: string[] } | null) => { host.config = config; } };
    expect(await resolveWorkspaceConfigOnce(deps)).toEqual({ repos: ["repo-a"] });
    await applyWorkspaceModeToggle(root, false);
    expect(await resolveWorkspaceConfigOnce(deps)).toEqual({ repos: ["repo-a"] });
    host.config = undefined; invalidateWorkspaceConfigCache(host);
    expect(await resolveWorkspaceConfigOnce(deps)).toBeNull();
  });

  it("fences a pre-invalidation load so its late completion cannot repopulate the host", async () => {
    let release!: (value: { repos: string[] } | null) => void;
    loader.load.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const host: { config: { repos: string[] } | null | undefined } = { config: undefined };
    const deps = { rootDir: "/unused", workspaceConfigOwner: host, getWorkspaceConfig: () => host.config, setWorkspaceConfig: (config: { repos: string[] } | null) => { host.config = config; } };
    const pending = resolveWorkspaceConfigOnce(deps);
    invalidateWorkspaceConfigCache(host);
    release({ repos: ["stale"] });
    await expect(pending).resolves.toEqual({ repos: ["stale"] });
    expect(host.config).toBeUndefined();
  });

  it("wires settings:updated through the production runtime and ignores corrected no-transitions", () => {
    const runtime = new InProcessRuntime({ projectId: "test", workingDirectory: process.cwd() } as never, {} as never);
    const taskStore = new EventEmitter();
    const executor = { invalidateWorkspaceConfig: vi.fn() };
    (runtime as any).taskStore = taskStore;
    (runtime as any).executor = executor;
    (runtime as any).setupEventForwarding();

    taskStore.emit("settings:updated", { previous: { workspaceMode: false }, settings: { workspaceMode: true } });
    taskStore.emit("settings:updated", { previous: { workspaceMode: false }, settings: { workspaceMode: false } });
    taskStore.emit("settings:updated", { previous: { workspaceMode: true }, settings: { workspaceMode: true } });

    expect(executor.invalidateWorkspaceConfig).toHaveBeenCalledTimes(1);
  });
});
