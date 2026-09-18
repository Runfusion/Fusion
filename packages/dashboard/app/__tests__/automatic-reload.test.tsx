/**
 * @vitest-environment jsdom
 */
/*
FNXC:VersionAutoReload 2026-09-18-00:20:
FN-516 chain proof. The reported symptom is "the app refreshes the page by itself although nothing was
deployed", and it could only be produced by the pieces acting TOGETHER: the real service worker
answering `/version.json` from durable Cache Storage, the real checker believing that answer, and the
real worker/chunk bridges reaching `location.reload()` on their own.

So this suite deliberately mocks none of those decisions. It runs the actual `public/sw.js` in a vm
over a persistent cache, the actual `installVersionCheck`/`checkVersion`, the actual `installSwUpdate`,
the actual `handleChunkLoadError`, and the actual SSE bus, and observes `location.reload` plus the DOM.
A test that mocked `reloadOnce` (or the reload decision) would have passed against the defect.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { act, useEffect, useRef, useState } from "react";
import { MockEventSource } from "../../vitest.setup";
import { subscribeSse, __resetSseBus } from "../sse-bus";
import {
  checkVersion,
  consumeVersionUpdateFlag,
  handleChunkLoadError,
  installVersionCheck,
  requestVersionCheck,
  MIN_CHECK_INTERVAL_MS,
  POLL_INTERVAL_MS,
  _resetState,
} from "../versionCheck";
import { installSwUpdate } from "../swUpdate";
import {
  loadServiceWorker,
  makeRequest,
  makeResponse,
  type FakeResponse,
} from "../test/serviceWorkerHarness";

const RUNNING_BUILD = "build-B";
vi.stubGlobal("__BUILD_VERSION__", RUNNING_BUILD);

const VERSION_PATH = "/version.json";
const ORIGIN = "https://fusion.test";

type SwHarness = ReturnType<typeof loadServiceWorker>;

/**
 * Wire the page's `fetch` to the installed service worker, exactly as a controlled document is wired
 * in a browser: every request goes through the worker's fetch handler first, and falls through to the
 * network only when the worker declines to answer.
 */
function installControlledFetch(worker: SwHarness): ReturnType<typeof vi.fn> {
  const pageFetch = vi.fn(async (input: string, _init?: unknown) => {
    const url = String(input);
    const absolute = url.startsWith("http") ? url : `${ORIGIN}${url}`;
    return worker.browserFetch(makeRequest(absolute));
  });
  vi.stubGlobal("fetch", pageFetch);
  return pageFetch;
}

function versionBody(version: string): FakeResponse {
  const response: FakeResponse = {
    ok: true,
    body: JSON.stringify({ version }),
    clone: () => response,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
  };
  // `checkVersion` reads `res.json()`; the harness response type is intentionally minimal.
  return Object.assign(response, { json: async () => JSON.parse(response.body) }) as FakeResponse;
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

type FakeContainer = {
  controller: ServiceWorker | null;
  addEventListener: (type: string, fn: () => void) => void;
  register: (url: string) => Promise<ServiceWorkerRegistration>;
  dispatch: (type: string) => void;
};

function installServiceWorkerContainer(controller: ServiceWorker | null): FakeContainer {
  const listeners = new Map<string, Set<() => void>>();
  const container: FakeContainer = {
    controller,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    register: vi.fn().mockResolvedValue({
      scope: "/",
      installing: null,
      waiting: null,
      addEventListener: vi.fn(),
    } as unknown as ServiceWorkerRegistration),
    dispatch(type) {
      listeners.get(type)?.forEach((fn) => fn());
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { ...globalThis.navigator, serviceWorker: container },
    configurable: true,
  });
  return container;
}

/**
 * A minimal, realistic page: a controlled text field the user is typing in, an SSE subscription, and a
 * mount counter. Losing the draft or bumping the counter is what "the page refreshed by itself" MEANS
 * to the operator, so the proof asserts on those and not merely on a reload spy.
 */
function TypingProbe({ onMount }: { onMount: () => void }): React.ReactElement {
  const [draft, setDraft] = useState("");
  const [events, setEvents] = useState(0);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      onMount();
    }
    return subscribeSse("/api/events?projectId=fn-516", {
      replaySafe: { reason: "probe" },
      events: { "task:updated": () => setEvents((n) => n + 1) },
    });
  }, [onMount]);

  return (
    <div>
      <input
        data-testid="draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <span data-testid="events">{events}</span>
    </div>
  );
}

describe("automatic reload chain", () => {
  const reloadSpy = vi.fn();
  let originalNavigator: Navigator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("PROD", true);
    originalNavigator = globalThis.navigator;
    vi.stubGlobal("location", { reload: reloadSpy, href: `${ORIGIN}/` });
    reloadSpy.mockClear();
    window.sessionStorage.clear();
    _resetState();
    __resetSseBus();
    MockEventSource.instances = [];
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    _resetState();
    __resetSseBus();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
    vi.stubGlobal("__BUILD_VERSION__", RUNNING_BUILD);
  });

  /*
  FNXC:VersionAutoReload 2026-09-18-00:20:
  The exact reported reproduction. Cache Storage still holds build A from an earlier session, the page
  and the server are both on build B, and nothing is deployed for the duration of the test. Before the
  fix the worker answered A from its own cache twice and the checker reloaded the page.
  */
  it("never reloads when an older version is cached and the served build never changes", async () => {
    const store = new Map<string, FakeResponse>();
    store.set(`${ORIGIN}${VERSION_PATH}`, makeResponse(JSON.stringify({ version: "build-A" })));
    const worker = loadServiceWorker(store, { respond: () => versionBody(RUNNING_BUILD) });
    installControlledFetch(worker);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000); // initial
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // poll
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("fusion:version-update")).toBeNull();
    expect(consumeVersionUpdateFlag()).toBe(false);
  });

  /*
  FNXC:VersionAutoReload 2026-09-18-00:20:
  The upgrade path specifically: the page may still be controlled by an OLD worker generation whose
  cache-first rule this task cannot retroactively change. The per-attempt key is what makes a fresh
  read reach the network through such a worker, so this models one and then the new generation.
  */
  it("reads the live version through a still-controlling old cache-first worker", async () => {
    const legacyCache = new Map<string, string>();
    const legacyWorkerFetch = vi.fn(async (input: string) => {
      const url = String(input);
      if (!legacyCache.has(url)) legacyCache.set(url, RUNNING_BUILD);
      return versionBody(legacyCache.get(url)!);
    });
    vi.stubGlobal("fetch", legacyWorkerFetch);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    // Two distinct keys means the old worker could not answer the second read from the first entry.
    expect(legacyCache.size).toBe(2);
    expect(reloadSpy).not.toHaveBeenCalled();

    // The new generation takes over and remembers nothing at all.
    const worker = loadServiceWorker(undefined, { respond: () => versionBody(RUNNING_BUILD) });
    installControlledFetch(worker);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(worker.store.size).toBe(0);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("does not reload on a controller change or a chunk error while the build is unchanged", async () => {
    const worker = loadServiceWorker(undefined, { respond: () => versionBody(RUNNING_BUILD) });
    installControlledFetch(worker);
    const container = installServiceWorkerContainer({} as ServiceWorker);

    installVersionCheck();
    installSwUpdate();
    await vi.advanceTimersByTimeAsync(2_000);

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    container.dispatch("controllerchange");
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    expect(handleChunkLoadError(new Error("Failed to fetch dynamically imported module: /assets/x.js"))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(consumeVersionUpdateFlag()).toBe(false);
  });

  /*
  FNXC:VersionAutoReload 2026-09-18-00:20:
  Document preservation, which is the user-visible half of the requirement. A reload spy alone cannot
  prove the page survived; these assertions hold the typed draft, the input node identity, and the
  mount count across the same burst of events.
  */
  it.each([
    ["desktop", 1280, 800],
    ["phone", 390, 844],
    ["touch tablet", 1024, 768],
  ])("keeps the %s page, its draft, and its input node across reconnects and events", async (_label, width, height) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });

    const worker = loadServiceWorker(undefined, { respond: () => versionBody(RUNNING_BUILD) });
    installControlledFetch(worker);
    const container = installServiceWorkerContainer({} as ServiceWorker);
    const onMount = vi.fn();

    render(<TypingProbe onMount={onMount} />);
    installVersionCheck();
    installSwUpdate();
    await vi.advanceTimersByTimeAsync(2_000);

    const input = screen.getByTestId("draft") as HTMLInputElement;
    for (const char of "bonjour") {
      fireEvent.change(input, { target: { value: input.value + char } });
    }
    expect(input.value).toBe("bonjour");

    const source = MockEventSource.instances.at(-1)!;
    act(() => {
      source._emit("open");
      source._emit("task:updated", {});
      source._emit("task:updated", {});
      source._emit("task:updated", {});
    });

    window.dispatchEvent(new Event("focus"));
    setVisibility("hidden");
    setVisibility("visible");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    container.dispatch("controllerchange");
    await vi.advanceTimersByTimeAsync(0);

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("draft")).toBe(input);
    expect((screen.getByTestId("draft") as HTMLInputElement).value).toBe("bonjour");
    expect(screen.getByTestId("events").textContent).toBe("3");
  });

  it("keeps the page when no service worker is present at all", async () => {
    const bare = Object.create(Object.getPrototypeOf(globalThis.navigator) as object) as Navigator;
    Object.defineProperty(globalThis, "navigator", { value: bare, configurable: true });
    expect("serviceWorker" in globalThis.navigator).toBe(false);
    const pageFetch = vi.fn(async () => versionBody(RUNNING_BUILD));
    vi.stubGlobal("fetch", pageFetch);

    installVersionCheck();
    installSwUpdate(); // no-op without serviceWorker support
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(reloadSpy).not.toHaveBeenCalled();
  });

  /*
  FNXC:VersionAutoReload 2026-09-18-00:20:
  Positive control. The fix must not have been "stop reloading": when the network genuinely starts
  serving a different build, two independent observations admit exactly ONE reload and the update
  marker is consumable exactly once (that marker is what makes DashboardLoader drop hydration caches).
  */
  it("reloads exactly once when the served build really changes", async () => {
    const worker = loadServiceWorker(undefined, { respond: () => versionBody(RUNNING_BUILD) });
    installControlledFetch(worker);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reloadSpy).not.toHaveBeenCalled();

    // A real deployment lands.
    worker.setNetworkResponder(() => versionBody("build-C"));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // first observation of C
    expect(reloadSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // confirmation
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(consumeVersionUpdateFlag()).toBe(true);
    expect(consumeVersionUpdateFlag()).toBe(false);
  });

  it("does not duplicate an admitted reload under a burst of triggers", async () => {
    const worker = loadServiceWorker(undefined, { respond: () => versionBody("build-C") });
    installControlledFetch(worker);
    const container = installServiceWorkerContainer({} as ServiceWorker);

    installVersionCheck();
    installSwUpdate();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // The document latch holds even though installVersionCheck clears the session flag at 5s.
    window.sessionStorage.removeItem("fusion:version-reload");
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
      container.dispatch("controllerchange");
      handleChunkLoadError(new Error("ChunkLoadError: loading chunk foo failed"));
      window.dispatchEvent(new Event("focus"));
      await requestVersionCheck("poll");
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("is not corrupted by an old read settling while a newer poll is active", async () => {
    let releaseFirst: ((value: FakeResponse) => void) | null = null;
    const pageFetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<FakeResponse>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue(versionBody(RUNNING_BUILD));
    vi.stubGlobal("fetch", pageFetch);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);

    // The tab leaves and returns, which invalidates the read in flight.
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    // The abandoned read finally answers with a different build; it must change nothing.
    releaseFirst?.(versionBody("build-C"));
    await vi.advanceTimersByTimeAsync(0);

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(consumeVersionUpdateFlag()).toBe(false);
  });

  it("marks no update when there is no difference and no proof", async () => {
    const worker = loadServiceWorker(undefined, {
      respond: () => {
        throw new Error("offline");
      },
    });
    installControlledFetch(worker);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(consumeVersionUpdateFlag()).toBe(false);
  });
});
