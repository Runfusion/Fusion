import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@fusion/core";
import { AiSessionStore, type AiSessionRow, type AiSessionStatus } from "./ai-session-store.js";

describe("AiSessionStore.listActive", () => {
  let tmpRoot: string;
  let db: Database;
  let store: AiSessionStore;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-ai-session-store-"));
    db = new Database(join(tmpRoot, ".fusion"));
    db.init();
    store = new AiSessionStore(db);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // no-op
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function createSession(id: string, status: AiSessionStatus, projectId: string | null = null): AiSessionRow {
    const now = new Date().toISOString();
    return {
      id,
      type: "planning",
      status,
      title: `Session ${id}`,
      inputPayload: JSON.stringify({ plan: `plan-${id}` }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: status === "complete" ? JSON.stringify({ title: "Done" }) : null,
      thinkingOutput: "",
      error: status === "error" ? "boom" : null,
      projectId,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("returns generating, awaiting_input, and complete sessions", () => {
    store.upsert(createSession("S-1", "generating"));
    store.upsert(createSession("S-2", "awaiting_input"));
    store.upsert(createSession("S-3", "complete"));
    store.upsert(createSession("S-4", "error"));

    const active = store.listActive();
    const statuses = active.map((session) => session.status).sort();

    expect(statuses).toEqual(["awaiting_input", "complete", "generating"]);
    expect(active.map((session) => session.id)).toEqual(expect.arrayContaining(["S-1", "S-2", "S-3"]));
  });

  it("excludes sessions with error status", () => {
    store.upsert(createSession("S-err", "error"));

    const active = store.listActive();

    expect(active).toEqual([]);
  });

  it("filters active sessions by projectId", () => {
    store.upsert(createSession("S-a1", "generating", "project-a"));
    store.upsert(createSession("S-a2", "complete", "project-a"));
    store.upsert(createSession("S-b1", "awaiting_input", "project-b"));
    store.upsert(createSession("S-none", "complete", null));

    const projectA = store.listActive("project-a");

    expect(projectA).toHaveLength(2);
    expect(projectA.map((session) => session.id).sort()).toEqual(["S-a1", "S-a2"]);
    expect(projectA.every((session) => session.projectId === "project-a")).toBe(true);
  });
});
