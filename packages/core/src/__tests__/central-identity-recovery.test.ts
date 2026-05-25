import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CentralCore } from "../central-core.js";
import { Database, readProjectIdentity, writeProjectIdentity } from "../db.js";

describe("FN-5411: project identity recovery", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reattaches stored project identity after central projects wipe", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "fn-5411-global-"));
    const projectDir = mkdtempSync(join(tmpdir(), "fn-5411-project-"));
    cleanup.push(globalDir, projectDir);

    const central = new CentralCore(globalDir);
    await central.init();

    const first = await central.ensureProjectForPath({
      path: projectDir,
      name: "identity-recovery",
    });
    const oldId = first.project.id;
    writeProjectIdentity(projectDir, {
      id: oldId,
      createdAt: first.project.createdAt,
      firstSeenPath: projectDir,
    });

    const db = new Database(join(projectDir, ".fusion"));
    db.init();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO todo_lists (id, projectId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
      .run("todo_1", oldId, "List", now, now);
    db.prepare("INSERT INTO chat_sessions (id, agentId, title, status, projectId, createdAt, updatedAt, inFlightGeneration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("chat_1", "agent_1", "Chat", "active", oldId, now, now, "none");
    db.prepare("INSERT INTO project_insights (id, projectId, title, content, category, status, fingerprint, provenance, lastRunId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("ins_1", oldId, "Insight", "Body", "architecture", "generated", "fp_1", "test", null, now, now);
    db.close();

    await central.unregisterProject(oldId);

    const storedIdentity = readProjectIdentity(projectDir);
    const second = await central.ensureProjectForPath({
      path: projectDir,
      identity: storedIdentity ? { id: storedIdentity.id, createdAt: storedIdentity.createdAt } : undefined,
      name: "identity-recovery",
    });

    expect(second.outcome).toBe("reattached");
    expect(second.project.id).toBe(oldId);

    const verifyDb = new Database(join(projectDir, ".fusion"));
    verifyDb.init();
    const todoCount = verifyDb.prepare("SELECT COUNT(*) as count FROM todo_lists WHERE projectId = ?").get(oldId) as { count: number };
    const chatCount = verifyDb.prepare("SELECT COUNT(*) as count FROM chat_sessions WHERE projectId = ?").get(oldId) as { count: number };
    const insightCount = verifyDb.prepare("SELECT COUNT(*) as count FROM project_insights WHERE projectId = ?").get(oldId) as { count: number };
    verifyDb.close();

    expect(todoCount.count).toBe(1);
    expect(chatCount.count).toBe(1);
    expect(insightCount.count).toBe(1);

    expect(readProjectIdentity(projectDir)?.id).toBe(oldId);

    const all = await central.listProjects();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(oldId);

    await central.close();
  });
});
