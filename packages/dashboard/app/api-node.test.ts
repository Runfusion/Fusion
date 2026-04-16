import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchRemoteNodeHealth,
  fetchRemoteNodeProjects,
  fetchRemoteNodeTasks,
  fetchRemoteNodeProjectHealth,
  fetchNodeSettings,
  pushNodeSettings,
  pullNodeSettings,
  fetchNodeSettingsSyncStatus,
  syncNodeAuth,
} from "./api-node";
import * as apiModule from "./api";

vi.mock("./api", () => ({
  proxyApi: vi.fn(),
  api: vi.fn(),
}));

const mockProxyApi = vi.mocked(apiModule.proxyApi);
const mockApi = vi.mocked(apiModule.api);

describe("api-node", () => {
  beforeEach(() => {
    mockProxyApi.mockReset();
    mockApi.mockReset();
  });

  describe("fetchRemoteNodeHealth", () => {
    it("calls proxyApi with correct path and nodeId", async () => {
      const mockHealth = { status: "online", version: "1.0.0", nodeId: "node_abc" };
      mockProxyApi.mockResolvedValueOnce(mockHealth);

      const result = await fetchRemoteNodeHealth("node_abc");

      expect(mockProxyApi).toHaveBeenCalledTimes(1);
      expect(mockProxyApi).toHaveBeenCalledWith("/health", { nodeId: "node_abc" });
      expect(result).toEqual(mockHealth);
    });

    it("returns remote node health data", async () => {
      const mockHealth = { status: "offline", version: "2.0.0", nodeId: "node_xyz" };
      mockProxyApi.mockResolvedValueOnce(mockHealth);

      const result = await fetchRemoteNodeHealth("node_xyz");

      expect(result.status).toBe("offline");
      expect(result.version).toBe("2.0.0");
      expect(result.nodeId).toBe("node_xyz");
    });
  });

  describe("fetchRemoteNodeProjects", () => {
    it("calls proxyApi with correct path and nodeId", async () => {
      const mockProjects = [
        {
          id: "proj_001",
          name: "Test Project",
          path: "/test/path",
          status: "active",
          isolationMode: "in-process" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      mockProxyApi.mockResolvedValueOnce(mockProjects);

      const result = await fetchRemoteNodeProjects("node_abc");

      expect(mockProxyApi).toHaveBeenCalledTimes(1);
      expect(mockProxyApi).toHaveBeenCalledWith("/projects", { nodeId: "node_abc" });
      expect(result).toEqual(mockProjects);
    });

    it("returns empty array when no projects exist", async () => {
      mockProxyApi.mockResolvedValueOnce([]);

      const result = await fetchRemoteNodeProjects("node_abc");

      expect(result).toEqual([]);
    });
  });

  describe("fetchRemoteNodeTasks", () => {
    it("calls proxyApi with tasks path including projectId query param", async () => {
      const mockTasks = [
        {
          id: "FN-001",
          title: "Test Task",
          description: "Test description",
          column: "todo" as const,
          dependencies: [],
          steps: [],
          currentStep: 0,
          size: "M" as const,
          reviewLevel: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          columnMovedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      mockProxyApi.mockResolvedValueOnce(mockTasks);

      const result = await fetchRemoteNodeTasks("node_abc", "proj_001");

      expect(mockProxyApi).toHaveBeenCalledTimes(1);
      expect(mockProxyApi).toHaveBeenCalledWith(
        "/tasks?projectId=proj_001",
        { nodeId: "node_abc" },
      );
      expect(result).toEqual(mockTasks);
    });

    it("properly encodes projectId with special characters", async () => {
      mockProxyApi.mockResolvedValueOnce([]);

      await fetchRemoteNodeTasks("node_abc", "proj/test+special");

      expect(mockProxyApi).toHaveBeenCalledWith(
        "/tasks?projectId=proj%2Ftest%2Bspecial",
        { nodeId: "node_abc" },
      );
    });

    it("forwards search query parameter (q) when provided", async () => {
      const mockTasks = [
        {
          id: "FN-001",
          title: "Searchable Task",
          description: "Test description",
          column: "todo" as const,
          dependencies: [],
          steps: [],
          currentStep: 0,
          size: "M" as const,
          reviewLevel: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          columnMovedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      mockProxyApi.mockResolvedValueOnce(mockTasks);

      const result = await fetchRemoteNodeTasks("node_abc", "proj_001", "searchable");

      expect(mockProxyApi).toHaveBeenCalledTimes(1);
      expect(mockProxyApi).toHaveBeenCalledWith(
        "/tasks?projectId=proj_001&q=searchable",
        { nodeId: "node_abc" },
      );
      expect(result).toEqual(mockTasks);
    });

    it("properly encodes search query with special characters", async () => {
      mockProxyApi.mockResolvedValueOnce([]);

      await fetchRemoteNodeTasks("node_abc", "proj_001", "search+query&test");

      expect(mockProxyApi).toHaveBeenCalledWith(
        "/tasks?projectId=proj_001&q=search%2Bquery%26test",
        { nodeId: "node_abc" },
      );
    });

    it("omits q parameter when searchQuery is undefined", async () => {
      mockProxyApi.mockResolvedValueOnce([]);

      await fetchRemoteNodeTasks("node_abc", "proj_001");

      expect(mockProxyApi).toHaveBeenCalledWith(
        "/tasks?projectId=proj_001",
        { nodeId: "node_abc" },
      );
    });

    it("omits q parameter when searchQuery is empty string", async () => {
      mockProxyApi.mockResolvedValueOnce([]);

      await fetchRemoteNodeTasks("node_abc", "proj_001", "");

      expect(mockProxyApi).toHaveBeenCalledWith(
        "/tasks?projectId=proj_001",
        { nodeId: "node_abc" },
      );
    });
  });

  describe("fetchRemoteNodeProjectHealth", () => {
    it("calls proxyApi with project-health path including projectId query param", async () => {
      const mockHealth = {
        activeTaskCount: 5,
        inFlightAgentCount: 2,
        status: "active" as const,
      };
      mockProxyApi.mockResolvedValueOnce(mockHealth);

      const result = await fetchRemoteNodeProjectHealth("node_abc", "proj_001");

      expect(mockProxyApi).toHaveBeenCalledTimes(1);
      expect(mockProxyApi).toHaveBeenCalledWith(
        "/project-health?projectId=proj_001",
        { nodeId: "node_abc" },
      );
      expect(result).toEqual(mockHealth);
    });

    it("properly encodes projectId with special characters", async () => {
      mockProxyApi.mockResolvedValueOnce({
        activeTaskCount: 0,
        inFlightAgentCount: 0,
        status: "active" as const,
      });

      await fetchRemoteNodeProjectHealth("node_abc", "proj/test+special");

      expect(mockProxyApi).toHaveBeenCalledWith(
        "/project-health?projectId=proj%2Ftest%2Bspecial",
        { nodeId: "node_abc" },
      );
    });
  });

  describe("error handling", () => {
    it("propagates errors from proxyApi", async () => {
      mockProxyApi.mockRejectedValueOnce(new Error("Network error"));

      await expect(fetchRemoteNodeHealth("node_abc")).rejects.toThrow("Network error");
    });

    it("propagates API error responses", async () => {
      mockProxyApi.mockRejectedValueOnce(new Error("404 Not Found"));

      await expect(fetchRemoteNodeProjects("node_abc")).rejects.toThrow("404 Not Found");
    });
  });

  // ── Node Settings Sync API ──────────────────────────────────────────────

  describe("fetchNodeSettings", () => {
    it("calls api with correct path and returns settings", async () => {
      const mockSettings = { global: { theme: "dark" }, project: { maxConcurrent: 4 } };
      mockApi.mockResolvedValueOnce(mockSettings);

      const result = await fetchNodeSettings("node_abc");

      expect(mockApi).toHaveBeenCalledTimes(1);
      expect(mockApi).toHaveBeenCalledWith("/nodes/node_abc/settings");
      expect(result).toEqual(mockSettings);
    });

    it("encodes nodeId with special characters in URL", async () => {
      mockApi.mockResolvedValueOnce({ global: {}, project: {} });

      await fetchNodeSettings("node/abc+def");

      expect(mockApi).toHaveBeenCalledWith("/nodes/node%2Fabc%2Bdef/settings");
    });

    it("propagates errors from api", async () => {
      mockApi.mockRejectedValueOnce(new Error("Node unreachable"));

      await expect(fetchNodeSettings("node_abc")).rejects.toThrow("Node unreachable");
    });
  });

  describe("pushNodeSettings", () => {
    it("calls api with POST method and correct path", async () => {
      const mockResult = { success: true, syncedFields: ["theme", "maxConcurrent"] };
      mockApi.mockResolvedValueOnce(mockResult);

      const result = await pushNodeSettings("node_abc");

      expect(mockApi).toHaveBeenCalledTimes(1);
      expect(mockApi).toHaveBeenCalledWith(
        "/nodes/node_abc/settings/push",
        { method: "POST", body: JSON.stringify({}) },
      );
      expect(result).toEqual(mockResult);
    });

    it("encodes nodeId with special characters in URL", async () => {
      mockApi.mockResolvedValueOnce({ success: true, syncedFields: [] });

      await pushNodeSettings("node/abc+def");

      expect(mockApi).toHaveBeenCalledWith(
        "/nodes/node%2Fabc%2Bdef/settings/push",
        { method: "POST", body: JSON.stringify({}) },
      );
    });

    it("propagates errors from api", async () => {
      mockApi.mockRejectedValueOnce(new Error("Push failed"));

      await expect(pushNodeSettings("node_abc")).rejects.toThrow("Push failed");
    });
  });

  describe("pullNodeSettings", () => {
    it("calls api with POST method, correct path, and last-write-wins conflict resolution", async () => {
      const mockResult = { success: true, appliedFields: ["theme"], skippedFields: [] };
      mockApi.mockResolvedValueOnce(mockResult);

      const result = await pullNodeSettings("node_abc");

      expect(mockApi).toHaveBeenCalledTimes(1);
      expect(mockApi).toHaveBeenCalledWith(
        "/nodes/node_abc/settings/pull",
        { method: "POST", body: JSON.stringify({ conflictResolution: "last-write-wins" }) },
      );
      expect(result).toEqual(mockResult);
    });

    it("encodes nodeId with special characters in URL", async () => {
      mockApi.mockResolvedValueOnce({ success: true, appliedFields: [], skippedFields: [] });

      await pullNodeSettings("node/abc+def");

      expect(mockApi).toHaveBeenCalledWith(
        "/nodes/node%2Fabc%2Bdef/settings/pull",
        { method: "POST", body: JSON.stringify({ conflictResolution: "last-write-wins" }) },
      );
    });

    it("propagates errors from api", async () => {
      mockApi.mockRejectedValueOnce(new Error("Pull failed"));

      await expect(pullNodeSettings("node_abc")).rejects.toThrow("Pull failed");
    });
  });

  describe("fetchNodeSettingsSyncStatus", () => {
    it("calls api with correct path and returns sync status", async () => {
      const mockStatus = {
        lastSyncAt: "2026-04-01T00:00:00.000Z",
        lastSyncDirection: "sync",
        localUpdatedAt: "2026-04-01T00:00:00.000Z",
        remoteReachable: true,
        diff: { global: ["theme"], project: [] },
      };
      mockApi.mockResolvedValueOnce(mockStatus);

      const result = await fetchNodeSettingsSyncStatus("node_abc");

      expect(mockApi).toHaveBeenCalledTimes(1);
      expect(mockApi).toHaveBeenCalledWith("/nodes/node_abc/settings/sync-status");
      expect(result).toEqual(mockStatus);
    });

    it("encodes nodeId with special characters in URL", async () => {
      mockApi.mockResolvedValueOnce({
        lastSyncAt: null,
        lastSyncDirection: null,
        localUpdatedAt: "2026-04-01T00:00:00.000Z",
        remoteReachable: false,
        diff: { global: [], project: [] },
      });

      await fetchNodeSettingsSyncStatus("node/abc+def");

      expect(mockApi).toHaveBeenCalledWith("/nodes/node%2Fabc%2Bdef/settings/sync-status");
    });

    it("propagates errors from api", async () => {
      mockApi.mockRejectedValueOnce(new Error("Sync status check failed"));

      await expect(fetchNodeSettingsSyncStatus("node_abc")).rejects.toThrow("Sync status check failed");
    });
  });

  describe("syncNodeAuth", () => {
    it("calls api with POST method and correct path", async () => {
      const mockResult = { success: true, syncedProviders: ["openai", "anthropic"] };
      mockApi.mockResolvedValueOnce(mockResult);

      const result = await syncNodeAuth("node_abc");

      expect(mockApi).toHaveBeenCalledTimes(1);
      expect(mockApi).toHaveBeenCalledWith(
        "/nodes/node_abc/auth/sync",
        { method: "POST", body: JSON.stringify({}) },
      );
      expect(result).toEqual(mockResult);
    });

    it("encodes nodeId with special characters in URL", async () => {
      mockApi.mockResolvedValueOnce({ success: true, syncedProviders: [] });

      await syncNodeAuth("node/abc+def");

      expect(mockApi).toHaveBeenCalledWith(
        "/nodes/node%2Fabc%2Bdef/auth/sync",
        { method: "POST", body: JSON.stringify({}) },
      );
    });

    it("propagates errors from api", async () => {
      mockApi.mockRejectedValueOnce(new Error("Auth sync failed"));

      await expect(syncNodeAuth("node_abc")).rejects.toThrow("Auth sync failed");
    });
  });
});
