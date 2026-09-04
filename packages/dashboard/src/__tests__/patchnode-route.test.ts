// @vitest-environment node
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { PatchnodeEntry } from "@fusion/core";
import { registerPatchnodeRoutes } from "../routes/register-patchnode-routes.js";
import { request } from "../test-request.js";

const entries: PatchnodeEntry[] = [
  {
    entryId: "completed:FN-2:2",
    taskId: "FN-2",
    kind: "completed",
    occurrenceKey: "2",
    day: "2026-08-28",
    occurredAt: "2026-08-28T11:00:00Z",
    title: "Second delivery",
    body: "Added search",
  },
  {
    entryId: "completed:FN-1:1",
    taskId: "FN-1",
    kind: "completed",
    occurrenceKey: "1",
    day: "2026-08-27",
    occurredAt: "2026-08-27T10:00:00Z",
    title: "First delivery",
    body: "Added ledger",
  },
];

function app(result = { entries, totalEntries: entries.length, hasMore: false }) {
  const router = express.Router();
  const store = { listPatchnodeEntries: vi.fn().mockResolvedValue(result) };
  registerPatchnodeRoutes({ router, getProjectContext: vi.fn().mockResolvedValue({ store }) } as never);
  const server = express();
  server.use("/api", router);
  server.use((error: { statusCode?: number; status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message });
  });
  return { server, store };
}

describe("Patchnode route", () => {
  it("returns a newest-first day-grouped feed", async () => {
    const response = await request(app().server, "GET", "/api/patchnode");
    expect(response.status).toBe(200);
    expect(response.body.days.map((day: { day: string }) => day.day)).toEqual(["2026-08-28", "2026-08-27"]);
    expect(response.body).toMatchObject({ totalEntries: 2, hasMore: false });
  });

  it("forwards text search and preserves grouping", async () => {
    const { server, store } = app({ entries: [entries[1]!], totalEntries: 1, hasMore: false });
    const response = await request(server, "GET", "/api/patchnode?q=ledger");
    expect(response.status).toBe(200);
    expect(store.listPatchnodeEntries).toHaveBeenCalledWith(expect.objectContaining({ query: "ledger" }));
    expect(response.body.days[0].entries[0].taskId).toBe("FN-1");
  });

  it("rejects invalid limit and date parameters", async () => {
    expect(await request(app().server, "GET", "/api/patchnode?limit=-1")).toMatchObject({ status: 400, body: { error: expect.stringContaining("limit") } });
    expect(await request(app().server, "GET", "/api/patchnode?from=yesterday")).toMatchObject({ status: 400, body: { error: expect.stringContaining("from") } });
  });

  it("returns an empty feed rather than not-found", async () => {
    const response = await request(app({ entries: [], totalEntries: 0, hasMore: false }).server, "GET", "/api/patchnode");
    expect(response).toMatchObject({ status: 200, body: { days: [], totalEntries: 0, hasMore: false } });
  });

  it("preserves store pagination state", async () => {
    const response = await request(app({ entries: [entries[0]!], totalEntries: 2, hasMore: true }).server, "GET", "/api/patchnode?limit=1");
    expect(response.body.hasMore).toBe(true);
  });

  it("keeps two deliveries of one task and requires no task lookup", async () => {
    const duplicateTaskEntries = [
      entries[0]!,
      { ...entries[1]!, entryId: "completed:FN-2:1", taskId: "FN-2", title: "Older title", body: "Older summary" },
    ];
    const { server, store } = app({ entries: duplicateTaskEntries, totalEntries: 2, hasMore: false });
    const response = await request(server, "GET", "/api/patchnode");
    expect(response.body.days.flatMap((day: { entries: PatchnodeEntry[] }) => day.entries).map((entry: PatchnodeEntry) => entry.body)).toEqual(["Added search", "Older summary"]);
    expect(store).not.toHaveProperty("getTask");
  });
});
