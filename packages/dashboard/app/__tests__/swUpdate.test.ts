/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  checkVersion,
  installVersionCheck,
  requestVersionCheck,
  MIN_CHECK_INTERVAL_MS,
  _resetState,
} from "../versionCheck";
import { installSwUpdate } from "../swUpdate";

vi.stubGlobal("__BUILD_VERSION__", "test-build-abc123");

type Listener = () => void;

interface FakeServiceWorkerContainer {
  controller: ServiceWorker | null;
  listeners: Map<string, Set<Listener>>;
  addEventListener: (type: string, fn: Listener) => void;
  register: (url: string) => Promise<ServiceWorkerRegistration>;
  dispatch: (type: string) => void;
}

function makeContainer(
  controller: ServiceWorker | null,
  registration?: Partial<ServiceWorkerRegistration>,
): FakeServiceWorkerContainer {
  const listeners = new Map<string, Set<Listener>>();
  return {
    controller,
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    register: vi.fn().mockResolvedValue({
      scope: "/",
      installing: null,
      waiting: null,
      addEventListener: vi.fn(),
      ...registration,
    } as unknown as ServiceWorkerRegistration),
    dispatch(type) {
      listeners.get(type)?.forEach((fn) => fn());
    },
  };
}

function versionResponse(version: string) {
  return {
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve({ version }),
  };
}

/*
FNXC:VersionAutoReload 2026-09-18-00:20:
FN-516 removed this bridge's own reload authority, so mocking `reloadOnce` here would prove nothing:
the question is no longer "did the bridge call the primitive" but "does a controller replacement reload
a page whose served build never changed". These tests therefore drive the REAL checker and observe
`location.reload` and the real network reads.
*/
describe("installSwUpdate", () => {
  const originalNavigator = globalThis.navigator;
  const reloadSpy = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("PROD", true);
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
    _resetState();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    _resetState();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
  });

  function withContainer(container: FakeServiceWorkerContainer) {
    Object.defineProperty(globalThis, "navigator", {
      value: { serviceWorker: container },
      configurable: true,
    });
  }

  function versionReads(fetchSpy: ReturnType<typeof vi.fn>): string[] {
    return fetchSpy.mock.calls
      .map(([url]: [string]) => String(url))
      .filter((url) => url.startsWith("/version.json"));
  }

  it("does NOT act on first install (no prior controller)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponse("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);
    const container = makeContainer(null);
    withContainer(container);

    installSwUpdate();
    container.dispatch("controllerchange");
    await vi.advanceTimersByTimeAsync(0);

    expect(versionReads(fetchSpy)).toHaveLength(0);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("checks but does not reload when a replaced controller serves the same build", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponse("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);
    const container = makeContainer({} as ServiceWorker);
    withContainer(container);

    installSwUpdate();
    container.dispatch("controllerchange");
    await vi.advanceTimersByTimeAsync(0);

    expect(versionReads(fetchSpy)).toHaveLength(1);
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("fusion:version-update")).toBeNull();
  });

  it("does not reload when the version cannot be read after an activation", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchSpy);
    const container = makeContainer({} as ServiceWorker);
    withContainer(container);

    installSwUpdate();
    container.dispatch("controllerchange");
    await vi.advanceTimersByTimeAsync(0);

    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("absorbs repeated controllerchange events without extra confirmations", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponse("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);
    const container = makeContainer({} as ServiceWorker);
    withContainer(container);

    installSwUpdate();
    container.dispatch("controllerchange");
    container.dispatch("controllerchange");
    container.dispatch("controllerchange");
    await vi.advanceTimersByTimeAsync(0);

    // Cooldown and in-flight guards collapse the burst into a single read.
    expect(versionReads(fetchSpy)).toHaveLength(1);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("can still detect a real deployment after an earlier check failed", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(versionResponse("build-C"));
    vi.stubGlobal("fetch", fetchSpy);
    const container = makeContainer({} as ServiceWorker);
    withContainer(container);

    installSwUpdate();
    container.dispatch("controllerchange");
    await vi.advanceTimersByTimeAsync(0);
    expect(reloadSpy).not.toHaveBeenCalled();

    // No permanent latch: the bridge did not disable itself over one unreadable check.
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    container.dispatch("controllerchange");
    await vi.advanceTimersByTimeAsync(0);
    expect(reloadSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    container.dispatch("controllerchange");
    await vi.advanceTimersByTimeAsync(0);

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps sending SKIP_WAITING for waiting and installing workers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponse("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);

    const waiting = { postMessage: vi.fn() } as unknown as ServiceWorker;
    const container = makeContainer({} as ServiceWorker, { waiting });
    withContainer(container);

    installSwUpdate();
    await vi.advanceTimersByTimeAsync(0);

    expect((waiting as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage)
      .toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });

  it("promotes an installing worker once it reaches the installed state", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponse("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);

    const stateListeners: Listener[] = [];
    const installing = {
      state: "installing",
      postMessage: vi.fn(),
      addEventListener: (_type: string, fn: Listener) => stateListeners.push(fn),
    } as unknown as ServiceWorker;
    const container = makeContainer({} as ServiceWorker, { installing });
    withContainer(container);

    installSwUpdate();
    await vi.advanceTimersByTimeAsync(0);

    (installing as unknown as { state: string }).state = "installed";
    stateListeners.forEach((fn) => fn());

    expect((installing as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage)
      .toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });

  /*
  FNXC:VersionAutoReload 2026-09-18-00:20:
  The worker bridge and the periodic checker must share ONE admission. Two independent observations
  reload once; the second trigger, arriving from the worker rather than the poll, does not get its own
  authority and does not produce a second reload.
  */
  it("shares one confirmation and one reload with the periodic checker", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponse("build-C"));
    vi.stubGlobal("fetch", fetchSpy);
    const container = makeContainer({} as ServiceWorker);
    withContainer(container);

    installVersionCheck();
    installSwUpdate();

    await vi.advanceTimersByTimeAsync(2_000); // initial poll observation
    expect(reloadSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    container.dispatch("controllerchange"); // second observation, same target
    await vi.advanceTimersByTimeAsync(0);

    expect(reloadSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    container.dispatch("controllerchange");
    await requestVersionCheck("service-worker");
    await checkVersion("poll");
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
