import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { TaskStore } from "@fusion/core";
import { createSSE, disconnectSSEClient, getActiveSSEConnections, markSSEClientAlive } from "../sse.js";

class MockSocket extends EventEmitter {
  destroyed = false;
  setKeepAlive = vi.fn();
  destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  });
}

class MockResponse extends EventEmitter {
  headers = new Map<string, string>();
  writableEnded = false;
  destroyed = false;
  write = vi.fn();
  flushHeaders = vi.fn();
  end = vi.fn(() => {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit("close");
  });

  constructor(readonly socket: MockSocket) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

function createMockStore(): TaskStore {
  return {
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function openSseConnection(clientId: string, projectId?: string) {
  const store = createMockStore();
  const socket = new MockSocket();
  const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
  req.query = projectId ? { clientId, projectId } : { clientId };
  req.socket = socket;
  const res = new MockResponse(socket);

  createSSE(
    store,
    undefined,
    undefined,
    undefined,
    projectId ? { projectId } : undefined,
  )(req, res as unknown as Response);

  return { req, res, socket, store };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSSE client cleanup", () => {
  it("disconnectSSEClient closes and unregisters the matching stream", () => {
    const baseline = getActiveSSEConnections();
    const connection = openSseConnection("client-one");

    expect(getActiveSSEConnections()).toBe(baseline + 1);

    expect(disconnectSSEClient("client-one")).toBe(1);

    expect(connection.res.end).toHaveBeenCalledTimes(1);
    expect(connection.socket.destroy).toHaveBeenCalledTimes(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("a new stream supersedes an older stream from the same client and project", () => {
    const baseline = getActiveSSEConnections();
    const first = openSseConnection("client-two", "project-a");
    const second = openSseConnection("client-two", "project-a");

    expect(first.res.end).toHaveBeenCalledTimes(1);
    expect(first.socket.destroy).toHaveBeenCalledTimes(1);
    expect(second.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 1);

    expect(disconnectSSEClient("client-two", "project-a")).toBe(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("keeps streams from the same client isolated by project scope", () => {
    const baseline = getActiveSSEConnections();
    const first = openSseConnection("client-three", "project-a");
    const second = openSseConnection("client-three", "project-b");

    expect(first.res.end).not.toHaveBeenCalled();
    expect(second.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 2);

    expect(disconnectSSEClient("client-three", "project-a")).toBe(1);
    expect(first.res.end).toHaveBeenCalledTimes(1);
    expect(second.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 1);

    expect(disconnectSSEClient("client-three", "project-b")).toBe(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("closes a client stream when keepalives stop", () => {
    vi.useFakeTimers();
    const baseline = getActiveSSEConnections();
    const connection = openSseConnection("client-four");

    expect(getActiveSSEConnections()).toBe(baseline + 1);

    vi.advanceTimersByTime(4_999);
    expect(connection.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 1);

    vi.advanceTimersByTime(1);
    expect(connection.res.end).toHaveBeenCalledTimes(1);
    expect(connection.socket.destroy).toHaveBeenCalledTimes(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });

  it("extends a client stream while keepalives arrive", () => {
    vi.useFakeTimers();
    const baseline = getActiveSSEConnections();
    const connection = openSseConnection("client-five");

    vi.advanceTimersByTime(4_000);
    expect(markSSEClientAlive("client-five")).toBe(1);

    vi.advanceTimersByTime(4_000);
    expect(connection.res.end).not.toHaveBeenCalled();
    expect(getActiveSSEConnections()).toBe(baseline + 1);

    vi.advanceTimersByTime(1_000);
    expect(connection.res.end).toHaveBeenCalledTimes(1);
    expect(getActiveSSEConnections()).toBe(baseline);
  });
});
