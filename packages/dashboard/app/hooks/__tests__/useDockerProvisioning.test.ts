import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Must be called before importing the hook
const fetchMock = vi.fn();
global.fetch = fetchMock;

// Import the hook after mock setup
import { useDockerProvisioning } from "../useDockerProvisioning";

function jsonOk(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function jsonError(status: number, body: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("useDockerProvisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  describe("provision", () => {
    it("posts to /api/docker/provision and returns result", async () => {
      const result = {
        success: true,
        containerId: "abc",
        containerName: "fusion-test-abc12345",
        apiKey: "fn_key",
        portMapping: "4040:49152",
        durationMs: 1000,
      };
      fetchMock.mockReturnValue(jsonOk(result));

      const { result: hookResult } = renderHook(() => useDockerProvisioning());

      let provisionResult;
      await act(async () => {
        provisionResult = await hookResult.current.provision({
          nodeName: "test",
          hostConfig: {},
          imageConfig: { image: "runfusion/fusion", tag: "latest", pullImage: true },
          autoGenerateApiKey: true,
        });
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/docker/provision",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(provisionResult!.success).toBe(true);
      expect(hookResult.current.provisionResult).toEqual(result);
      expect(hookResult.current.isProvisioning).toBe(false);
    });

    it("sets provisionError on non-ok response", async () => {
      fetchMock.mockReturnValue(
        jsonError(500, { success: false, error: "internal error" }),
      );

      const { result: hookResult } = renderHook(() => useDockerProvisioning());

      await act(async () => {
        await hookResult.current.provision({
          nodeName: "test",
          hostConfig: {},
          imageConfig: { image: "runfusion/fusion", tag: "latest", pullImage: true },
          autoGenerateApiKey: true,
        });
      });

      expect(hookResult.current.provisionError).toBe("internal error");
    });

    it("sets provisionError on fetch rejection", async () => {
      fetchMock.mockRejectedValue(new Error("network error"));

      const { result: hookResult } = renderHook(() => useDockerProvisioning());

      await act(async () => {
        await hookResult.current.provision({
          nodeName: "test",
          hostConfig: {},
          imageConfig: { image: "runfusion/fusion", tag: "latest", pullImage: true },
          autoGenerateApiKey: true,
        });
      });

      expect(hookResult.current.provisionError).toBe("network error");
    });
  });

  describe("deprovision", () => {
    it("posts to /api/docker/deprovision with correct body", async () => {
      fetchMock.mockReturnValue(jsonOk({ success: true }));

      const { result: hookResult } = renderHook(() => useDockerProvisioning());

      await act(async () => {
        await hookResult.current.deprovision("abc123", { host: "tcp://1.2.3.4:2376" }, true);
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/docker/deprovision",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            containerId: "abc123",
            hostConfig: { host: "tcp://1.2.3.4:2376" },
            removeVolumes: true,
          }),
        }),
      );
      expect(hookResult.current.isDeprovisioning).toBe(false);
    });
  });

  describe("startContainer", () => {
    it("posts to the correct URL", async () => {
      fetchMock.mockReturnValue(jsonOk({ success: true }));

      const { result: hookResult } = renderHook(() => useDockerProvisioning());

      await act(async () => {
        await hookResult.current.startContainer("abc123", {});
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/docker/containers/abc123/start",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("stopContainer", () => {
    it("posts to the correct URL", async () => {
      fetchMock.mockReturnValue(jsonOk({ success: true }));

      const { result: hookResult } = renderHook(() => useDockerProvisioning());

      await act(async () => {
        await hookResult.current.stopContainer("abc123", {});
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/docker/containers/abc123/stop",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("restartContainer", () => {
    it("posts to the correct URL", async () => {
      fetchMock.mockReturnValue(jsonOk({ success: true }));

      const { result: hookResult } = renderHook(() => useDockerProvisioning());

      await act(async () => {
        await hookResult.current.restartContainer("abc123", {});
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/docker/containers/abc123/restart",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("getDefaultImage", () => {
    it("fetches from /api/docker/default-image", async () => {
      fetchMock.mockReturnValue(jsonOk({ image: "runfusion/fusion", tag: "latest" }));

      const { result: hookResult } = renderHook(() => useDockerProvisioning());

      let result;
      await act(async () => {
        result = await hookResult.current.getDefaultImage();
      });

      expect(fetchMock).toHaveBeenCalledWith("/api/docker/default-image");
      expect(result).toEqual({ image: "runfusion/fusion", tag: "latest" });
    });
  });
});
