// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";
import { buildSettingsSectionsPayload, buildViewsPayload } from "../register-ui-metadata-routes.js";

/** Payload as it survives the wire: JSON drops `undefined`-valued keys. */
function overWire<T>(payload: T): unknown {
  return JSON.parse(JSON.stringify(payload));
}

function createMockStore(): TaskStore {
  return { getRootDir: vi.fn(() => process.cwd()) } as unknown as TaskStore;
}

function createApp() {
  const app = express();
  app.use("/api", createApiRoutes(createMockStore()));
  return app;
}

function expectJsonSafe(value: unknown): void {
  expect(() => JSON.stringify(value)).not.toThrow();
  const visit = (entry: unknown): void => {
    expect(typeof entry).not.toBe("function");
    expect(entry).not.toBeUndefined();
    if (Array.isArray(entry)) {
      entry.forEach(visit);
    } else if (entry && typeof entry === "object") {
      Object.values(entry).forEach(visit);
    }
  };
  visit(value);
}

describe("UI metadata routes", () => {
  it("enumerates stable dashboard views", async () => {
    const response = await request(createApp(), "GET", "/api/views");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ views: expect.any(Array) });
    expect(response.body.views).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "board", label: "Board" }),
      expect.objectContaining({ id: "settings", label: "Settings" }),
      expect.objectContaining({ id: "command-center", label: "Dashboard" }),
      expect.objectContaining({ id: "dev-server", aliases: ["devserver"] }),
      expect.objectContaining({ id: "task-detail", internal: true }),
    ]));
    // The route must serve the registry payload verbatim — no filtering, reshaping or reordering.
    expect(response.body).toEqual(overWire(buildViewsPayload()));
    expectJsonSafe(response.body);
  });

  it("enumerates selectable settings sections without group-header rows", async () => {
    const response = await request(createApp(), "GET", "/api/settings/sections");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sections: expect.any(Array) });
    expect(response.body.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "general", label: "General · Project", scope: "project", group: "Project" }),
      expect.objectContaining({ id: "merge", keywords: expect.any(Array), searchableKeys: expect.any(Array) }),
      expect.objectContaining({ id: "project-models", advanced: false }),
      expect.objectContaining({ id: "authentication", scope: null, group: "AI & Models" }),
    ]));
    expect(response.body.sections.some((section: { id: string }) => section.id.startsWith("__"))).toBe(false);
    expect(response.body).toEqual(overWire(buildSettingsSectionsPayload()));
    expectJsonSafe(response.body);
  });
});
