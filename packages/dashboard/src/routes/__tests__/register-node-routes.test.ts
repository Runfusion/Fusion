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

function buildApp(centralCore: Record<string, unknown> | undefined) {
  const router = express.Router();
  registerNodeRoutes({
    router,
    options: centralCore ? { centralCore: centralCore as never } : {},
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

  return app;
}

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

  return { app: buildApp(centralCore), centralCore };
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

  // FNXC:NodeRegistry — a route-owned fallback authority (no injected centralCore) must close on
  // EVERY exit path, including when the underlying store operation throws mid-handler.
  it("closes a route-owned fallback authority when listNodes throws", async () => {
    const fallbackCentral = {
      init: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      listNodes: vi.fn(async () => {
        throw new Error("registry unavailable");
      }),
    };
    // Only the single fallback construction in this test uses the working fake; the default throwing
    // constructor is restored automatically afterward.
    legacyCentralConstructor.mockImplementationOnce(function ConstructedFallbackCentral() {
      return fallbackCentral;
    });

    const app = buildApp(undefined);

    const response = await request(app, "GET", "/api/nodes");

    expect(response.status).toBe(500);
    expect(legacyCentralConstructor).toHaveBeenCalledTimes(1);
    expect(fallbackCentral.init).toHaveBeenCalledOnce();
    expect(fallbackCentral.listNodes).toHaveBeenCalledOnce();
    expect(fallbackCentral.close).toHaveBeenCalledOnce();
  });
});
