// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerNodeRoutes } from "../register-node-routes.js";
import type { ApiRoutesContext } from "../types.js";

const { legacyCentralConstructor } = vi.hoisted(() => ({
  legacyCentralConstructor: vi.fn(function LegacyCentralCore() {
    throw new Error("node routes must use the injected central authority");
  }),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: legacyCentralConstructor,
  };
});

function createFixture() {
  const centralCore = {
    init: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listNodes: vi.fn(async () => [
      { id: "node_z", name: "Zulu", type: "remote", status: "online" },
      { id: "node_a", name: "Alpha", type: "local", status: "online" },
    ]),
    registerNode: vi.fn(async (input: Record<string, unknown>) => ({
      id: "node_remote",
      status: "offline",
      ...input,
    })),
  };

  const router = express.Router();
  registerNodeRoutes({
    router,
    options: { centralCore: centralCore as never },
    rethrowAsApiError(error: unknown): never {
      throw error;
    },
  } as unknown as ApiRoutesContext);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });

  return { app, centralCore };
}

describe("registerNodeRoutes PostgreSQL authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists nodes through the injected central authority", async () => {
    const { app, centralCore } = createFixture();

    const response = await request(app, "GET", "/api/nodes");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: "node_a", name: "Alpha", type: "local", status: "online" },
      { id: "node_z", name: "Zulu", type: "remote", status: "online" },
    ]);
    expect(centralCore.listNodes).toHaveBeenCalledOnce();
    expect(centralCore.init).not.toHaveBeenCalled();
    expect(centralCore.close).not.toHaveBeenCalled();
    expect(legacyCentralConstructor).not.toHaveBeenCalled();
  });

  it("registers nodes through the injected central authority", async () => {
    const { app, centralCore } = createFixture();

    const response = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({
        name: "macbook-air",
        type: "remote",
        url: "https://macbook-air.example.test:4041",
        maxConcurrent: 1,
      }),
      { "Content-Type": "application/json" },
    );

    expect(response.status).toBe(201);
    expect(centralCore.registerNode).toHaveBeenCalledWith({
      name: "macbook-air",
      type: "remote",
      url: "https://macbook-air.example.test:4041",
      apiKey: undefined,
      maxConcurrent: 1,
      capabilities: undefined,
      dockerConfig: undefined,
    });
    expect(centralCore.init).not.toHaveBeenCalled();
    expect(centralCore.close).not.toHaveBeenCalled();
    expect(legacyCentralConstructor).not.toHaveBeenCalled();
  });
});
