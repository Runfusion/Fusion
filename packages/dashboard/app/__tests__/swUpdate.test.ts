/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../versionCheck", () => ({
  reloadOnce: vi.fn(),
}));

import { reloadOnce } from "../versionCheck";
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

function makeContainer(controller: ServiceWorker | null): FakeServiceWorkerContainer {
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
    } as unknown as ServiceWorkerRegistration),
    dispatch(type) {
      listeners.get(type)?.forEach((fn) => fn());
    },
  };
}

describe("installSwUpdate", () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.stubEnv("PROD", true);
    vi.mocked(reloadOnce).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("does NOT reload on first install (no prior controller)", () => {
    const container = makeContainer(null);
    withContainer(container);

    installSwUpdate();
    container.dispatch("controllerchange");

    expect(reloadOnce).not.toHaveBeenCalled();
  });

  it("reloads when an existing controller is replaced", () => {
    const container = makeContainer({} as ServiceWorker);
    withContainer(container);

    installSwUpdate();
    container.dispatch("controllerchange");

    expect(reloadOnce).toHaveBeenCalledTimes(1);
    expect(reloadOnce).toHaveBeenCalledWith("service worker activated new version");
  });

  it("reloads at most once across multiple controllerchange events", () => {
    const container = makeContainer({} as ServiceWorker);
    withContainer(container);

    installSwUpdate();
    container.dispatch("controllerchange");
    container.dispatch("controllerchange");

    expect(reloadOnce).toHaveBeenCalledTimes(1);
  });
});
