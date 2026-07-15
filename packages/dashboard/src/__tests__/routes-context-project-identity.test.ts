// @vitest-environment node

/**
 * FNXC:CentralProjectIdentity 2026-07-13-23:56:
 * Directive coverage: dashboard route project resolution must operate on an
 * EXPLICIT central-registry id — request projectId → registered launch project
 * id (options.engine.getProjectId()) → raw launch-dir store only for an
 * unregistered/legacy launch directory. A resolved id always binds through the
 * engine store (live engine) or getOrCreateProjectStore; the launch project
 * reuses the injected registry-bound store rather than booting a duplicate pool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";
import type { TaskStore } from "@fusion/core";
import type { ServerOptions } from "../server.js";
import * as projectStoreResolver from "../project-store-resolver.js";
import {
  resolveRequestProjectId,
  resolveStoreForProjectId,
  getScopedStore,
  getProjectContext,
} from "../routes/context.js";
import { resolveScopedStore } from "../server.js";

function tag(name: string): TaskStore {
  return { __tag: name } as unknown as TaskStore;
}

function makeReq(projectId?: string): Request {
  return { query: projectId ? { projectId } : {}, body: {} } as unknown as Request;
}

/** Fake registered launch engine with an explicit central-registry project id. */
function makeEngine(projectId: string, taskStore: TaskStore) {
  return {
    getProjectId: () => projectId,
    getTaskStore: () => taskStore,
  } as unknown as NonNullable<ServerOptions["engine"]>;
}

describe("routes/context central project identity seam", () => {
  const rawLaunchStore = tag("raw-launch-store");
  const boundStore = tag("bound-store");

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockResolvedValue(boundStore);
  });

  it("(c) no request id and no engine → raw launch-dir store with a one-time warn (legacy)", async () => {
    const warn = vi.fn();
    const options = { runtimeLogger: { warn, info: vi.fn(), error: vi.fn(), child: vi.fn(), scope: "t" } } as unknown as ServerOptions;

    expect(resolveRequestProjectId(makeReq(), options)).toBeUndefined();

    const store = await getScopedStore(makeReq(), rawLaunchStore, options);
    expect(store).toBe(rawLaunchStore);
    expect(projectStoreResolver.getOrCreateProjectStore).not.toHaveBeenCalled();
    // One-time per process (this module instance): first no-id request warns.
    expect(warn).toHaveBeenCalledTimes(1);

    // Warn does not re-fire on a subsequent no-id request.
    await getScopedStore(makeReq(), rawLaunchStore, options);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("(a) no request id but a registered launch engine → resolves the engine's projectId and its store, not the raw store", async () => {
    const engineStore = tag("engine-store");
    const options = { engine: makeEngine("launch-proj", engineStore) } as unknown as ServerOptions;

    expect(resolveRequestProjectId(makeReq(), options)).toBe("launch-proj");

    const ctx = await getProjectContext(makeReq(), rawLaunchStore, options);
    expect(ctx.projectId).toBe("launch-proj");
    expect(ctx.store).toBe(engineStore);
    expect(ctx.store).not.toBe(rawLaunchStore);
    expect(ctx.engine).toBe(options.engine);

    // Launch project reuses the injected registry-bound store — no duplicate boot.
    const scoped = await getScopedStore(makeReq(), rawLaunchStore, options);
    expect(scoped).toBe(rawLaunchStore);
    expect(projectStoreResolver.getOrCreateProjectStore).not.toHaveBeenCalled();
  });

  it("(b) explicit request projectId (not the launch project) → binds via getOrCreateProjectStore", async () => {
    const options = { engine: makeEngine("launch-proj", tag("engine-store")) } as unknown as ServerOptions;

    const scoped = await getScopedStore(makeReq("other-proj"), rawLaunchStore, options);
    expect(scoped).toBe(boundStore);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith("other-proj");

    const ctx = await getProjectContext(makeReq("other-proj"), rawLaunchStore, options);
    expect(ctx.projectId).toBe("other-proj");
    expect(ctx.store).toBe(boundStore);
  });

  it("(b') explicit request projectId with a live engine in engineManager → binds the engine store", async () => {
    const engineStore = tag("mgr-engine-store");
    const engine = { getTaskStore: () => engineStore };
    const onProjectAccessed = vi.fn();
    const engineManager = {
      getEngine: (id: string) => (id === "mgr-proj" ? engine : undefined),
      onProjectAccessed,
    } as unknown as NonNullable<ServerOptions["engineManager"]>;
    const options = { engineManager } as unknown as ServerOptions;

    const scoped = await getScopedStore(makeReq("mgr-proj"), rawLaunchStore, options);
    expect(scoped).toBe(engineStore);
    expect(projectStoreResolver.getOrCreateProjectStore).not.toHaveBeenCalled();

    const ctx = await getProjectContext(makeReq("mgr-proj"), rawLaunchStore, options);
    expect(ctx.store).toBe(engineStore);
    expect(ctx.engine).toBe(engine);
    expect(ctx.projectId).toBe("mgr-proj");
  });

  /*
   * FNXC:CentralProjectIdentity 2026-07-14-00:15:
   * F4 dedup coverage — server.ts resolveScopedStore now delegates to the single
   * shared resolveStoreForProjectId core. These assert both entry points share
   * identical id→store semantics.
   */
  describe("(F4) shared resolveStoreForProjectId / server.ts resolveScopedStore delegation", () => {
    it("no id + no launch id → raw injected store", async () => {
      const options = {} as unknown as ServerOptions;
      const store = await resolveScopedStore(undefined, rawLaunchStore, undefined, undefined, options);
      expect(store).toBe(rawLaunchStore);
      expect(projectStoreResolver.getOrCreateProjectStore).not.toHaveBeenCalled();

      // Same result from the shared core directly.
      expect(await resolveStoreForProjectId(undefined, rawLaunchStore, options)).toBe(rawLaunchStore);
    });

    it("no id + launch id → injected (registry-bound) store, no duplicate boot", async () => {
      const engineStore = tag("engine-store");
      const options = { engine: makeEngine("launch-proj", engineStore) } as unknown as ServerOptions;
      const store = await resolveScopedStore(undefined, rawLaunchStore, undefined, "launch-proj", options);
      expect(store).toBe(rawLaunchStore);
      expect(projectStoreResolver.getOrCreateProjectStore).not.toHaveBeenCalled();
    });

    it("explicit id with a live engineManager engine → engine store", async () => {
      const engineStore = tag("mgr-engine-store");
      const engine = { getTaskStore: () => engineStore };
      const engineManager = {
        getEngine: (id: string) => (id === "mgr-proj" ? engine : undefined),
        onProjectAccessed: vi.fn(),
      } as unknown as NonNullable<ServerOptions["engineManager"]>;
      const options = { engineManager } as unknown as ServerOptions;

      const store = await resolveScopedStore("mgr-proj", rawLaunchStore, engineManager, undefined, options);
      expect(store).toBe(engineStore);
      expect(projectStoreResolver.getOrCreateProjectStore).not.toHaveBeenCalled();
    });

    it("explicit id ≠ launch, getEngine undefined → getOrCreateProjectStore", async () => {
      const options = { engine: makeEngine("launch-proj", tag("engine-store")) } as unknown as ServerOptions;
      const store = await resolveScopedStore("other-proj", rawLaunchStore, undefined, "launch-proj", options);
      expect(store).toBe(boundStore);
      expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith("other-proj");
    });
  });

  it("(F8-b) getScopedStore with engineManager present but getEngine undefined for an explicit non-launch id → getOrCreateProjectStore", async () => {
    const engineManager = {
      getEngine: () => undefined,
      onProjectAccessed: vi.fn(),
    } as unknown as NonNullable<ServerOptions["engineManager"]>;
    const options = { engineManager } as unknown as ServerOptions;

    const scoped = await getScopedStore(makeReq("other-proj"), rawLaunchStore, options);
    expect(scoped).toBe(boundStore);
    expect(projectStoreResolver.getOrCreateProjectStore).toHaveBeenCalledWith("other-proj");
  });

  it("(F9) whitespace-only projectId in query is treated as absent → launch fallback", async () => {
    // No engine: whitespace id resolves to no id at all.
    const noEngineOptions = {} as unknown as ServerOptions;
    expect(resolveRequestProjectId(makeReq("  "), noEngineOptions)).toBeUndefined();

    // With a registered launch engine: whitespace id falls through to the launch id,
    // and the launch project reuses the injected store (no getOrCreateProjectStore).
    const engineStore = tag("engine-store");
    const options = { engine: makeEngine("launch-proj", engineStore) } as unknown as ServerOptions;
    expect(resolveRequestProjectId(makeReq("  "), options)).toBe("launch-proj");

    const scoped = await getScopedStore(makeReq("  "), rawLaunchStore, options);
    expect(scoped).toBe(rawLaunchStore);
    expect(projectStoreResolver.getOrCreateProjectStore).not.toHaveBeenCalled();
  });
});
