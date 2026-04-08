import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SplashScreen } from "@capacitor/splash-screen";
import { SplashScreenManager } from "../plugins/splash-screen.js";

vi.mock("@capacitor/splash-screen", () => ({
  SplashScreen: {
    hide: vi.fn(),
    show: vi.fn(),
  },
}));

describe("SplashScreenManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SplashScreen.hide).mockResolvedValue(undefined);
    vi.mocked(SplashScreen.show).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initialize() with autoHide=true triggers hide after delay", async () => {
    vi.useFakeTimers();
    const manager = new SplashScreenManager({ autoHide: true, hideDelay: 100 });

    await manager.initialize();
    expect(SplashScreen.hide).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
    expect(SplashScreen.hide).toHaveBeenCalledWith({ fadeOutDuration: 300 });
  });

  it("initialize() with autoHide=false does not auto-hide", async () => {
    vi.useFakeTimers();
    const manager = new SplashScreenManager({ autoHide: false, hideDelay: 100 });

    await manager.initialize();
    await vi.advanceTimersByTimeAsync(500);

    expect(SplashScreen.hide).not.toHaveBeenCalled();
  });

  it("hide() delegates to SplashScreen.hide()", async () => {
    const manager = new SplashScreenManager();

    await manager.hide();

    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
    expect(SplashScreen.hide).toHaveBeenCalledWith({ fadeOutDuration: 300 });
  });

  it("show() delegates to SplashScreen.show()", async () => {
    const manager = new SplashScreenManager();

    await manager.show();

    expect(SplashScreen.show).toHaveBeenCalledTimes(1);
    expect(SplashScreen.show).toHaveBeenCalledWith({ autoHide: false });
  });

  it("initialize() is idempotent", async () => {
    vi.useFakeTimers();
    const manager = new SplashScreenManager({ autoHide: true, hideDelay: 50 });

    await manager.initialize();
    await manager.initialize();
    await vi.advanceTimersByTimeAsync(50);

    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
  });

  it("hide() swallows errors gracefully", async () => {
    vi.mocked(SplashScreen.hide).mockRejectedValue(new Error("unavailable"));
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
