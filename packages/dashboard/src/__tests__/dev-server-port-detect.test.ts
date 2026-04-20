// @vitest-environment node

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectPortFromLogLine,
  detectPortFromLogs,
} from "../dev-server-port-detect.js";

describe("dev-server-port-detect", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:net");
  });

  it("detects and normalizes Vite local URL lines", () => {
    const result = detectPortFromLogLine("  ➜  Local:   http://localhost:5173/  ");

    expect(result).toEqual({
      url: "http://localhost:5173",
      port: 5173,
      source: "vite",
    });
  });

  it("detects Next.js startup URL lines", () => {
    const result = detectPortFromLogLine(
      "ready - started server on 0.0.0.0:3000, url: http://localhost:3000",
    );

    expect(result).toEqual({
      url: "http://localhost:3000",
      port: 3000,
      source: "nextjs",
    });
  });

  it("detects Next.js local URL lines using the - Local pattern", () => {
    const result = detectPortFromLogLine("  - Local: http://localhost:3000");

    expect(result).toEqual({
      url: "http://localhost:3000",
      port: 3000,
      source: "nextjs",
    });
  });

  it("detects Vite URL lines that include the framework name", () => {
    const result = detectPortFromLogLine("vite v6 started at http://localhost:5173/");

    expect(result).toEqual({
      url: "http://localhost:5173",
      port: 5173,
      source: "vite",
    });
  });

  it("detects generic keyword + port log lines", () => {
    const result = detectPortFromLogLine("Server listening on port 4173");

    expect(result).toEqual({
      url: "http://localhost:4173",
      port: 4173,
      source: "generic-port",
    });
  });

  it("detects Storybook local URL lines", () => {
    const result = detectPortFromLogLine("=> Local: http://localhost:6006/");

    expect(result).toEqual({
      url: "http://localhost:6006",
      port: 6006,
      source: "storybook",
    });
  });

  it("detects Angular host/port lines without explicit URL", () => {
    const result = detectPortFromLogLine(
      "** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **",
    );

    expect(result).toEqual({
      url: "http://localhost:4200",
      port: 4200,
      source: "angular",
    });
  });

  it("falls back to generic localhost URL detection", () => {
    const result = detectPortFromLogLine("Preview available at localhost:4321/");

    expect(result).toEqual({
      url: "http://localhost:4321",
      port: 4321,
      source: "generic-url",
    });
  });

  it("detects ANSI-colored 127.0.0.1 lines", () => {
    const result = detectPortFromLogLine("\u001b[32mready\u001b[39m at http://127.0.0.1:4400/");

    expect(result).toEqual({
      url: "http://127.0.0.1:4400",
      port: 4400,
      source: "generic-url",
    });
  });

  it("detectPortFromLogs searches from latest line to oldest", () => {
    const result = detectPortFromLogs([
      "old: http://localhost:3000/",
      "new: http://localhost:5173/",
    ]);

    expect(result).toEqual({
      url: "http://localhost:5173",
      port: 5173,
      source: "generic-url",
    });
  });

  it("returns null for malformed or non-matching lines", () => {
    expect(detectPortFromLogLine("build complete")).toBeNull();
    expect(detectPortFromLogLine("")).toBeNull();
    expect(detectPortFromLogLine("http://example.com:5173")).toBeNull();
    expect(detectPortFromLogLine("port: 99999")).toBeNull();
    expect(detectPortFromLogLine("http://localhost:abc")).toBeNull();
  });

  it("excludes reserved dashboard port 4040", () => {
    expect(detectPortFromLogLine("http://localhost:4040/")).toBeNull();
    expect(detectPortFromLogLine("Listening on port 4040")).toBeNull();
  });

  it("probeFallbackPorts returns first open port in fallback order", async () => {
    const sockets: Array<ReturnType<typeof createMockSocket>> = [];
    const createConnection = vi.fn(({ port }: { host: string; port: number }) => {
      const socket = createMockSocket();
      sockets.push(socket);
      queueMicrotask(() => {
        if (port === 4200) {
          socket.emit("connect");
        } else {
          socket.emit("error", new Error("ECONNREFUSED"));
        }
      });
      return socket;
    });

    vi.doMock("node:net", () => ({ createConnection }));
    const { probeFallbackPorts } = await import("../dev-server-port-detect.js");

    const result = await probeFallbackPorts("localhost", 150);

    expect(result).toEqual({
      url: "http://localhost:4200",
      port: 4200,
      source: "fallback-probe",
    });
    expect(createConnection).toHaveBeenCalled();
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: "localhost", port: 5173 }),
    );
    expect(sockets[0]?.setTimeout).toHaveBeenCalledWith(150);
  });

  it("probeFallbackPorts normalizes host input before probing", async () => {
    const createConnection = vi.fn(({ port }: { host: string; port: number }) => {
      const socket = createMockSocket();
      queueMicrotask(() => {
        if (port === 5173) {
          socket.emit("connect");
        } else {
          socket.emit("error", new Error("ECONNREFUSED"));
        }
      });
      return socket;
    });

    vi.doMock("node:net", () => ({ createConnection }));
    const { probeFallbackPorts } = await import("../dev-server-port-detect.js");

    const result = await probeFallbackPorts(" https://localhost/ ", 80);

    expect(result).toEqual({
      url: "http://localhost:5173",
      port: 5173,
      source: "fallback-probe",
    });
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: "localhost", port: 5173 }),
    );
  });

  it("probeFallbackPorts returns null when no fallback ports are open", async () => {
    const sockets: Array<ReturnType<typeof createMockSocket>> = [];
    const createConnection = vi.fn(() => {
      const socket = createMockSocket();
      sockets.push(socket);
      queueMicrotask(() => {
        socket.emit("error", new Error("ECONNREFUSED"));
      });
      return socket;
    });

    vi.doMock("node:net", () => ({ createConnection }));
    const { probeFallbackPorts, FALLBACK_PREVIEW_PORTS } = await import("../dev-server-port-detect.js");

    const result = await probeFallbackPorts(undefined, 50);

    expect(result).toBeNull();
    expect(createConnection).toHaveBeenCalledTimes(FALLBACK_PREVIEW_PORTS.length);
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 5173 }),
    );

    const probedPorts = createConnection.mock.calls.map(([args]) => (args as { port: number }).port);
    expect(probedPorts).not.toContain(4040);

    expect(sockets[0]?.setTimeout).toHaveBeenCalledWith(50);
  });
});

function createMockSocket(): EventEmitter & {
  setTimeout: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter() as EventEmitter & {
    setTimeout: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };

  emitter.setTimeout = vi.fn(() => emitter);
  emitter.end = vi.fn();
  emitter.destroy = vi.fn();

  return emitter;
}
