import { beforeEach, describe, expect, it, vi } from "vitest";
import { Network } from "@capacitor/network";
import { NetworkManager } from "../plugins/network.js";

const { getStatusMock, addListenerMock, removeListenerMock } = vi.hoisted(() => ({
  getStatusMock: vi.fn(),
  addListenerMock: vi.fn(),
  removeListenerMock: vi.fn(),
}));

let networkStatusChangeHandler:
  | ((status: { connected: boolean; connectionType: "wifi" | "cellular" | "none" | "unknown" }) => void)
  | null = null;

vi.mock("@capacitor/network", () => ({
  Network: {
    getStatus: getStatusMock,
    addListener: addListenerMock,
  },
}));

describe("NetworkManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    networkStatusChangeHandler = null;

    getStatusMock.mockResolvedValue({
      connected: true,
      connectionType: "wifi",
    });

    removeListenerMock.mockResolvedValue(undefined);

    addListenerMock.mockImplementation(async (
      eventName: string,
      callback: (status: { connected: boolean; connectionType: "wifi" | "cellular" | "none" | "unknown" }) => void,
    ) => {
      if (eventName === "networkStatusChange") {
        networkStatusChangeHandler = callback;
      }
      return { remove: removeListenerMock };
    });
  });

  it("initialize() queries current network status", async () => {
    const manager = new NetworkManager();

    await manager.initialize();

    expect(Network.getStatus).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toEqual({ connected: true, connectionType: "wifi" });
  });

  it("startMonitoring() registers network listener", async () => {
    const manager = new NetworkManager();

    await manager.startMonitoring();

    expect(Network.addListener).toHaveBeenCalledTimes(1);
    expect(Network.addListener).toHaveBeenCalledWith("networkStatusChange", expect.any(Function));
    expect(manager.isMonitoring).toBe(true);
  });

  it("status change callback fires on network change", async () => {
    const manager = new NetworkManager();
    const callback = vi.fn();

    manager.onStatusChange(callback);
    await manager.initialize();

    networkStatusChangeHandler?.({ connected: false, connectionType: "none" });

    expect(callback).toHaveBeenCalled();
    expect(callback).toHaveBeenLastCalledWith({ connected: false, connectionType: "none" });
  });

  it("going offline triggers callback with connected=false", async () => {
    const manager = new NetworkManager();
    const callback = vi.fn();

    manager.onStatusChange(callback);
    await manager.initialize();

    networkStatusChangeHandler?.({ connected: false, connectionType: "none" });

    expect(callback).toHaveBeenCalledWith({ connected: false, connectionType: "none" });
    expect(manager.isOnline).toBe(false);
  });

  it("going online triggers callback with connected=true", async () => {
    getStatusMock.mockResolvedValue({ connected: false, connectionType: "none" });
    const manager = new NetworkManager();
    const callback = vi.fn();

    manager.onStatusChange(callback);
    await manager.initialize();

    networkStatusChangeHandler?.({ connected: true, connectionType: "wifi" });

    expect(callback).toHaveBeenCalledWith({ connected: true, connectionType: "wifi" });
    expect(manager.isOnline).toBe(true);
  });

  it("stopMonitoring() removes listener handle", async () => {
    const manager = new NetworkManager();

    await manager.initialize();
    await manager.stopMonitoring();

    expect(removeListenerMock).toHaveBeenCalledTimes(1);
    expect(manager.isMonitoring).toBe(false);
  });

  it("getStatus() returns copy (not reference)", async () => {
    const manager = new NetworkManager();

    await manager.initialize();

    const status = manager.getStatus();
    status.connected = false;
    status.connectionType = "none";

    expect(manager.getStatus()).toEqual({ connected: true, connectionType: "wifi" });
  });

  it("onStatusChange unsubscribe works", async () => {
    const manager = new NetworkManager();
    const callback = vi.fn();

    const unsubscribe = manager.onStatusChange(callback);
    await manager.initialize();
    unsubscribe();

    networkStatusChangeHandler?.({ connected: false, connectionType: "none" });

    expect(callback).not.toHaveBeenCalled();
  });

  it("initialize() swallows errors", async () => {
    getStatusMock.mockRejectedValue(new Error("network unavailable"));
    const manager = new NetworkManager();

    await expect(manager.initialize()).resolves.toBeUndefined();

    expect(manager.getStatus()).toEqual({ connected: true, connectionType: "unknown" });
  });

  it("destroy() stops monitoring and clears listeners", async () => {
    const manager = new NetworkManager();
    const callback = vi.fn();

    manager.onStatusChange(callback);
    await manager.initialize();
    await manager.destroy();

    networkStatusChangeHandler?.({ connected: false, connectionType: "none" });

    expect(removeListenerMock).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    expect(manager.isMonitoring).toBe(false);
    expect(manager.isInitialized).toBe(false);
  });
});
