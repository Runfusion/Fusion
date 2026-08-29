import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AppUrlOpenListener = (event: { url: string }) => void;

const mockState = vi.hoisted(() => {
  const state: {
    isNativePlatform: ReturnType<typeof vi.fn>;
    addListener: ReturnType<typeof vi.fn>;
    appListenerRemove: ReturnType<typeof vi.fn>;
    appUrlOpenListener?: AppUrlOpenListener;
  } = {
    isNativePlatform: vi.fn(() => false),
    addListener: vi.fn(),
    appListenerRemove: vi.fn(async () => {}),
    appUrlOpenListener: undefined,
  };

  state.addListener.mockImplementation(
    async (eventName: string, callback: AppUrlOpenListener) => {
      if (eventName === "appUrlOpen") {
        state.appUrlOpenListener = callback;
      }
      return { remove: state.appListenerRemove };
    },
  );

  return state;
});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: mockState.isNativePlatform,
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: mockState.addListener,
  },
}));

import { DeepLinkManager } from "../plugins/deep-links.js";

const setupWindowMock = () => {
  const listeners = new Map<string, (event: Event) => void>();
  const location = { hash: "" };
  const addEventListener = vi.fn((event: string, handler: (evt: Event) => void) => {
    listeners.set(event, handler);
  });
  const removeEventListener = vi.fn((event: string, handler: (evt: Event) => void) => {
    const existing = listeners.get(event);
    if (existing === handler) {
      listeners.delete(event);
    }
  });

  vi.stubGlobal("window", {
    location,
    addEventListener,
    removeEventListener,
  });

  return {
    listeners,
    location,
    addEventListener,
    removeEventListener,
  };
};

describe("DeepLinkManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.isNativePlatform.mockReturnValue(false);
    mockState.appUrlOpenListener = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("URL parsing: fusion://task/FN-123", () => {
    const manager = new DeepLinkManager();

    const payload = manager.handleUrl("fusion://task/FN-123");

    expect(payload).toEqual({
      url: "fusion://task/FN-123",
      target: "task",
      taskId: "FN-123",
    });
  });

  it("URL parsing: fusion://project/my-project", () => {
    const manager = new DeepLinkManager();

    const payload = manager.handleUrl("fusion://project/my-project");

    expect(payload).toEqual({
      url: "fusion://project/my-project",
      target: "project",
      projectId: "my-project",
    });
  });

  it("URL parsing: fusion://project/my-project/task/FN-123", () => {
    const manager = new DeepLinkManager();

    const payload = manager.handleUrl("fusion://project/my-project/task/FN-123");

    expect(payload).toEqual({
      url: "fusion://project/my-project/task/FN-123",
      target: "project",
      projectId: "my-project",
      taskId: "FN-123",
    });
  });

  it("URL parsing: fusion://settings", () => {
    const manager = new DeepLinkManager();

    const payload = manager.handleUrl("fusion://settings");

    expect(payload).toEqual({
      url: "fusion://settings",
      target: "settings",
    });
  });

  it("URL parsing: fusion://agents", () => {
    const manager = new DeepLinkManager();

    const payload = manager.handleUrl("fusion://agents");

    expect(payload).toEqual({
      url: "fusion://agents",
      target: "agents",
    });
  });

  it("URL parsing: fusion://task/FN-123?tab=workflow", () => {
    const manager = new DeepLinkManager();

    const payload = manager.handleUrl("fusion://task/FN-123?tab=workflow");

    expect(payload).toEqual({
      url: "fusion://task/FN-123?tab=workflow",
      target: "task",
      taskId: "FN-123",
      params: { tab: "workflow" },
    });
  });

  it("URL parsing: universal link https://app.fusion.dev/?task=FN-123", () => {
    const manager = new DeepLinkManager({ universalLinkHosts: ["app.fusion.dev"] });

    const payload = manager.handleUrl("https://app.fusion.dev/?task=FN-123");

    expect(payload).toEqual({
      url: "https://app.fusion.dev/?task=FN-123",
      taskId: "FN-123",
      projectId: undefined,
      target: undefined,
    });
  });

  it("URL parsing: universal link from unrecognized host emits deeplink:error", () => {
    const manager = new DeepLinkManager({ universalLinkHosts: ["app.fusion.dev"] });
    const onError = vi.fn();
    manager.on("deeplink:error", onError);

    const payload = manager.handleUrl("https://untrusted.example/?task=FN-123");

    expect(payload).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://untrusted.example/?task=FN-123",
        error: expect.any(Error),
      }),
    );
  });

  it("URL parsing: malformed URL emits deeplink:error and handleUrl returns null", () => {
    const manager = new DeepLinkManager();
    const onError = vi.fn();
    manager.on("deeplink:error", onError);

    const payload = manager.handleUrl("not a url");

    expect(payload).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "not a url",
        error: expect.any(Error),
      }),
    );
  });

  it("URL parsing: original URL preserved in url field of all payloads", () => {
    const manager = new DeepLinkManager({ universalLinkHosts: ["app.fusion.dev"] });

    const customPayload = manager.handleUrl("fusion://task/FN-321");
    const universalPayload = manager.handleUrl(
      "https://app.fusion.dev/?task=FN-654&target=task",
    );

    expect(customPayload?.url).toBe("fusion://task/FN-321");
    expect(universalPayload?.url).toBe(
      "https://app.fusion.dev/?task=FN-654&target=task",
    );
  });

  it("Native listener: initialize() registers App.addListener(appUrlOpen) on native platform", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new DeepLinkManager();

    await manager.initialize();

    expect(mockState.addListener).toHaveBeenCalledWith("appUrlOpen", expect.any(Function));
  });

  it("Native listener: incoming appUrlOpen event is parsed and emits deeplink:received", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new DeepLinkManager();
    const onReceived = vi.fn();
    manager.on("deeplink:received", onReceived);

    await manager.initialize();
    mockState.appUrlOpenListener?.({ url: "fusion://task/FN-900" });

    expect(onReceived).toHaveBeenCalledWith({
      url: "fusion://task/FN-900",
      target: "task",
      taskId: "FN-900",
    });
  });

  it("Native listener: initialize() does NOT register App listener on non-native platform", async () => {
    mockState.isNativePlatform.mockReturnValue(false);
    const manager = new DeepLinkManager();
    setupWindowMock();

    await manager.initialize();

    expect(mockState.addListener).not.toHaveBeenCalled();
  });

  it("Browser listener: initialize() registers hashchange listener on non-native platform", async () => {
    const windowMock = setupWindowMock();
    const manager = new DeepLinkManager();

    await manager.initialize();

    expect(windowMock.addEventListener).toHaveBeenCalledWith("hashchange", expect.any(Function));
  });

  it("Browser listener: #deeplink=fusion://task/FN-123 hash change triggers deeplink:received event", async () => {
    const windowMock = setupWindowMock();
    const manager = new DeepLinkManager();
    const onReceived = vi.fn();
    manager.on("deeplink:received", onReceived);

    await manager.initialize();

    windowMock.location.hash = `#deeplink=${encodeURIComponent("fusion://task/FN-123")}`;
    const hashHandler = windowMock.listeners.get("hashchange");
    hashHandler?.(new Event("hashchange"));

    expect(onReceived).toHaveBeenCalledWith({
      url: "fusion://task/FN-123",
      target: "task",
      taskId: "FN-123",
    });
  });

  it("Lifecycle: initialize() is idempotent (second call is no-op)", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new DeepLinkManager();

    await manager.initialize();
    await manager.initialize();

    expect(mockState.addListener).toHaveBeenCalledTimes(1);
  });

  it("Lifecycle: getScheme() returns the configured scheme string", () => {
    const manager = new DeepLinkManager({ scheme: "fusion-custom://" });

    expect(manager.getScheme()).toBe("fusion-custom://");
  });

  it("Lifecycle: destroy() removes Capacitor App listener via handle.remove()", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new DeepLinkManager();

    await manager.initialize();
    await manager.destroy();

    expect(mockState.appListenerRemove).toHaveBeenCalledTimes(1);
  });

  it("Lifecycle: destroy() removes browser hashchange listener", async () => {
    const windowMock = setupWindowMock();
    const manager = new DeepLinkManager();

    await manager.initialize();
    await manager.destroy();

    expect(windowMock.removeEventListener).toHaveBeenCalledWith(
      "hashchange",
      expect.any(Function),
    );
  });

  it("Lifecycle: destroy() removes all EventEmitter listeners", async () => {
    const manager = new DeepLinkManager();
    const onReceived = vi.fn();
    manager.on("deeplink:received", onReceived);

    await manager.destroy();

    manager.emit("deeplink:received", { url: "fusion://task/FN-001" });
    expect(onReceived).not.toHaveBeenCalled();
  });
});
