// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBarManager } from "../plugins/status-bar.js";

const setStyleMock = vi.fn();

describe("StatusBarManager", () => {
  const originalMatchMedia = globalThis.window?.matchMedia;

  beforeEach(() => {
    vi.clearAllMocks();
    setStyleMock.mockResolvedValue(undefined);

    vi.stubGlobal("Capacitor", {
      Plugins: {
        StatusBar: {
          setStyle: setStyleMock,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (globalThis.window) {
      Object.defineProperty(globalThis.window, "matchMedia", {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("initialize() applies current theme", async () => {
    const manager = new StatusBarManager({ themeMode: "dark" });

    await manager.initialize();

    expect(setStyleMock).toHaveBeenCalledTimes(1);
    expect(setStyleMock).toHaveBeenCalledWith({ style: "DARK" });
  });

  it("setTheme('dark') sets dark style", async () => {
    const manager = new StatusBarManager({ themeMode: "light" });

    await manager.setTheme("dark");

    expect(setStyleMock).toHaveBeenCalledWith({ style: "DARK" });
    expect(manager.getTheme()).toBe("dark");
  });

  it("setTheme('light') sets light style", async () => {
    const manager = new StatusBarManager({ themeMode: "dark" });

    await manager.setTheme("light");

    expect(setStyleMock).toHaveBeenCalledWith({ style: "LIGHT" });
    expect(manager.getTheme()).toBe("light");
  });

  it("setTheme('system') detects system preference", async () => {
    const manager = new StatusBarManager();

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });

    await manager.setTheme("system");

    expect(setStyleMock).toHaveBeenLastCalledWith({ style: "DARK" });

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });

    await manager.setTheme("system");

    expect(setStyleMock).toHaveBeenLastCalledWith({ style: "LIGHT" });
  });

  it("onThemeChange callback fires on theme change", async () => {
    const manager = new StatusBarManager();
    const callback = vi.fn();

    manager.onThemeChange(callback);
    await manager.setTheme("dark");

    expect(callback).toHaveBeenCalledWith("dark");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("onThemeChange unsubscribe stops callbacks", async () => {
    const manager = new StatusBarManager();
    const callback = vi.fn();

    const unsubscribe = manager.onThemeChange(callback);
    await manager.setTheme("dark");
    unsubscribe();
    await manager.setTheme("light");

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("initialize() swallows errors", async () => {
    setStyleMock.mockRejectedValue(new Error("not available"));
    const manager = new StatusBarManager({ themeMode: "dark" });

    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(manager.isInitialized).toBe(true);
  });

  it("destroy() clears all listeners", async () => {
    const manager = new StatusBarManager();
    const callback = vi.fn();

    manager.onThemeChange(callback);
    await manager.destroy();
    await manager.setTheme("dark");

    expect(callback).not.toHaveBeenCalled();
    expect(manager.isInitialized).toBe(false);
  });
});
