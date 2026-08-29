/*
FNXC:MigrationHoldingPage 2026-07-17-12:50:
The boot-window holding server is the only surface a browser can reach while
the SQLite→PostgreSQL auto-migration blocks dashboard boot. These tests pin its
contract: health JSON (starting → migrating with a progress label), HTML
holding page with 503 for navigations, JSON 503 for other API calls, and a
close() that fully releases the port for the real app.listen().
*/
import { describe, expect, it } from "vitest";
import { startMigrationHoldingServer } from "../migration-holding-server.js";
import type { MigrationProgressEvent } from "@fusion/core";

const HOST = "127.0.0.1";

async function withServer(
  run: (server: NonNullable<Awaited<ReturnType<typeof startMigrationHoldingServer>>>) => Promise<void>,
): Promise<void> {
  const server = await startMigrationHoldingServer({ port: 0, host: HOST });
  expect(server).not.toBeNull();
  try {
    await run(server!);
  } finally {
    await server!.close();
  }
}

describe("startMigrationHoldingServer", () => {
  it("reports starting, then migrating with a progress label on /api/health", async () => {
    await withServer(async (server) => {
      const before = await fetch(`http://${HOST}:${server.port}/api/health`);
      expect(before.status).toBe(200);
      const beforeBody = await before.json();
      expect(beforeBody.status).toBe("starting");
      expect(beforeBody.migration).toEqual({ active: false });

      const event: MigrationProgressEvent = {
        phase: "table-progress",
        sourceSchema: "project",
        table: "tasks",
        tableIndex: 3,
        tableCount: 12,
        processedRows: 500,
        sourceRows: 2000,
      };
      server.setMigrationProgress(event);

      const after = await fetch(`http://${HOST}:${server.port}/api/health`);
      const afterBody = await after.json();
      expect(afterBody.status).toBe("migrating");
      expect(afterBody.holding).toBe(true);
      expect(afterBody.migration.active).toBe(true);
      expect(afterBody.migration.table).toBe("tasks");
      expect(afterBody.migration.processedRows).toBe(500);
      expect(afterBody.migration.sourceRows).toBe(2000);
      expect(typeof afterBody.migration.label).toBe("string");
      expect(afterBody.migration.label).toContain("tasks");
    });
  });

  it("serves a 503 HTML holding page for navigations and 503 JSON for other API calls", async () => {
    await withServer(async (server) => {
      const page = await fetch(`http://${HOST}:${server.port}/`);
      expect(page.status).toBe(503);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain("migration");
      expect(html).toContain("/api/health");

      const api = await fetch(`http://${HOST}:${server.port}/api/tasks`);
      expect(api.status).toBe(503);
      expect(api.headers.get("content-type")).toContain("application/json");
      const body = await api.json();
      expect(typeof body.error).toBe("string");
    });
  });

  it("releases the port on close so the real server can bind", async () => {
    const server = await startMigrationHoldingServer({ port: 0, host: HOST });
    expect(server).not.toBeNull();
    const port = server!.port;
    await server!.close();
    // close() is idempotent.
    await server!.close();
    await expect(fetch(`http://${HOST}:${port}/api/health`)).rejects.toThrow();
  });

  it("fails soft (returns null) when the port is already taken", async () => {
    const first = await startMigrationHoldingServer({ port: 0, host: HOST });
    expect(first).not.toBeNull();
    try {
      const messages: string[] = [];
      const second = await startMigrationHoldingServer({
        port: first!.port,
        host: HOST,
        log: (message) => messages.push(message),
      });
      expect(second).toBeNull();
      expect(messages.some((m) => m.includes("holding page not available"))).toBe(true);
    } finally {
      await first!.close();
    }
  });
});
