import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, ElectronApiTransport } from "../api-electron";

describe("api-electron", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns IPC transport when window.electronAPI exists", () => {
    const client = createApiClient({
      electronAPI: {
        invoke: vi.fn(),
      },
    });

    expect(client.mode).toBe("electron");
    expect(client.transport).toBeInstanceOf(ElectronApiTransport);
  });

  it("returns fetch transport when window.electronAPI is absent", () => {
    const client = createApiClient({});

    expect(client.mode).toBe("web");
    expect(client.transport.constructor.name).toBe("FetchApiTransport");
  });

  it("IPC transport calls electronAPI.invoke with request payload", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, data: { ok: true } });
    const getServerPort = vi.fn().mockResolvedValue(4040);

    const client = createApiClient({
      electronAPI: { invoke, getServerPort },
    });

    const result = await client.transport.request<{ ok: boolean }>("/tasks", {
      method: "POST",
      headers: { "x-test": "1" },
      body: JSON.stringify({ title: "hello" }),
    });

    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("api-request", {
      method: "POST",
      path: "/tasks",
      headers: { "x-test": "1" },
      body: { title: "hello" },
      port: 4040,
    });
  });

  it("resolves server port dynamically once and reuses it", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, data: { ok: true } });
    const getServerPort = vi.fn().mockResolvedValue(5050);

    const client = createApiClient({
      electronAPI: { invoke, getServerPort },
    });

    await client.transport.request("/tasks");
    await client.transport.request("/settings");

    expect(getServerPort).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(1, "api-request", expect.objectContaining({ port: 5050, path: "/tasks" }));
    expect(invoke).toHaveBeenNthCalledWith(2, "api-request", expect.objectContaining({ port: 5050, path: "/settings" }));
  });
});
