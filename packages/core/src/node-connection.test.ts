import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeConnection } from "./node-connection.js";
import type { CentralCore } from "./central-core.js";
import type { NodeConfig } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("NodeConnection", () => {
  let connection: NodeConnection;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connection = new NodeConnection();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("input validation", () => {
    it("throws TypeError for empty host", async () => {
      await expect(connection.test({ host: "   ", port: 3000 })).rejects.toThrow(TypeError);
    });

    it("throws TypeError for port 0", async () => {
      await expect(connection.test({ host: "127.0.0.1", port: 0 })).rejects.toThrow(TypeError);
    });

    it("throws TypeError for port greater than 65535", async () => {
      await expect(connection.test({ host: "127.0.0.1", port: 70_000 })).rejects.toThrow(TypeError);
    });

    it("throws TypeError for negative timeout", async () => {
      await expect(
        connection.test({
          host: "127.0.0.1",
          port: 3000,
          timeoutMs: -1,
        })
      ).rejects.toThrow(TypeError);
    });
  });

  describe("successful connections", () => {
    it("connects to an IP address and returns metadata", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          name: "Remote Node",
          version: "1.2.3",
          uptime: 123,
          capabilities: ["executor"],
        })
      );

      const result = await connection.test({
        host: "192.168.1.100",
        port: 3000,
      });

      expect(result.success).toBe(true);
      expect(result.url).toBe("http://192.168.1.100:3000");
      expect(result.nodeInfo).toEqual({
        name: "Remote Node",
        version: "1.2.3",
        uptime: 123,
        capabilities: ["executor"],
      });
      expect(result.latencyMs).toBeTypeOf("number");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(fetchMock).toHaveBeenCalledWith("http://192.168.1.100:3000/api/health", {
        method: "GET",
        headers: undefined,
        signal: expect.any(AbortSignal),
      });
    });

    it("connects to a hostname", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      const result = await connection.test({
        host: "my-server.local",
        port: 8080,
      });

      expect(result.success).toBe(true);
      expect(result.url).toBe("http://my-server.local:8080");
      expect(fetchMock).toHaveBeenCalledWith("http://my-server.local:8080/api/health", {
        method: "GET",
        headers: undefined,
        signal: expect.any(AbortSignal),
      });
    });

    it("uses https when secure is true", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      const result = await connection.test({
        host: "secure.host",
        port: 443,
        secure: true,
      });

      expect(result.success).toBe(true);
      expect(result.url).toBe("https://secure.host:443");
      expect(fetchMock).toHaveBeenCalledWith("https://secure.host:443/api/health", {
        method: "GET",
        headers: undefined,
        signal: expect.any(AbortSignal),
      });
    });

    it("supports a reverse-proxy basePath", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      const result = await connection.test({
        host: "host",
        port: 3000,
        basePath: "/fusion",
      });

      expect(result.success).toBe(true);
      expect(result.url).toBe("http://host:3000/fusion");
      expect(fetchMock).toHaveBeenCalledWith("http://host:3000/fusion/api/health", {
        method: "GET",
        headers: undefined,
        signal: expect.any(AbortSignal),
      });
    });

    it("sends bearer auth when apiKey is provided", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      const result = await connection.test({
        host: "host",
        port: 3000,
        apiKey: "secret-key",
      });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith("http://host:3000/api/health", {
        method: "GET",
        headers: {
          Authorization: "Bearer secret-key",
        },
        signal: expect.any(AbortSignal),
      });
    });

    it("applies defaults when optional health fields are missing", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      const result = await connection.test({
        host: "minimal.host",
        port: 3000,
      });

      expect(result.success).toBe(true);
      expect(result.nodeInfo).toEqual({
        name: "minimal.host",
        version: "unknown",
        uptime: 0,
        capabilities: undefined,
      });
    });
  });

  describe("error handling", () => {
    it("returns timeout classification for AbortError", async () => {
      fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

      const result = await connection.test({
        host: "host",
        port: 3000,
        timeoutMs: 2500,
      });

      expect(result).toMatchObject({
        success: false,
        error: {
          type: "timeout",
        },
      });
      expect(result.error?.message).toContain("2500");
    });

    it("returns dns-failure when fetch message contains ENOTFOUND", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: getaddrinfo ENOTFOUND missing.local"));

      const result = await connection.test({ host: "missing.local", port: 3000 });

      expect(result).toMatchObject({
        success: false,
        error: {
          type: "dns-failure",
        },
      });
    });

    it("returns connection-refused when fetch message contains ECONNREFUSED", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:3000"));

      const result = await connection.test({ host: "127.0.0.1", port: 3000 });

      expect(result).toMatchObject({
        success: false,
        error: {
          type: "connection-refused",
        },
      });
    });

    it("returns ssl-error for TLS certificate failures", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: CERT_HAS_EXPIRED"));

      const result = await connection.test({ host: "secure.example", port: 443, secure: true });

      expect(result).toMatchObject({
        success: false,
        error: {
          type: "ssl-error",
        },
      });
    });

    it("returns auth-failure for HTTP 401", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

      const result = await connection.test({ host: "host", port: 3000, apiKey: "bad" });

      expect(result).toEqual({
        success: false,
        url: "http://host:3000",
        error: {
          type: "auth-failure",
          message: "Authentication failed (401) while testing http://host:3000",
          statusCode: 401,
        },
      });
    });

    it("returns auth-failure for HTTP 403", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));

      const result = await connection.test({ host: "host", port: 3000, apiKey: "bad" });

      expect(result).toEqual({
        success: false,
        url: "http://host:3000",
        error: {
          type: "auth-failure",
          message: "Authentication failed (403) while testing http://host:3000",
          statusCode: 403,
        },
      });
    });

    it("returns unexpected-status for non-auth non-2xx responses", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

      const result = await connection.test({ host: "host", port: 3000 });

      expect(result).toEqual({
        success: false,
        url: "http://host:3000",
        error: {
          type: "unexpected-status",
          message: "Unexpected response status 500 while testing http://host:3000",
          statusCode: 500,
        },
      });
    });

    it("returns not-fusion-node when response JSON lacks status field", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ healthy: true }));

      const result = await connection.test({ host: "host", port: 3000 });

      expect(result).toMatchObject({
        success: false,
        error: {
          type: "not-fusion-node",
        },
      });
    });

    it("returns network-error for unknown failures", async () => {
      fetchMock.mockRejectedValueOnce(new Error("socket hang up"));

      const result = await connection.test({ host: "host", port: 3000 });

      expect(result).toEqual({
        success: false,
        url: "http://host:3000",
        error: {
          type: "network-error",
          message: "socket hang up",
        },
      });
    });
  });

  describe("testAndRegister", () => {
    it("returns node when connection and registration both succeed", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ status: "ok", name: "Remote", version: "1.0.0", uptime: 42 })
      );

      const node: NodeConfig = {
        id: "node_123",
        name: "remote-node",
        type: "remote",
        url: "http://remote.host:3000",
        apiKey: "secret",
        status: "offline",
        maxConcurrent: 4,
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      };

      const registerNodeMock = vi.fn().mockResolvedValue(node);
      const checkNodeHealthMock = vi.fn().mockResolvedValue("online");
      const central = {
        registerNode: registerNodeMock,
        checkNodeHealth: checkNodeHealthMock,
      } as unknown as CentralCore;

      const result = await connection.testAndRegister(central, {
        name: "remote-node",
        host: "remote.host",
        port: 3000,
        apiKey: "secret",
        maxConcurrent: 4,
      });

      expect(result.success).toBe(true);
      expect(result.node).toEqual(node);
      expect(result.registrationError).toBeUndefined();
      expect(registerNodeMock).toHaveBeenCalledWith({
        name: "remote-node",
        type: "remote",
        url: "http://remote.host:3000",
        apiKey: "secret",
        maxConcurrent: 4,
      });
      expect(checkNodeHealthMock).toHaveBeenCalledWith("node_123");
    });

    it("returns registrationError when registration fails", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

      const registerNodeMock = vi
        .fn()
        .mockRejectedValue(new Error("Node already exists with name: remote-node"));
      const checkNodeHealthMock = vi.fn();
      const central = {
        registerNode: registerNodeMock,
        checkNodeHealth: checkNodeHealthMock,
      } as unknown as CentralCore;

      const result = await connection.testAndRegister(central, {
        name: "remote-node",
        host: "remote.host",
        port: 3000,
      });

      expect(result.success).toBe(true);
      expect(result.node).toBeUndefined();
      expect(result.registrationError).toBe("Node already exists with name: remote-node");
      expect(checkNodeHealthMock).not.toHaveBeenCalled();
    });

    it("skips registration when connection test fails", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:3000"));

      const registerNodeMock = vi.fn();
      const checkNodeHealthMock = vi.fn();
      const central = {
        registerNode: registerNodeMock,
        checkNodeHealth: checkNodeHealthMock,
      } as unknown as CentralCore;

      const result = await connection.testAndRegister(central, {
        name: "remote-node",
        host: "127.0.0.1",
        port: 3000,
      });

      expect(result).toMatchObject({
        success: false,
        error: {
          type: "connection-refused",
        },
      });
      expect(registerNodeMock).not.toHaveBeenCalled();
      expect(checkNodeHealthMock).not.toHaveBeenCalled();
    });
  });
});
