import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDockerTargets } from "../useDockerTargets";

describe("useDockerTargets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  it("loads contexts", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [{ name: "default", isCurrentContext: true }] } as Response);
    const { result } = renderHook(() => useDockerTargets());
    await act(async () => {
      await result.current.loadContexts();
    });
    expect(result.current.contexts).toHaveLength(1);
  });

  it("tests connection", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ success: true, isLocalDaemon: true }) } as Response);
    const { result } = renderHook(() => useDockerTargets());
    await act(async () => {
      await result.current.testConnection({ host: "tcp://1.2.3.4:2376" });
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/docker/test-connection",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("checks local docker", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ available: true, version: "24.0" }) } as Response);
    const { result } = renderHook(() => useDockerTargets());
    await act(async () => {
      const response = await result.current.checkLocalDocker();
      expect(response.available).toBe(true);
    });
  });
});
