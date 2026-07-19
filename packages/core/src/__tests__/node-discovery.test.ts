import { EventEmitter } from "node:events";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DiscoveryConfig, DiscoveredNode } from "../types.js";

interface MockBrowser {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

const { BonjourMock, publishMock, findMock, destroyMock } = vi.hoisted(() => ({
  BonjourMock: vi.fn(),
  publishMock: vi.fn(),
  findMock: vi.fn(),
  destroyMock: vi.fn(),
}));

vi.mock("bonjour-service", () => ({
  Bonjour: BonjourMock,
  default: BonjourMock,
}));

import { NodeDiscovery } from "../node-discovery.js";

function createMockBrowser(): MockBrowser {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const browser: MockBrowser = {
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const callbacks = listeners.get(event) ?? new Set();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return browser;
    }),
    off: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(callback);
      return browser;
    }),
    stop: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      for (const callback of listeners.get(event) ?? []) {
        callback(...args);
      }
    },
  };

  return browser;
}

function defaultConfig(overrides: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  return {
    broadcast: false,
    listen: false,
    serviceType: "_fusion._tcp",
    port: 4040,
    staleTimeoutMs: 300_000,
    ...overrides,
  };
}

function createService(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "peer-node",
    port: 4040,
    addresses: ["192.168.1.200"],
    txt: {
      nodeType: "remote",
      nodeId: "node_remote_1",
    },
    ...overrides,
  };
}

describe("NodeDiscovery", () => {
  let browser: MockBrowser;
  let publishService: EventEmitter & { stop: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    browser = createMockBrowser();
    publishService = Object.assign(new EventEmitter(), { stop: vi.fn() });

    publishMock.mockReturnValue(publishService);
    findMock.mockReturnValue(browser);
    destroyMock.mockReturnValue(undefined);
    BonjourMock.mockImplementation(function () {
      return {
        publish: publishMock,
        find: findMock,
        destroy: destroyMock,
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts and stops broadcast mode", () => {
    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true }));
    discovery.start("node_local_1", "Local Node");

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Local Node-_local_1",
        type: "fusion",
        protocol: "tcp",
        port: 4040,
        txt: expect.objectContaining({
          nodeType: "local",
          nodeId: "node_local_1",
          version: expect.any(String),
        }),
      }),
    );

    discovery.stop();
    expect(publishService.stop).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to hostname when broadcast nodeName is empty", () => {
    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true }));
    discovery.start("node_local_1", "   ");

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/-_local_1$/),
      }),
    );
  });

  it.each([
    ["   ", "node_local_1", "fusion-delocal1"],
    ["A very long local node name that is not used as the mDNS host", "node_abcdefghijk", "fusion-defghijk"],
    ["Local", "id", "fusion-id"],
  ])("publishes a Fusion-owned host for nodeName %j and nodeId %j", (nodeName, nodeId, expectedHost) => {
    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true }));
    discovery.start(nodeId, nodeName);

    const config = publishMock.mock.calls[0]?.[0] as { host?: string };
    expect(config.host).toBe(expectedHost);
    expect(config.host).toMatch(/^fusion-[a-z0-9-]+$/);
    expect(config.host?.replace(/\.local\.?$/i, "").toLowerCase()).not.toBe(
      os.hostname().replace(/\.local\.?$/i, "").toLowerCase(),
    );
  });

  it("never publishes the OS hostname when it matches the naïve Fusion host", () => {
    vi.spyOn(os, "hostname").mockReturnValue("fusion-delocal1.local");
    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true }));
    discovery.start("node_local_1", "Local");

    const config = publishMock.mock.calls[0]?.[0] as { host?: string };
    expect(config.host).toBe("fusion-delocal1-service");
    expect(config.host?.replace(/\.local\.?$/i, "").toLowerCase()).not.toBe(
      os.hostname().replace(/\.local\.?$/i, "").toLowerCase(),
    );
  });

  it("starts listen mode and emits node:discovered/node:lost", () => {
    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));
    const discoveredHandler = vi.fn();
    const lostHandler = vi.fn();

    discovery.on("node:discovered", discoveredHandler);
    discovery.on("node:lost", lostHandler);

    discovery.start("node_local_1", "Local");

    expect(findMock).toHaveBeenCalledWith({
      type: "fusion",
      protocol: "tcp",
    });

    browser.emit("up", createService());

    expect(discoveredHandler).toHaveBeenCalledTimes(1);
    expect(discoveredHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "peer-node",
        host: "192.168.1.200",
        port: 4040,
        nodeType: "remote",
        nodeId: "node_remote_1",
        discoveredAt: expect.any(String),
        lastSeenAt: expect.any(String),
      }),
    );

    browser.emit("down", createService());
    expect(lostHandler).toHaveBeenCalledWith("peer-node");
  });

  it("ignores down events for unknown services", () => {
    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));
    const lostHandler = vi.fn();
    discovery.on("node:lost", lostHandler);

    discovery.start("node_local_1", "Local");
    browser.emit("down", createService({ name: "missing-node" }));

    expect(lostHandler).not.toHaveBeenCalled();
  });

  it("emits node:updated for already known services", () => {
    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));
    const updatedHandler = vi.fn();

    discovery.on("node:updated", updatedHandler);
    discovery.start("node_local_1", "Local");

    browser.emit("up", createService());
    browser.emit("up", createService({ addresses: ["192.168.1.201"] }));

    expect(updatedHandler).toHaveBeenCalledTimes(1);
    expect(updatedHandler).toHaveBeenCalledWith(
      expect.objectContaining({ host: "192.168.1.201" }),
    );
  });

  it("self-filters discovery events with matching nodeId", () => {
    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));
    const discoveredHandler = vi.fn();

    discovery.on("node:discovered", discoveredHandler);
    discovery.start("node_local_1", "Local");

    browser.emit(
      "up",
      createService({
        txt: {
          nodeType: "local",
          nodeId: "node_local_1",
        },
      }),
    );

    expect(discoveredHandler).not.toHaveBeenCalled();
    expect(discovery.getDiscoveredNodes()).toEqual([]);
  });

  it("supports combined broadcast + listen mode", () => {
    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true, listen: true }));

    discovery.start("node_local_1", "Local Node");

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(findMock).toHaveBeenCalledTimes(1);
  });

  it("cleans up stale nodes after staleTimeoutMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));

    const discovery = new NodeDiscovery(defaultConfig({ listen: true, staleTimeoutMs: 1_000 }));
    const lostHandler = vi.fn();

    discovery.on("node:lost", lostHandler);
    discovery.start("node_local_1", "Local");

    browser.emit("up", createService({ name: "stale-node" }));
    expect(discovery.getDiscoveredNode("stale-node")).toBeDefined();

    vi.advanceTimersByTime(61_000);

    expect(discovery.getDiscoveredNode("stale-node")).toBeUndefined();
    expect(lostHandler).toHaveBeenCalledWith("stale-node");
  });

  it("stop() is idempotent", () => {
    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true, listen: true }));

    discovery.start("node_local_1", "Local");
    expect(() => discovery.stop()).not.toThrow();
    expect(() => discovery.stop()).not.toThrow();

    expect(publishService.stop).toHaveBeenCalledTimes(1);
    expect(browser.stop).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("startBroadcast() and startListening() are idempotent", () => {
    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true, listen: true }));

    discovery.startBroadcast("node_local_1", "Local");
    discovery.startBroadcast("node_local_1", "Local");
    discovery.startListening();
    discovery.startListening();

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(findMock).toHaveBeenCalledTimes(1);
  });

  it("continues when broadcast publish throws and emits error", () => {
    const error = new Error("multicast unavailable");
    publishMock.mockImplementation(() => {
      throw error;
    });

    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true }));
    const errorHandler = vi.fn();

    discovery.on("error", errorHandler);

    expect(() => discovery.start("node_local_1", "Local")).not.toThrow();
    expect(errorHandler).toHaveBeenCalledWith(error);
  });

  it("contains asynchronous broadcast collisions without an error listener", () => {
    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true }));

    discovery.start("node_local_1", "Local");

    expect(() => publishService.emit("error", new Error("Service name is already in use on the network"))).not.toThrow();
  });

  it("continues when listener startup throws and emits error", () => {
    const error = new Error("listen failed");
    findMock.mockImplementation(() => {
      throw error;
    });

    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));
    const errorHandler = vi.fn();

    discovery.on("error", errorHandler);

    expect(() => discovery.start("node_local_1", "Local")).not.toThrow();
    expect(errorHandler).toHaveBeenCalledWith(error);
  });

  it("returns discovered nodes and specific discovered node by name", () => {
    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));

    expect(discovery.getDiscoveredNodes()).toEqual([]);
    expect(discovery.getDiscoveredNode("missing")).toBeUndefined();

    discovery.start("node_local_1", "Local");
    browser.emit("up", createService({ name: "peer-a" }));
    browser.emit("up", createService({ name: "peer-b", addresses: ["192.168.1.201"] }));

    const nodes = discovery.getDiscoveredNodes();
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.name).sort()).toEqual(["peer-a", "peer-b"]);

    expect(discovery.getDiscoveredNode("peer-b")).toEqual(
      expect.objectContaining({ host: "192.168.1.201" }),
    );
  });

  it("defaults nodeType to local when TXT nodeType is missing", () => {
    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));
    const discoveredHandler = vi.fn();

    discovery.on("node:discovered", discoveredHandler);
    discovery.start("node_local_1", "Local");

    browser.emit(
      "up",
      createService({
        txt: {
          nodeId: "node_remote",
        },
      }),
    );

    expect(discoveredHandler).toHaveBeenCalledWith(
      expect.objectContaining({ nodeType: "local" }),
    );
  });

  it("uses fallback host resolution paths", () => {
    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));
    const discoveredHandler = vi.fn();

    discovery.on("node:discovered", discoveredHandler);
    discovery.start("node_local_1", "Local");

    browser.emit(
      "up",
      createService({
        addresses: ["fe80::1"],
        referer: { address: "10.0.0.9" },
      }),
    );

    expect(discoveredHandler).toHaveBeenCalledWith(
      expect.objectContaining({ host: "10.0.0.9" }),
    );

    browser.emit(
      "up",
      createService({
        name: "referer-only",
        addresses: [],
        referer: { address: "10.0.0.10" },
      }),
    );

    expect(discovery.getDiscoveredNode("referer-only")).toEqual(
      expect.objectContaining({ host: "10.0.0.10" }),
    );
  });

  it("handles service type parsing for short format and uppercase", () => {
    const shortTypeDiscovery = new NodeDiscovery(defaultConfig({ broadcast: true, serviceType: "fusion" }));
    shortTypeDiscovery.start("node_local_1", "Local");

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "fusion", protocol: "tcp" }),
    );

    const uppercaseDiscovery = new NodeDiscovery(
      defaultConfig({
        listen: true,
        serviceType: "_FUSION._TCP",
      }),
    );
    uppercaseDiscovery.start("node_local_1", "Local");

    expect(findMock).toHaveBeenCalledWith({ type: "fusion", protocol: "tcp" });
  });

  it("stringifies numeric and boolean TXT values", () => {
    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));
    const discoveredHandler = vi.fn();

    discovery.on("node:discovered", discoveredHandler);
    discovery.start("node_local_1", "Local");

    browser.emit(
      "up",
      createService({
        txt: {
          nodeType: true,
          nodeId: 1234,
        },
      }),
    );

    expect(discoveredHandler).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "1234", nodeType: "local" }),
    );
  });

  it("does not emit discovery when host resolution fails", () => {
    const discovery = new NodeDiscovery(defaultConfig({ listen: true }));
    const discoveredHandler = vi.fn();

    discovery.on("node:discovered", discoveredHandler);
    discovery.start("node_local_1", "Local");

    browser.emit(
      "up",
      createService({
        name: "no-host",
        addresses: [],
        referer: undefined,
      }),
    );

    expect(discoveredHandler).not.toHaveBeenCalled();
    expect(discovery.getDiscoveredNode("no-host")).toBeUndefined();
  });

  it("emits discovery start/stop lifecycle events", () => {
    const discovery = new NodeDiscovery(defaultConfig({ broadcast: true }));
    const startedHandler = vi.fn();
    const stoppedHandler = vi.fn();

    discovery.on("discovery:started", startedHandler);
    discovery.on("discovery:stopped", stoppedHandler);

    discovery.start("node_local_1", "Local");
    discovery.stop();

    expect(startedHandler).toHaveBeenCalledTimes(1);
    expect(stoppedHandler).toHaveBeenCalledTimes(1);
  });
});
