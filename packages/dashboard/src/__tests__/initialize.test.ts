import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializePlugins } from "../plugins/index.js";

const splashCtorMock = vi.fn();
const splashInitializeMock = vi.fn();
const splashDestroyMock = vi.fn();

const statusCtorMock = vi.fn();
const statusInitializeMock = vi.fn();
const statusDestroyMock = vi.fn();

const networkCtorMock = vi.fn();
const networkInitializeMock = vi.fn();
const networkStopMonitoringMock = vi.fn();
const networkDestroyMock = vi.fn();

vi.mock("../plugins/splash-screen.js", () => ({
  SplashScreenManager: vi.fn().mockImplementation(function (options) {
    splashCtorMock(options);
    this.initialize = splashInitializeMock;
    this.destroy = splashDestroyMock;
  }),
}));

vi.mock("../plugins/status-bar.js", () => ({
  StatusBarManager: vi.fn().mockImplementation(function (options) {
    statusCtorMock(options);
    this.initialize = statusInitializeMock;
    this.destroy = statusDestroyMock;
  }),
}));

vi.mock("../plugins/network.js", () => ({
  NetworkManager: vi.fn().mockImplementation(function () {
    networkCtorMock();
    this.initialize = networkInitializeMock;
    this.stopMonitoring = networkStopMonitoringMock;
    this.destroy = networkDestroyMock;
  }),
}));

describe("initializePlugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    splashInitializeMock.mockResolvedValue(undefined);
    splashDestroyMock.mockResolvedValue(undefined);

    statusInitializeMock.mockResolvedValue(undefined);
    statusDestroyMock.mockResolvedValue(undefined);

    networkInitializeMock.mockResolvedValue(undefined);
    networkStopMonitoringMock.mockResolvedValue(undefined);
    networkDestroyMock.mockResolvedValue(undefined);
  });

  it("initializePlugins() returns all managers", async () => {
    const { splashScreen, statusBar, network } = await initializePlugins();

    expect(splashScreen).toBeDefined();
    expect(statusBar).toBeDefined();
    expect(network).toBeDefined();
  });

  it("initializePlugins() reports success for all plugins", async () => {
    const { result } = await initializePlugins();

    expect(result.splashScreen).toBe(true);
    expect(result.statusBar).toBe(true);
    expect(result.network).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("initializePlugins() passes options to managers", async () => {
    await initializePlugins({
      splashAutoHide: false,
      splashHideDelay: 1500,
      themeMode: "dark",
      startNetworkMonitoring: false,
    });

    expect(splashCtorMock).toHaveBeenCalledWith({ autoHide: false, hideDelay: 1500 });
    expect(statusCtorMock).toHaveBeenCalledWith({ themeMode: "dark" });
    expect(networkCtorMock).toHaveBeenCalledTimes(1);
    expect(networkStopMonitoringMock).toHaveBeenCalledTimes(1);
  });

  it("initializePlugins() continues if one manager fails", async () => {
    statusInitializeMock.mockRejectedValue(new Error("status failed"));

    const { result } = await initializePlugins();

    expect(result.splashScreen).toBe(true);
    expect(result.statusBar).toBe(false);
    expect(result.network).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.plugin).toBe("statusBar");
    expect(result.errors[0]?.error.message).toBe("status failed");
  });

  it("initializePlugins() collects errors without throwing", async () => {
    splashInitializeMock.mockRejectedValue(new Error("splash failed"));
    networkInitializeMock.mockRejectedValue("network failed");

    const execution = initializePlugins();

    await expect(execution).resolves.toBeDefined();

    const { result } = await execution;
    expect(result.splashScreen).toBe(false);
    expect(result.statusBar).toBe(true);
    expect(result.network).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.plugin).toBe("splashScreen");
    expect(result.errors[1]?.plugin).toBe("network");
    expect(result.errors[1]?.error).toBeInstanceOf(Error);
  });
});
