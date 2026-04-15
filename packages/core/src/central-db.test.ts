import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentralDatabase, createCentralDatabase, toJson, fromJson } from "./central-db.js";

describe("CentralDatabase", () => {
  let tempDir: string;
  let db: CentralDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-central-test-"));
    db = createCentralDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("should create database at the specified path", () => {
      db.init();
      const dbPath = db.getPath();
      expect(dbPath).toBe(join(tempDir, "fusion-central.db"));
      // Verify file exists
      const stats = statSync(dbPath);
      expect(stats.isFile()).toBe(true);
    });

    it("should create the global directory if it doesn't exist", () => {
      const newTempDir = join(tmpdir(), `kb-central-test-${Date.now()}`);
      const newDb = createCentralDatabase(newTempDir);
      newDb.init();
      expect(statSync(newTempDir).isDirectory()).toBe(true);
      newDb.close();
      rmSync(newTempDir, { recursive: true, force: true });
    });

    it("should initialize schema version", () => {
      db.init();
      expect(db.getSchemaVersion()).toBe(5);
    });

    it("should seed lastModified on init", () => {
      db.init();
      const lastModified = db.getLastModified();
      expect(lastModified).toBeGreaterThan(0);
    });

    it("should seed globalConcurrency default row", () => {
      db.init();
      const row = db.prepare("SELECT * FROM globalConcurrency WHERE id = 1").get() as {
        id: number;
        globalMaxConcurrent: number;
        currentlyActive: number;
        queuedCount: number;
      } | undefined;
      expect(row).toBeDefined();
      expect(row?.globalMaxConcurrent).toBe(4);
      expect(row?.currentlyActive).toBe(0);
      expect(row?.queuedCount).toBe(0);
    });

    it("should apply nodes defaults when optional values are omitted", () => {
      db.init();
      const now = new Date().toISOString();

      db.prepare(
        "INSERT INTO nodes (id, name, type, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
      ).run("node_test", "local-test", "local", now, now);

      const row = db.prepare("SELECT status, maxConcurrent FROM nodes WHERE id = ?").get("node_test") as
        | {
            status: string;
            maxConcurrent: number;
          }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.status).toBe("offline");
      expect(row?.maxConcurrent).toBe(2);
    });

    it("should create all required tables", () => {
      db.init();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("projects");
      expect(tableNames).toContain("projectHealth");
      expect(tableNames).toContain("centralActivityLog");
      expect(tableNames).toContain("globalConcurrency");
      expect(tableNames).toContain("nodes");
      expect(tableNames).toContain("peerNodes");
      expect(tableNames).toContain("__meta");
    });

    it("should include nodeId column on projects table", () => {
      db.init();

      const columns = db.prepare("PRAGMA table_info(projects)").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).toContain("nodeId");
    });

    it("should include systemMetrics and knownPeers columns on nodes table", () => {
      db.init();

      const columns = db.prepare("PRAGMA table_info(nodes)").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).toContain("systemMetrics");
      expect(columnNames).toContain("knownPeers");
    });

    it("should include versionInfo and pluginVersions columns on nodes table", () => {
      db.init();

      const columns = db.prepare("PRAGMA table_info(nodes)").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).toContain("versionInfo");
      expect(columnNames).toContain("pluginVersions");
    });

    it("should create peerNodes table with expected columns", () => {
      db.init();

      const columns = db.prepare("PRAGMA table_info(peerNodes)").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((column) => column.name);

      expect(columnNames).toEqual(
        expect.arrayContaining([
          "id",
          "nodeId",
          "peerNodeId",
          "name",
          "url",
          "status",
          "lastSeen",
          "connectedAt",
        ]),
      );
    });

    it("should create required indexes", () => {
      db.init();
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("idxProjectsPath");
      expect(indexNames).toContain("idxProjectsStatus");
      expect(indexNames).toContain("idxActivityLogTimestamp");
      expect(indexNames).toContain("idxActivityLogType");
      expect(indexNames).toContain("idxActivityLogProjectId");
      expect(indexNames).toContain("idxNodesStatus");
      expect(indexNames).toContain("idxNodesType");
      expect(indexNames).toContain("idxPeerNodesNodeId");
    });
  });

  describe("schema migrations", () => {
    it("should migrate from v2 to v3 with mesh node columns and peer table", () => {
      const now = new Date().toISOString();

      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'active',
          isolationMode TEXT NOT NULL DEFAULT 'in-process',
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          lastActivityAt TEXT,
          nodeId TEXT,
          settings TEXT
        );

        CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK (type IN ('local', 'remote')),
          url TEXT,
          apiKey TEXT,
          status TEXT NOT NULL DEFAULT 'offline',
          capabilities TEXT,
          maxConcurrent INTEGER NOT NULL DEFAULT 2,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS __meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);

      db.prepare("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '2')").run();
      db.prepare("INSERT INTO __meta (key, value) VALUES ('lastModified', ?)").run(String(Date.now()));
      db.prepare(
        "INSERT INTO nodes (id, name, type, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
      ).run("node_legacy", "legacy", "local", now, now);

      db.init();

      expect(db.getSchemaVersion()).toBe(5);

      const nodeColumns = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
      const nodeColumnNames = nodeColumns.map((column) => column.name);
      expect(nodeColumnNames).toContain("systemMetrics");
      expect(nodeColumnNames).toContain("knownPeers");

      const peerTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='peerNodes'")
        .get() as { name: string } | undefined;
      expect(peerTable?.name).toBe("peerNodes");

      const peerIndexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='peerNodes'")
        .all() as Array<{ name: string }>;
      expect(peerIndexes.map((index) => index.name)).toContain("idxPeerNodesNodeId");
    });

    it("should migrate from v3 to v4 with version tracking columns", () => {
      const now = new Date().toISOString();

      // Create v3 schema manually
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'active',
          isolationMode TEXT NOT NULL DEFAULT 'in-process',
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          lastActivityAt TEXT,
          nodeId TEXT,
          settings TEXT
        );

        CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK (type IN ('local', 'remote')),
          url TEXT,
          apiKey TEXT,
          status TEXT NOT NULL DEFAULT 'offline',
          capabilities TEXT,
          systemMetrics TEXT,
          knownPeers TEXT,
          maxConcurrent INTEGER NOT NULL DEFAULT 2,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS __meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);

      db.prepare("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '3')").run();
      db.prepare("INSERT INTO __meta (key, value) VALUES ('lastModified', ?)").run(String(Date.now()));
      db.prepare(
        "INSERT INTO nodes (id, name, type, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
      ).run("node_v3", "v3-node", "local", now, now);

      db.init();

      expect(db.getSchemaVersion()).toBe(5);

      const nodeColumns = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
      const nodeColumnNames = nodeColumns.map((column) => column.name);
      expect(nodeColumnNames).toContain("versionInfo");
      expect(nodeColumnNames).toContain("pluginVersions");

      // Verify nullable columns - can insert node without them
      const row = db.prepare("SELECT versionInfo, pluginVersions FROM nodes WHERE id = ?").get("node_v3") as {
        versionInfo: string | null;
        pluginVersions: string | null;
      } | undefined;
      expect(row).toBeDefined();
      expect(row?.versionInfo).toBeNull();
      expect(row?.pluginVersions).toBeNull();
    });
  });

  describe("transactions", () => {
    beforeEach(() => {
      db.init();
    });

    it("should support basic transactions", () => {
      db.transaction(() => {
        db.prepare("INSERT INTO projects (id, name, path, status, isolationMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          "proj_1",
          "Test Project",
          "/test/path",
          "active",
          "in-process",
          new Date().toISOString(),
          new Date().toISOString()
        );
      });

      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get("proj_1") as { id: string; name: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.name).toBe("Test Project");
    });

    it("should rollback on error", () => {
      expect(() => {
        db.transaction(() => {
          db.prepare("INSERT INTO projects (id, name, path, status, isolationMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            "proj_2",
            "Test Project",
            "/test/path",
            "active",
            "in-process",
            new Date().toISOString(),
            new Date().toISOString()
          );
          throw new Error("Intentional error");
        });
      }).toThrow("Intentional error");

      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get("proj_2") as { id: string } | undefined;
      expect(row).toBeUndefined();
    });

    it("should support nested transactions via savepoints", () => {
      db.transaction(() => {
        db.prepare("INSERT INTO projects (id, name, path, status, isolationMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          "proj_outer",
          "Outer Project",
          "/outer/path",
          "active",
          "in-process",
          new Date().toISOString(),
          new Date().toISOString()
        );

        db.transaction(() => {
          db.prepare("INSERT INTO projects (id, name, path, status, isolationMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            "proj_inner",
            "Inner Project",
            "/inner/path",
            "active",
            "in-process",
            new Date().toISOString(),
            new Date().toISOString()
          );
        });
      });

      const outerRow = db.prepare("SELECT * FROM projects WHERE id = ?").get("proj_outer") as { id: string } | undefined;
      const innerRow = db.prepare("SELECT * FROM projects WHERE id = ?").get("proj_inner") as { id: string } | undefined;
      expect(outerRow).toBeDefined();
      expect(innerRow).toBeDefined();
    });

    it("should rollback nested transaction without affecting outer", () => {
      db.transaction(() => {
        db.prepare("INSERT INTO projects (id, name, path, status, isolationMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          "proj_outer_2",
          "Outer Project",
          "/outer/path",
          "active",
          "in-process",
          new Date().toISOString(),
          new Date().toISOString()
        );

        // Inner transaction throws but is caught
        try {
          db.transaction(() => {
            db.prepare("INSERT INTO projects (id, name, path, status, isolationMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              "proj_inner_2",
              "Inner Project",
              "/inner/path",
              "active",
              "in-process",
              new Date().toISOString(),
              new Date().toISOString()
            );
            throw new Error("Inner error");
          });
        } catch {
          // Ignore inner error
        }
      });

      const outerRow = db.prepare("SELECT * FROM projects WHERE id = ?").get("proj_outer_2") as { id: string } | undefined;
      const innerRow = db.prepare("SELECT * FROM projects WHERE id = ?").get("proj_inner_2") as { id: string } | undefined;
      expect(outerRow).toBeDefined();
      expect(innerRow).toBeUndefined();
    });
  });

  describe("lastModified tracking", () => {
    beforeEach(() => {
      db.init();
    });

    it("should bump lastModified", () => {
      const before = db.getLastModified();
      // Small delay to ensure different timestamp
      const start = Date.now();
      while (Date.now() < start + 2) { /* spin */ }
      
      db.bumpLastModified();
      const after = db.getLastModified();
      expect(after).toBeGreaterThan(before);
    });

    it("should guarantee monotonic increase", () => {
      db.bumpLastModified();
      const first = db.getLastModified();
      db.bumpLastModified();
      const second = db.getLastModified();
      expect(second).toBeGreaterThan(first);
    });
  });

  describe("foreign key constraints", () => {
    beforeEach(() => {
      db.init();
    });

    it("should enforce foreign key constraints", () => {
      // Try to insert health record for non-existent project
      expect(() => {
        db.prepare("INSERT INTO projectHealth (projectId, status, updatedAt) VALUES (?, ?, ?)").run(
          "nonexistent",
          "active",
          new Date().toISOString()
        );
      }).toThrow();
    });

    it("should cascade delete project health on project deletion", () => {
      const now = new Date().toISOString();
      
      db.prepare("INSERT INTO projects (id, name, path, status, isolationMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "proj_cascade",
        "Cascade Test",
        "/cascade/path",
        "active",
        "in-process",
        now,
        now
      );

      db.prepare("INSERT INTO projectHealth (projectId, status, updatedAt) VALUES (?, ?, ?)").run(
        "proj_cascade",
        "active",
        now
      );

      // Verify health record exists
      const healthBefore = db.prepare("SELECT * FROM projectHealth WHERE projectId = ?").get("proj_cascade") as { projectId: string } | undefined;
      expect(healthBefore).toBeDefined();

      // Delete project
      db.prepare("DELETE FROM projects WHERE id = ?").run("proj_cascade");

      // Health record should be gone (cascade delete)
      const healthAfter = db.prepare("SELECT * FROM projectHealth WHERE projectId = ?").get("proj_cascade") as { projectId: string } | undefined;
      expect(healthAfter).toBeUndefined();
    });

    it("should cascade delete activity log entries on project deletion", () => {
      const now = new Date().toISOString();
      
      db.prepare("INSERT INTO projects (id, name, path, status, isolationMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "proj_activity",
        "Activity Test",
        "/activity/path",
        "active",
        "in-process",
        now,
        now
      );

      db.prepare("INSERT INTO centralActivityLog (id, timestamp, type, projectId, projectName, details) VALUES (?, ?, ?, ?, ?, ?)").run(
        "log_1",
        now,
        "task:created",
        "proj_activity",
        "Activity Test",
        "Test activity"
      );

      // Verify log entry exists
      const logBefore = db.prepare("SELECT * FROM centralActivityLog WHERE id = ?").get("log_1") as { id: string } | undefined;
      expect(logBefore).toBeDefined();

      // Delete project
      db.prepare("DELETE FROM projects WHERE id = ?").run("proj_activity");

      // Log entry should be gone (cascade delete)
      const logAfter = db.prepare("SELECT * FROM centralActivityLog WHERE id = ?").get("log_1") as { id: string } | undefined;
      expect(logAfter).toBeUndefined();
    });
  });

  describe("JSON helpers", () => {
    it("should stringify arrays for JSON columns", () => {
      const arr = ["a", "b", "c"];
      expect(toJson(arr)).toBe('["a","b","c"]');
    });

    it("should return '[]' for null/undefined", () => {
      expect(toJson(null)).toBe("[]");
      expect(toJson(undefined)).toBe("[]");
    });

    it("should parse JSON columns correctly", () => {
      const json = '{"key": "value", "num": 42}';
      const parsed = fromJson<{ key: string; num: number }>(json);
      expect(parsed).toEqual({ key: "value", num: 42 });
    });

    it("should return undefined for null/empty JSON", () => {
      expect(fromJson(null)).toBeUndefined();
      expect(fromJson(undefined)).toBeUndefined();
      expect(fromJson("")).toBeUndefined();
    });

    it("should return undefined for invalid JSON", () => {
      expect(fromJson("not valid json")).toBeUndefined();
    });
  });
});
