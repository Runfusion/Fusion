import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database, SCHEMA_VERSION } from "../db.js";
import {
  emitUsageEvent,
  queryUsageEvents,
  countUsageEventsBy,
  categorizeToolName,
  USAGE_EVENT_META_MAX_BYTES,
} from "../usage-events.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-usage-events-test-"));
}

describe("usage_events", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir);
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates usage_events table with expected columns on fresh init", () => {
    const columns = db.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "ts",
      "kind",
      "taskId",
      "agentId",
      "nodeId",
      "model",
      "provider",
      "toolName",
      "category",
      "meta",
    ]);
  });

  it("creates the ts/taskId/agentId indexes on fresh init", () => {
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='usage_events'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("idxUsageEventsTs");
    expect(indexes).toContain("idxUsageEventsTaskId");
    expect(indexes).toContain("idxUsageEventsAgentId");
  });

  it("inserts one row for a tool_call event with correct category", () => {
    const ok = emitUsageEvent(db, {
      kind: "tool_call",
      taskId: "T-1",
      agentId: "A-1",
      nodeId: "node-1",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      toolName: "Read",
    });
    expect(ok).toBe(true);

    const rows = queryUsageEvents(db, { taskId: "T-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "tool_call",
      taskId: "T-1",
      agentId: "A-1",
      nodeId: "node-1",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      toolName: "Read",
    });
  });

  it("categorizes tool names into coarse buckets", () => {
    const cases: Array<[string | null | undefined, string]> = [
      ["Read", "read"],
      ["Grep", "read"],
      ["Glob", "read"],
      ["ls", "read"],
      ["semantic_search", "read"],
      ["fn_task_list", "read"],
      ["fn_task_show", "read"],
      ["fn_task_get", "read"],
      ["fn_task_search", "read"],
      ["fn_list_agents", "read"],
      ["fn_agent_org_chart", "read"],
      ["fn_task_document_read", "read"],
      ["fn_research_list", "research"],
      ["Edit", "edit"],
      ["Write", "edit"],
      ["MultiEdit", "edit"],
      ["NotebookEdit", "edit"],
      ["fn_task_create", "edit"],
      ["fn_task_update", "edit"],
      ["fn_task_attach", "edit"],
      ["fn_task_archive", "edit"],
      ["fn_task_document_write", "edit"],
      ["Bash", "execute"],
      ["execute_command", "execute"],
      ["terminal", "execute"],
      ["WebFetch", "network"],
      ["fn_web_fetch", "network"],
      ["http_request", "network"],
      ["fn_mission_show", "planning"],
      ["fn_milestone_add", "planning"],
      ["fn_slice_activate", "planning"],
      ["fn_feature_link_task", "planning"],
      ["fn_goal_create", "planning"],
      ["fn_task_plan", "planning"],
      ["fn_research_run", "research"],
      ["fn_insight_show", "research"],
      ["fn_experiment_finalize", "research"],
      ["fn_memory_append", "memory"],
      ["fn_agent_create", "agents"],
      ["fn_delegate_task", "agents"],
      ["fn_skills_search", "skills"],
      ["fn_secret_get", "secrets"],
      ["fn_task_import_github", "github"],
      ["fn_task_import_github_issue", "github"],
      ["fn_task_browse_github_issues", "github"],
      ["fn_workflow_create", "workflow"],
      ["fn_review_spec", "workflow"],
      ["mcp__server__search", "read"],
      ["mcp__server__tool", "other"],
      ["Unknown", "other"],
      ["", "other"],
      ["   ", "other"],
      [undefined, "other"],
      [null, "other"],
    ];

    for (const [toolName, expected] of cases) {
      expect(categorizeToolName(toolName), String(toolName)).toBe(expected);
    }
  });

  it("rejects a meta payload over the byte cap at write (event skipped, nothing inserted)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const huge = "x".repeat(USAGE_EVENT_META_MAX_BYTES + 100);
    const ok = emitUsageEvent(db, {
      kind: "tool_error",
      taskId: "T-cap",
      meta: { blob: huge },
    });
    expect(ok).toBe(false);
    expect(queryUsageEvents(db, { taskId: "T-cap" })).toHaveLength(0);
    warn.mockRestore();
  });

  it("never lets tool-argument content land in meta (caller controls meta; arg helpers are not stored)", () => {
    // The write helper only persists what the caller puts in `meta`. A caller
    // that follows the contract (descriptors only) leaves no tool args behind.
    emitUsageEvent(db, {
      kind: "tool_call",
      taskId: "T-safe",
      toolName: "Bash",
      category: "execute",
      meta: { durationMs: 12 },
    });
    const rows = queryUsageEvents(db, { taskId: "T-safe" });
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ durationMs: 12 });
    // No tool-argument/content fields are present.
    const metaKeys = Object.keys(rows[0].meta ?? {});
    expect(metaKeys).not.toContain("command");
    expect(metaKeys).not.toContain("args");
    expect(metaKeys).not.toContain("content");
  });

  it("skips a malformed event (unknown kind) without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = emitUsageEvent(db, {
      // @ts-expect-error intentionally invalid kind
      kind: "not_a_real_kind",
      taskId: "T-bad",
    });
    expect(ok).toBe(false);
    expect(queryUsageEvents(db, { taskId: "T-bad" })).toHaveLength(0);
    warn.mockRestore();
  });

  it("range-queries by inclusive ts bounds, ordered ascending", () => {
    emitUsageEvent(db, { kind: "tool_call", taskId: "T-r", toolName: "Read", ts: "2026-01-01T00:00:00.000Z" });
    emitUsageEvent(db, { kind: "tool_call", taskId: "T-r", toolName: "Edit", ts: "2026-01-02T00:00:00.000Z" });
    emitUsageEvent(db, { kind: "tool_call", taskId: "T-r", toolName: "Bash", ts: "2026-01-03T00:00:00.000Z" });

    const rows = queryUsageEvents(db, {
      from: "2026-01-02T00:00:00.000Z",
      to: "2026-01-03T00:00:00.000Z",
    });
    expect(rows.map((r) => r.toolName)).toEqual(["Edit", "Bash"]);
  });

  it("counts events grouped by a column over a range", () => {
    emitUsageEvent(db, { kind: "tool_call", toolName: "Read", category: "read" });
    emitUsageEvent(db, { kind: "tool_call", toolName: "Grep", category: "read" });
    emitUsageEvent(db, { kind: "tool_call", toolName: "Bash", category: "execute" });

    const byCategory = countUsageEventsBy(db, "category");
    const map = new Map(byCategory.map((r) => [r.key, r.count]));
    expect(map.get("read")).toBe(2);
    expect(map.get("execute")).toBe(1);
  });

  it("records a chat-style event with null taskId and a set agentId", () => {
    emitUsageEvent(db, { kind: "user_message", taskId: null, agentId: "A-chat" });
    const rows = queryUsageEvents(db, { kind: "user_message" });
    expect(rows).toHaveLength(1);
    expect(rows[0].taskId).toBeNull();
    expect(rows[0].agentId).toBe("A-chat");
  });

  // Migration: seed a DB at the version JUST BEFORE usage_events was introduced
  // (117 — usage_events is the v118 migration), run migrate, assert the table
  // exists and SCHEMA_VERSION reaches the highest migration target. Pinned to
  // 117 (not SCHEMA_VERSION-1) so it keeps exercising usage_events' own
  // migration as later migrations are added. Fresh-DB tests cannot catch the
  // migrate-loop early-return bug this guards.
  it("creates usage_events when migrating from the previous schema version", () => {
    db.exec("DROP INDEX IF EXISTS idxUsageEventsTs");
    db.exec("DROP INDEX IF EXISTS idxUsageEventsTaskId");
    db.exec("DROP INDEX IF EXISTS idxUsageEventsAgentId");
    db.exec("DROP TABLE IF EXISTS usage_events");
    db.prepare("UPDATE __meta SET value = ? WHERE key = 'schemaVersion'").run("117");

    (db as unknown as { migrate: () => void }).migrate();

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_events'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe("usage_events");
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    // The migrated table is writable and queryable.
    emitUsageEvent(db, { kind: "session_start", taskId: "T-mig", agentId: "A-mig" });
    expect(queryUsageEvents(db, { taskId: "T-mig" })).toHaveLength(1);
  });

  it("SCHEMA_VERSION matches the highest applied migration on a fresh DB", () => {
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
  });
});
