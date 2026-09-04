import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import {
  __resetRemoteTunnelServicesForTests,
  getRemoteTunnelService,
  peekRemoteTunnelService,
  remoteTunnelScopeKey,
  preserveAllRemoteTunnelsForSupervisedRestart,
  preserveRemoteTunnelForSupervisedRestart,
  shutdownAllRemoteTunnels,
  shutdownRemoteTunnelService,
} from "../remote-access/remote-tunnel-service.js";

/*
FNXC:RemoteAccess 2026-08-31-07:08:
Original symptom: "Stop engine" / "Restart engine" took the Tailscale tunnel down with the engine,
because TunnelProcessManager was owned by ProjectEngine. Remote access is the operator's route to the
box, so the failure removed the means of repair.

These tests pin the ownership invariant at the seam that now holds it: the process-lifetime registry.
No engine is involved anywhere in this file — that is the point.
*/

function createSettings(overrides: Record<string, unknown> = {}) {
  return {
    remoteAccess: {
      activeProvider: "cloudflare" as const,
      providers: {
        tailscale: { enabled: false, hostname: "", targetPort: 4040, acceptRoutes: false },
        cloudflare: {
          enabled: true,
          quickTunnel: false,
          tunnelName: "demo",
          tunnelToken: "token",
          ingressUrl: "https://remote.example.com",
        },
      },
      tokenStrategy: {
        persistent: { enabled: false, token: null },
        shortLived: { enabled: false, ttlMs: 1000, maxTtlMs: 2000 },
      },
      lifecycle: {
        rememberLastRunning: true,
        wasRunningOnShutdown: false,
        lastRunningProvider: null,
      },
      ...overrides,
    },
  };
}

function createStore(settings = createSettings()): TaskStore & { updateSettings: ReturnType<typeof vi.fn> } {
  const state = { ...settings };
  const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
    Object.assign(state, patch);
  });
  return {
    getSettings: vi.fn(async () => state),
    updateSettings,
    getRootDir: vi.fn(() => "/fake/root"),
  } as unknown as TaskStore & { updateSettings: ReturnType<typeof vi.fn> };
}

describe("remote tunnel service registry", () => {
  beforeEach(() => {
    __resetRemoteTunnelServicesForTests();
  });

  it("returns the same service — and the same manager — for repeated lookups of one project", () => {
    const key = remoteTunnelScopeKey({ projectId: "proj-1" });
    const first = getRemoteTunnelService(key);
    const second = getRemoteTunnelService(key);

    // This identity IS the fix: an engine restart re-looks-up and finds the live tunnel.
    expect(second).toBe(first);
    expect(second.getManager()).toBe(first.getManager());
  });

  it("keeps per-project scoping — different projects never share a tunnel", () => {
    const a = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-a" }));
    const b = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-b" }));
    expect(a).not.toBe(b);
  });

  it("derives one key per project regardless of which surface asks", () => {
    // Registered project: the central id wins even when a root dir is also known, so the engine path
    // and the engine-less route path cannot land on two services (which would mean two tunnels).
    expect(remoteTunnelScopeKey({ projectId: "proj-1", rootDir: "/a" }))
      .toBe(remoteTunnelScopeKey({ projectId: "proj-1", rootDir: "/b" }));
    // Unregistered launch directory: both surfaces fall back to the same root dir.
    expect(remoteTunnelScopeKey({ rootDir: "/fake/root" }))
      .toBe(remoteTunnelScopeKey({ projectId: null, rootDir: "/fake/root" }));
    expect(remoteTunnelScopeKey({ projectId: "proj-1" }))
      .not.toBe(remoteTunnelScopeKey({ rootDir: "proj-1" }));
  });

  it("peek never creates a service as a side effect", () => {
    const key = remoteTunnelScopeKey({ projectId: "proj-peek" });
    expect(peekRemoteTunnelService(key)).toBeUndefined();
    getRemoteTunnelService(key);
    expect(peekRemoteTunnelService(key)).toBeDefined();
  });

  it("leaves an already-running tunnel alone when restore re-runs on an engine restart", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-1" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue({
      provider: "cloudflare",
      state: "running",
      pid: 11,
      startedAt: null,
      stoppedAt: null,
      url: "https://live.example.com",
      lastError: null,
    });
    const startSpy = vi.spyOn(manager, "start").mockResolvedValue(undefined);
    const store = createStore(createSettings({
      lifecycle: { rememberLastRunning: true, wasRunningOnShutdown: true, lastRunningProvider: "cloudflare" },
    }));

    await service.restoreIfNeeded(store);

    expect(startSpy).not.toHaveBeenCalled();
    expect(service.getRestoreDiagnostics()).toMatchObject({
      outcome: "skipped",
      reason: "already_running",
    });
  });

  it("persists the running marker and stops the process only on shutdown", async () => {
    const key = remoteTunnelScopeKey({ projectId: "proj-1" });
    const service = getRemoteTunnelService(key);
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue({
      provider: "cloudflare",
      state: "running",
      pid: 11,
      startedAt: null,
      stoppedAt: null,
      url: "https://live.example.com",
      lastError: null,
    });
    const stopSpy = vi.spyOn(manager, "stop").mockResolvedValue(undefined);
    const store = createStore();

    await shutdownRemoteTunnelService(key, store);

    expect(stopSpy).toHaveBeenCalledTimes(1);
    // The marker is what lets restore-on-start bring the tunnel back next boot.
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        lifecycle: expect.objectContaining({
          wasRunningOnShutdown: true,
          lastRunningProvider: "cloudflare",
        }),
      }),
    }));
    // The registry entry is gone, so a later lookup does not resurrect a dead manager.
    expect(peekRemoteTunnelService(key)).toBeUndefined();
  });

  it("sweeps tunnels whose engine is already gone on process shutdown", async () => {
    const orphan = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "paused-project" }));
    const stopSpy = vi.spyOn(orphan.getManager(), "stop").mockResolvedValue(undefined);

    await shutdownAllRemoteTunnels();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(peekRemoteTunnelService(remoteTunnelScopeKey({ projectId: "paused-project" }))).toBeUndefined();
  });

  it("starts and stops without an engine, driving the manager from the store alone", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ rootDir: "/fake/root" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue({
      provider: null,
      state: "stopped",
      pid: null,
      startedAt: null,
      stoppedAt: null,
      url: null,
      lastError: null,
    });
    const startSpy = vi.spyOn(manager, "start").mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(manager, "stop").mockResolvedValue(undefined);
    vi.spyOn(service, "evaluateRemoteLifecycle").mockResolvedValue({
      provider: "cloudflare",
      config: { provider: "cloudflare", executablePath: "cloudflared", args: ["tunnel"] },
    });
    const store = createStore();

    await service.start(store);
    expect(startSpy).toHaveBeenCalledWith("cloudflare", expect.objectContaining({ provider: "cloudflare" }));

    await service.stop(store);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(store.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        lifecycle: expect.objectContaining({ wasRunningOnShutdown: false, lastRunningProvider: null }),
      }),
    }));
  });
});

/*
FNXC:RemoteAccess 2026-09-01-02:54:
Original symptom (observed twice on the operator's container): Command Center "Restart" — and the new
"Update from source" control, which ends in the same restart — brought the dashboard back healthy while
the Tailscale funnel was gone and the public URL was dead, with the status route reporting
{"state":"stopped","restore":{"reason":"no_prior_running_marker"}}.

Two causes, both pinned here. (1) A supervised restart went down the process-exit teardown, so the
tunnel was stopped on every routine restart. (2) Restore erased the running marker on transient
failures, so once a boot outran tailscaled the marker was gone for good.
*/
function createTailscaleSettings(lifecycle: Record<string, unknown> = {}) {
  return {
    remoteAccess: {
      activeProvider: "tailscale" as const,
      providers: {
        tailscale: { enabled: true, hostname: "box", targetPort: 4040, acceptRoutes: false },
        cloudflare: { enabled: false, quickTunnel: false, tunnelName: "", tunnelToken: "", ingressUrl: "" },
      },
      tokenStrategy: {
        persistent: { enabled: false, token: null },
        shortLived: { enabled: false, ttlMs: 1000, maxTtlMs: 2000 },
      },
      lifecycle: {
        rememberLastRunning: true,
        wasRunningOnShutdown: true,
        lastRunningProvider: "tailscale" as const,
        ...lifecycle,
      },
    },
  };
}

const RUNNING_TAILSCALE_STATUS = {
  provider: "tailscale" as const,
  state: "running" as const,
  pid: 201,
  startedAt: null,
  stoppedAt: null,
  url: "https://box.tail1234.ts.net/",
  lastError: null,
};

const STOPPED_STATUS = {
  provider: null,
  state: "stopped" as const,
  pid: null,
  startedAt: null,
  stoppedAt: null,
  url: null,
  lastError: null,
};

function markerWrites(store: ReturnType<typeof createStore>): Array<Record<string, unknown>> {
  return store.updateSettings.mock.calls.map(([patch]) => (patch as {
    remoteAccess: { lifecycle: Record<string, unknown> };
  }).remoteAccess.lifecycle);
}

describe("supervised restart is not a shutdown", () => {
  beforeEach(() => {
    __resetRemoteTunnelServicesForTests();
  });

  it("hands the tunnel over instead of stopping it, and persists the running marker first", async () => {
    const key = remoteTunnelScopeKey({ projectId: "proj-1" });
    const service = getRemoteTunnelService(key);
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue(RUNNING_TAILSCALE_STATUS);
    const stopSpy = vi.spyOn(manager, "stop").mockResolvedValue(undefined);
    const releaseSpy = vi.spyOn(manager, "releaseForSupervisedRestart").mockReturnValue(true);
    const store = createStore(createTailscaleSettings());

    await expect(preserveRemoteTunnelForSupervisedRestart(key, store)).resolves.toBe(true);

    // The whole incident in one assertion: a restart must not stop the operator's remote access.
    expect(stopSpy).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    // The marker still lands, so even a child that dies anyway is restored rather than lost.
    expect(markerWrites(store).at(-1)).toMatchObject({
      wasRunningOnShutdown: true,
      lastRunningProvider: "tailscale",
    });
  });

  it("releases orphan tunnels on the sweep too, rather than killing them", async () => {
    const orphan = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "paused-project" }));
    const stopSpy = vi.spyOn(orphan.getManager(), "stop").mockResolvedValue(undefined);
    const releaseSpy = vi.spyOn(orphan.getManager(), "releaseForSupervisedRestart").mockReturnValue(true);

    await preserveAllRemoteTunnelsForSupervisedRestart();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("still stops the tunnel on a genuine process shutdown", async () => {
    const key = remoteTunnelScopeKey({ projectId: "proj-1" });
    const service = getRemoteTunnelService(key);
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue(RUNNING_TAILSCALE_STATUS);
    const stopSpy = vi.spyOn(manager, "stop").mockResolvedValue(undefined);
    const releaseSpy = vi.spyOn(manager, "releaseForSupervisedRestart");

    await shutdownRemoteTunnelService(key, createStore(createTailscaleSettings()));

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it("adopts the funnel that survived the restart instead of spawning a second one", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-1" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue(STOPPED_STATUS);
    const startSpy = vi.spyOn(manager, "start").mockResolvedValue(undefined);
    const adoptSpy = vi.spyOn(manager, "adoptRunningTunnel").mockImplementation(() => undefined);
    vi.spyOn(manager, "detectActiveFunnel").mockResolvedValue({
      provider: "tailscale",
      url: "https://box.tail1234.ts.net/",
      proxyPort: 4040,
    });
    const store = createStore(createTailscaleSettings());

    await service.restoreIfNeeded(store);

    // A second `tailscale funnel` would exit 1 AND clear the first one's config — that is itself a way
    // to kill remote access, so restore must never spawn over a live funnel.
    expect(startSpy).not.toHaveBeenCalled();
    expect(adoptSpy).toHaveBeenCalledWith("tailscale", "https://box.tail1234.ts.net/");
    expect(service.getRestoreDiagnostics()).toMatchObject({
      outcome: "applied",
      reason: "adopted_running_tunnel",
    });
    expect(markerWrites(store).at(-1)).toMatchObject({ wasRunningOnShutdown: true });
  });

  /*
  FNXC:RemoteAccess 2026-09-01-03:52:
  The stuck state, reproduced: once a restart loses track of the tunnel, the service believes it is
  stopped, so it writes no running marker — and a marker-gated adoption then skips forever with
  `no_prior_running_marker` while the public URL keeps serving 200. Adoption must depend on what
  tailscaled can PROVE, not on what this process remembers.
  */
  it("adopts a live funnel even with no running marker, which is the state a lost restart leaves behind", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-1" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue(STOPPED_STATUS);
    const startSpy = vi.spyOn(manager, "start").mockResolvedValue(undefined);
    const adoptSpy = vi.spyOn(manager, "adoptRunningTunnel").mockImplementation(() => undefined);
    vi.spyOn(manager, "detectActiveFunnel").mockResolvedValue({
      provider: "tailscale",
      url: "https://box.tail1234.ts.net/",
      proxyPort: 4040,
    });
    const settings = createTailscaleSettings();
    settings.remoteAccess.lifecycle.wasRunningOnShutdown = false;
    settings.remoteAccess.lifecycle.lastRunningProvider = null;
    const store = createStore(settings);

    await service.restoreIfNeeded(store);

    expect(startSpy).not.toHaveBeenCalled();
    expect(adoptSpy).toHaveBeenCalledWith("tailscale", "https://box.tail1234.ts.net/");
    expect(service.getRestoreDiagnostics()).toMatchObject({
      outcome: "applied",
      reason: "adopted_running_tunnel",
    });
    // The marker is re-established, so the service can recover itself from the lost state.
    expect(markerWrites(store).at(-1)).toMatchObject({ wasRunningOnShutdown: true });
  });

  it("refuses to clobber a funnel that is serving a different port", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-1" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue(STOPPED_STATUS);
    const startSpy = vi.spyOn(manager, "start").mockResolvedValue(undefined);
    const adoptSpy = vi.spyOn(manager, "adoptRunningTunnel").mockImplementation(() => undefined);
    vi.spyOn(manager, "detectActiveFunnel").mockResolvedValue({
      provider: "tailscale",
      url: "https://box.tail1234.ts.net/",
      proxyPort: 9999,
    });
    const store = createStore(createTailscaleSettings());

    await service.restoreIfNeeded(store);

    expect(startSpy).not.toHaveBeenCalled();
    expect(adoptSpy).not.toHaveBeenCalled();
    expect(service.getRestoreDiagnostics()).toMatchObject({
      outcome: "skipped",
      reason: "external_funnel_conflict",
    });
    // The operator's intent survives the refusal.
    expect(markerWrites(store).some((lifecycle) => lifecycle.wasRunningOnShutdown === false)).toBe(false);
  });

  it("spawns a fresh tunnel when no surviving funnel can be proven", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-1" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue(STOPPED_STATUS);
    const startSpy = vi.spyOn(manager, "start").mockResolvedValue(undefined);
    vi.spyOn(manager, "detectActiveFunnel").mockResolvedValue(null);
    vi.spyOn(service, "evaluateRemoteLifecycle").mockResolvedValue({
      provider: "tailscale",
      config: { provider: "tailscale", executablePath: "tailscale", args: ["funnel", "4040"] },
    });

    await service.restoreIfNeeded(createStore(createTailscaleSettings()));

    expect(startSpy).toHaveBeenCalledWith("tailscale", expect.objectContaining({ provider: "tailscale" }));
    expect(service.getRestoreDiagnostics()).toMatchObject({ outcome: "applied", reason: "restore_started" });
  });

  it("keeps the running marker when tailscaled is not ready yet", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-1" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue(STOPPED_STATUS);
    vi.spyOn(manager, "detectActiveFunnel").mockResolvedValue(null);
    vi.spyOn(service, "evaluateRemoteLifecycle").mockResolvedValue({
      provider: "tailscale",
      reason: "runtime_prerequisite_missing",
      message: "tailscaled is not reachable",
    });
    const store = createStore(createTailscaleSettings());

    await service.restoreIfNeeded(store);

    // Clearing the marker here is how one unlucky boot became a permanent no_prior_running_marker.
    expect(markerWrites(store).some((lifecycle) => lifecycle.wasRunningOnShutdown === false)).toBe(false);
    expect(service.getRestoreDiagnostics()).toMatchObject({
      outcome: "skipped",
      reason: "runtime_prerequisite_missing",
    });
  });

  it("keeps the running marker when a restore spawn fails", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-1" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue(STOPPED_STATUS);
    vi.spyOn(manager, "detectActiveFunnel").mockResolvedValue(null);
    vi.spyOn(manager, "start").mockRejectedValue(new Error("process exited 1"));
    vi.spyOn(service, "evaluateRemoteLifecycle").mockResolvedValue({
      provider: "tailscale",
      config: { provider: "tailscale", executablePath: "tailscale", args: ["funnel", "4040"] },
    });
    const store = createStore(createTailscaleSettings());

    await service.restoreIfNeeded(store);

    expect(markerWrites(store).some((lifecycle) => lifecycle.wasRunningOnShutdown === false)).toBe(false);
    expect(service.getRestoreDiagnostics()).toMatchObject({ outcome: "failed", reason: "restore_start_failed" });
  });

  it("still clears the marker when remote access is genuinely turned off", async () => {
    const service = getRemoteTunnelService(remoteTunnelScopeKey({ projectId: "proj-1" }));
    const manager = service.getManager();
    vi.spyOn(manager, "getStatus").mockReturnValue(STOPPED_STATUS);
    vi.spyOn(manager, "detectActiveFunnel").mockResolvedValue(null);
    vi.spyOn(service, "evaluateRemoteLifecycle").mockResolvedValue({
      provider: "tailscale",
      reason: "provider_not_enabled",
      message: "Tailscale provider is disabled",
    });
    const store = createStore(createTailscaleSettings());

    await service.restoreIfNeeded(store);

    expect(markerWrites(store).at(-1)).toMatchObject({ wasRunningOnShutdown: false, lastRunningProvider: null });
  });
});
