import { afterAll, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createChatFusionToolset, type ChatFusionToolsetOptions } from "../chat.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-chat-archive-attribution-"));
afterAll(() => fs.rmSync(testRootDir, { recursive: true, force: true }));

/*
FNXC:ArchiveLogAttribution 2026-09-23-23:01:
BEHAVIOURAL CHAT ATTRIBUTION, THROUGH THE REAL ENGINE FACTORIES (this file deliberately does not
mock `@fusion/engine`). A project chat session is bound to a permanent agent — its archives must
name that agent in the cold log, not the generic "chat", and must never record the archived task as
the caller's own task. This drives the real `createChatFusionToolset` wiring into the real
`fn_task_archive` implementation and asserts what reaches `archiveTask`.
*/

it("attributes a project chat archive to the bound agent, with no caller task", async () => {
  const archiveTask = vi.fn(async (...args: unknown[]) => ({ id: String(args[0]), column: "archived" }));
  const taskStore = {
    getSettings: async () => ({}),
    archiveTask,
  } as unknown as TaskStore;

  const tools = await createChatFusionToolset({
    taskStore,
    rootDir: testRootDir,
    agentId: "agent-77",
    actionGateContext: { agentId: "agent-77", agentName: "Agent 77", isEphemeral: false } as unknown as NonNullable<ChatFusionToolsetOptions["actionGateContext"]>,
  });

  const archiveTool = tools.find((tool) => tool.name === "fn_task_archive");
  expect(archiveTool).toBeDefined();
  await (archiveTool as { execute: (...args: unknown[]) => Promise<unknown> }).execute("run", { id: "FN-9001" });

  const audit = (archiveTask.mock.calls[0] as [string, { auditContext: { agentId: string; taskId?: string; callerKind?: string } }])[1].auditContext;
  expect(audit.agentId).toBe("agent-77");
  expect(audit.callerKind).toBe("agent-tool");
  // Project chat has no caller task; pre-fix this claimed the archived task itself.
  expect(audit.taskId).toBeUndefined();
});