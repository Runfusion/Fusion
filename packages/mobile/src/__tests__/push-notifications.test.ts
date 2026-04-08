import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const removeFns: Array<ReturnType<typeof vi.fn>> = [];

  const addListener = vi.fn(async (eventName: string, callback: (...args: any[]) => void) => {
    listeners.set(eventName, callback);
    const remove = vi.fn(async () => {});
    removeFns.push(remove);
    return { remove };
  });

  return {
    listeners,
    removeFns,
    addListener,
    requestPermissions: vi.fn(),
    register: vi.fn(),
    removeAllListeners: vi.fn(),
    isNativePlatform: vi.fn(() => false),
  };
});

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    requestPermissions: mockState.requestPermissions,
    register: mockState.register,
    addListener: mockState.addListener,
    removeAllListeners: mockState.removeAllListeners,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: mockState.isNativePlatform,
  },
}));

import { PushNotificationManager } from "../plugins/push-notifications.js";

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const invokeListener = (eventName: string, payload: unknown): void => {
  const listener = mockState.listeners.get(eventName);
  expect(listener, `Expected listener for ${eventName}`).toBeTypeOf("function");
  listener?.(payload);
};

const createLineStream = (lines: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
};

describe("PushNotificationManager — native push notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.listeners.clear();
    mockState.removeFns.length = 0;
    mockState.isNativePlatform.mockReturnValue(false);
  });

  it("requestPermission returns true and registers when permission is granted", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.requestPermissions.mockResolvedValue({ receive: "granted" });

    const manager = new PushNotificationManager();
    const result = await manager.requestPermission();

    expect(result).toBe(true);
    expect(mockState.register).toHaveBeenCalledTimes(1);
  });

  it("requestPermission returns false and does not register when denied", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.requestPermissions.mockResolvedValue({ receive: "denied" });

    const manager = new PushNotificationManager();
    const result = await manager.requestPermission();

    expect(result).toBe(false);
    expect(mockState.register).not.toHaveBeenCalled();
  });

  it("requestPermission emits permission:changed granted=true on success", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.requestPermissions.mockResolvedValue({ receive: "granted" });

    const manager = new PushNotificationManager();
    const permissionChanged = vi.fn();
    manager.on("permission:changed", permissionChanged);

    await manager.requestPermission();

    expect(permissionChanged).toHaveBeenCalledWith({ granted: true });
  });

  it("requestPermission emits permission:changed granted=false on denial", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    mockState.requestPermissions.mockResolvedValue({ receive: "prompt" });

    const manager = new PushNotificationManager();
    const permissionChanged = vi.fn();
    manager.on("permission:changed", permissionChanged);

    await manager.requestPermission();

    expect(permissionChanged).toHaveBeenCalledWith({ granted: false });
  });

  it("registration listener stores token and emits token:registered", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new PushNotificationManager();
    const onToken = vi.fn();
    manager.on("token:registered", onToken);

    await manager.initListeners();
    invokeListener("registration", { value: "device-token-123" });

    expect(onToken).toHaveBeenCalledWith({ token: "device-token-123" });
    expect(manager.getDeviceToken()).toBe("device-token-123");
  });

  it("registrationError listener emits permission:changed granted=false", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new PushNotificationManager();
    const permissionChanged = vi.fn();
    manager.on("permission:changed", permissionChanged);

    await manager.initListeners();
    invokeListener("registrationError", { error: "bad token" });

    expect(permissionChanged).toHaveBeenCalledWith({ granted: false });
  });

  it("pushNotificationReceived emits notification:received with parsed payload", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new PushNotificationManager();
    const received = vi.fn();
    manager.on("notification:received", received);

    await manager.initListeners();
    invokeListener("pushNotificationReceived", {
      title: "Task ready",
      body: "FN-321 is ready",
      data: { taskId: "FN-321", source: "native" },
    });

    expect(received).toHaveBeenCalledWith({
      title: "Task ready",
      body: "FN-321 is ready",
      taskId: "FN-321",
      data: { taskId: "FN-321", source: "native" },
    });
  });

  it("pushNotificationActionPerformed emits notification:tapped with taskId from data", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new PushNotificationManager();
    const tapped = vi.fn();
    manager.on("notification:tapped", tapped);

    await manager.initListeners();
    invokeListener("pushNotificationActionPerformed", {
      notification: {
        data: { taskId: "KB-404" },
      },
    });

    expect(tapped).toHaveBeenCalledWith({
      taskId: "KB-404",
      data: { taskId: "KB-404" },
    });
  });

  it("pushNotificationActionPerformed emits taskId undefined when payload has no taskId", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new PushNotificationManager();
    const tapped = vi.fn();
    manager.on("notification:tapped", tapped);

    await manager.initListeners();
    invokeListener("pushNotificationActionPerformed", {
      notification: {
        title: "General alert",
        body: "No task reference",
        data: { category: "system" },
      },
    });

    expect(tapped).toHaveBeenCalledWith({
      taskId: undefined,
      data: { category: "system" },
    });
  });
});

describe("PushNotificationManager — non-native platform behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.listeners.clear();
    mockState.removeFns.length = 0;
    mockState.isNativePlatform.mockReturnValue(false);
  });

  it("requestPermission returns false without invoking Capacitor APIs", async () => {
    const manager = new PushNotificationManager();

    const result = await manager.requestPermission();

    expect(result).toBe(false);
    expect(mockState.requestPermissions).not.toHaveBeenCalled();
    expect(mockState.register).not.toHaveBeenCalled();
  });

  it("initListeners does not register listeners when not on native platform", async () => {
    const manager = new PushNotificationManager();

    await manager.initListeners();

    expect(mockState.addListener).not.toHaveBeenCalled();
  });
});

describe("PushNotificationManager — ntfy subscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.listeners.clear();
    mockState.removeFns.length = 0;
    mockState.isNativePlatform.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("startNtfySubscription fetches {ntfyBaseUrl}/{topic}/json", async () => {
    const fetchMock = vi.fn(async () => new Response(createLineStream([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const manager = new PushNotificationManager({ ntfyBaseUrl: "https://ntfy.sh" });
    await manager.startNtfySubscription("my-topic");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ntfy.sh/my-topic/json",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("parses ntfy JSON lines and emits ntfy:message for event=message", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        createLineStream([
          JSON.stringify({
            id: "msg-1",
            event: "message",
            title: "Task FN-200 completed",
            message: "Ready for review",
            priority: 4,
          }),
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const manager = new PushNotificationManager();
    const messages: Array<Record<string, unknown>> = [];
    manager.on("ntfy:message", (payload) => messages.push(payload));

    await manager.startNtfySubscription("fusion-topic");

    expect(messages).toEqual([
      {
        id: "msg-1",
        title: "Task FN-200 completed",
        message: "Ready for review",
        priority: "high",
        clickUrl: undefined,
        event: "message",
        taskId: "FN-200",
      },
    ]);
  });

  it("skips non-message ntfy events", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        createLineStream([
          JSON.stringify({ event: "open", id: "sys-1" }),
          JSON.stringify({ event: "keepalive", id: "sys-2" }),
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const manager = new PushNotificationManager();
    const onMessage = vi.fn();
    manager.on("ntfy:message", onMessage);

    await manager.startNtfySubscription("fusion-topic");

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("extracts taskId from ntfy click URL query parameter", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        createLineStream([
          JSON.stringify({
            id: "msg-2",
            event: "message",
            title: "Task update",
            message: "Tap to open",
            click: "https://fusion.local/?task=KB-888",
            priority: 3,
          }),
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const manager = new PushNotificationManager();
    const onMessage = vi.fn();
    manager.on("ntfy:message", onMessage);

    await manager.startNtfySubscription("fusion-topic");

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "KB-888",
        clickUrl: "https://fusion.local/?task=KB-888",
      }),
    );
  });

  it("extracts taskId from title/message regex fallback when click URL is absent", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        createLineStream([
          JSON.stringify({
            id: "msg-3",
            event: "message",
            title: "Task KB-123 moved",
            message: "Status changed",
            priority: 3,
          }),
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const manager = new PushNotificationManager();
    const onMessage = vi.fn();
    manager.on("ntfy:message", onMessage);

    await manager.startNtfySubscription("fusion-topic");

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ taskId: "KB-123" }));
  });

  it("stopNtfySubscription aborts active fetch request", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>(() => {
        expect(init?.signal).toBeDefined();
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const manager = new PushNotificationManager();
    void manager.startNtfySubscription("fusion-topic");
    await flushPromises();

    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    manager.stopNtfySubscription();

    expect(signal.aborted).toBe(true);
  });

  it("handles fetch errors gracefully without throwing", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new PushNotificationManager();

    await expect(manager.startNtfySubscription("fusion-topic")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("PushNotificationManager — settings poll and lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockState.listeners.clear();
    mockState.removeFns.length = 0;
    mockState.isNativePlatform.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts ntfy subscription when settings enable ntfy", async () => {
    const settingsFetcher = vi.fn().mockResolvedValue({ ntfyEnabled: true, ntfyTopic: "alpha" });
    const manager = new PushNotificationManager({ settingsFetcher, ntfyPollIntervalMs: 1_000 });
    const startSpy = vi
      .spyOn(manager, "startNtfySubscription")
      .mockImplementation(async (topic: string) => {
        (manager as any).ntfyCurrentTopic = topic;
      });

    manager.startSettingsPoll();
    await flushPromises();

    expect(startSpy).toHaveBeenCalledWith("alpha");
  });

  it("stops ntfy subscription when settings disable ntfy", async () => {
    const settingsFetcher = vi
      .fn()
      .mockResolvedValueOnce({ ntfyEnabled: true, ntfyTopic: "alpha" })
      .mockResolvedValueOnce({ ntfyEnabled: false, ntfyTopic: "alpha" });

    const manager = new PushNotificationManager({ settingsFetcher, ntfyPollIntervalMs: 1_000 });
    vi.spyOn(manager, "startNtfySubscription").mockImplementation(async (topic: string) => {
      (manager as any).ntfyCurrentTopic = topic;
    });
    const stopSpy = vi.spyOn(manager, "stopNtfySubscription");

    manager.startSettingsPoll();
    await flushPromises();

    vi.advanceTimersByTime(1_000);
    await flushPromises();

    expect(stopSpy).toHaveBeenCalled();
  });

  it("restarts ntfy subscription when topic changes", async () => {
    const settingsFetcher = vi
      .fn()
      .mockResolvedValueOnce({ ntfyEnabled: true, ntfyTopic: "alpha" })
      .mockResolvedValueOnce({ ntfyEnabled: true, ntfyTopic: "beta" });

    const manager = new PushNotificationManager({ settingsFetcher, ntfyPollIntervalMs: 1_000 });
    const startSpy = vi
      .spyOn(manager, "startNtfySubscription")
      .mockImplementation(async (topic: string) => {
        (manager as any).ntfyCurrentTopic = topic;
      });

    manager.startSettingsPoll();
    await flushPromises();

    vi.advanceTimersByTime(1_000);
    await flushPromises();

    expect(startSpy).toHaveBeenNthCalledWith(1, "alpha");
    expect(startSpy).toHaveBeenNthCalledWith(2, "beta");
  });

  it("start() calls initListeners, requestPermission, and startSettingsPoll", async () => {
    const manager = new PushNotificationManager({
      settingsFetcher: vi.fn().mockResolvedValue({ ntfyEnabled: false }),
    });
    const initSpy = vi.spyOn(manager, "initListeners").mockResolvedValue();
    const permissionSpy = vi.spyOn(manager, "requestPermission").mockResolvedValue(false);
    const settingsSpy = vi.spyOn(manager, "startSettingsPoll").mockImplementation(() => {});

    await manager.start();

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(permissionSpy).toHaveBeenCalledTimes(1);
    expect(settingsSpy).toHaveBeenCalledTimes(1);
  });

  it("destroy() removes listeners, stops subscription, clears interval, and removes event listeners", async () => {
    mockState.isNativePlatform.mockReturnValue(true);
    const manager = new PushNotificationManager({
      settingsFetcher: vi.fn().mockResolvedValue({ ntfyEnabled: false }),
      ntfyPollIntervalMs: 1_000,
    });

    await manager.initListeners();
    manager.startSettingsPoll();
    await flushPromises();

    (manager as any).ntfyAbortController = new AbortController();
    (manager as any).ntfyCurrentTopic = "alpha";

    const stopSpy = vi.spyOn(manager, "stopNtfySubscription");
    const tappedListener = vi.fn();
    manager.on("notification:tapped", tappedListener);

    const removeFns = [...mockState.removeFns];
    await manager.destroy();

    for (const remove of removeFns) {
      expect(remove).toHaveBeenCalledTimes(1);
    }

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect((manager as any).settingsInterval).toBeNull();
    expect((manager as any).ntfyAbortController).toBeNull();
    expect((manager as any).ntfyCurrentTopic).toBeUndefined();

    manager.emit("notification:tapped", { taskId: "FN-1117" });
    expect(tappedListener).not.toHaveBeenCalled();
  });
});
