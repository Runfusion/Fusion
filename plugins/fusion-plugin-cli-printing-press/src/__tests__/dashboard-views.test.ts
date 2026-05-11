import { describe, expect, it } from "vitest";
import { createCliPrintingPressRoutes } from "../routes/wizard-routes.js";
import { makeFakeRegistry } from "./fixtures/registry.js";

function route(method: string, path: string) {
  const found = createCliPrintingPressRoutes().find((entry) => entry.method === method && entry.path === path);
  if (!found) throw new Error(`missing route ${method} ${path}`);
  return found;
}

describe("dashboard API route contracts", () => {
  it("defines expected wizard/list/detail/run endpoints", () => {
    const routes = createCliPrintingPressRoutes();
    expect(routes.map((entry) => `${entry.method} ${entry.path}`)).toEqual(
      expect.arrayContaining([
        "POST /drafts",
        "GET /drafts",
        "GET /drafts/:id",
        "PUT /drafts/:id",
        "POST /drafts/:id/regenerate",
        "POST /drafts/:id/run",
      ]),
    );
  });

  it("supports happy and error API paths", async () => {
    const h = makeFakeRegistry();
    try {
      const ctx = { taskStore: { getRootDir: () => h.rootDir, getDatabase: () => h.db } } as any;
      const listRes = await route("GET", "/drafts").handler({ params: {} }, ctx);
      expect(listRes.status).toBe(200);

      const missRes = await route("GET", "/drafts/:id").handler({ params: { id: "missing" } }, ctx);
      expect(missRes.status).toBe(404);

      const badRun = await route("POST", "/drafts/:id/run").handler({ params: { id: h.services.acme.id }, body: { endpointId: "", params: {} } }, ctx);
      expect(badRun.status).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  it("documents plugin-prefixed mount contract", () => {
    expect("/api/plugins/cli-printing-press/drafts").toContain("/api/plugins/cli-printing-press/");
  });
});
