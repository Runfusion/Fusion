import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SplashScreenManager } from "../plugins/splash-screen.js";

const hideMock = vi.fn();
const showMock = vi.fn();

describe("SplashScreenManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hideMock.mockResolvedValue(undefined);
    showMock.mockResolvedValue(undefined);

    vi.stubGlobal("Capacitor", {
      Plugins: {
        SplashScreen: {
          hide: hideMock,
          show: showMock,
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("initialize() with autoHide=true triggers hide after delay", async () => {
    vi.useFakeTimers();
    const manager = new SplashScreenManager({ autoHide: true, hideDelay: 100 });

    await manager.initialize();
    expect(hideMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(hideMock).toHaveBeenCalledTimes(1);
    expect(hideMock).toHaveBeenCalledWith({ fadeOutDuration: 300 });
  });

  it("initialize() with autoHide=false does not auto-hide", async () => {
    vi.useFakeTimers();
    const manager = new SplashScreenManager({ autoHide: false, hideDelay: 100 });

    await manager.initialize();
    await vi.advanceTimersByTimeAsync(500);

    expect(hideMock).not.toHaveBeenCalled();
  });

  it("hide() delegates to SplashScreen.hide()", async () => {
    const manager = new SplashScreenManager();

    await manager.hide();

    expect(hideMock).toHaveBeenCalledTimes(1);
    expect(hideMock).toHaveBeenCalledWith({ fadeOutDuration: 300 });
  });

  it("show() delegates to SplashScreen.show()", async () => {
    const manager = new SplashScreenManager();

    await manager.show();

    expect(showMock).toHaveBeenCalledTimes(1);
    expect(showMock).toHaveBeenCalledWith({ autoHide: false });
  });

  it("initialize() is idempotent", async () => {
    vi.useFakeTimers();
    const manager = new SplashScreenManager({ autoHide: true, hideDelay: 50 });

    await manager.initialize();
    await manager.initialize();
    await vi.advanceTimersByTimeAsync(50);

    expect(hideMock).toHaveBeenCalledTimes(1);
  });

  it("hide() swallows errors gracefully", async () => {
    hideMock.mockRejectedValue(new Error("unavailable"));
    const manager = new SplashScreenManager();

    await expect(manager.hide()).resolves.toBeUndefined();
  });

  it("destroy() resets initialized state", async () => {
    const manager = new SplashScreenManager({ autoHide: false });
    await manager.initialize();

    expect(manager.isInitialized).toBe(true);

    await manager.destroy();

    expect(manager.isInitialized).toBe(false);
  });
});
