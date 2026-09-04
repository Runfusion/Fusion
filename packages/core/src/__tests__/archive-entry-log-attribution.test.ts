import { describe, expect, it } from "vitest";
import { taskToArchiveEntryImpl } from "../task-store/archive-lifecycle-2.js";
import type { TaskStore } from "../store.js";
import type { Task } from "../types.js";

/*
FNXC:ArchiveLogAttribution 2026-09-04-11:50:
The cold snapshot used to record a single anonymous `Task archived` entry, so an engine
retention sweep and an operator's manual archive were indistinguishable after the fact.
These tests pin the attributed action string at the one funnel every archive path
routes through.
*/
describe("taskToArchiveEntryImpl archive log attribution", () => {
  const stubStore = {
    getSettingsFast: async () => ({}),
    readPromptForArchive: async () => null,
    buildArchivedAgentLogFields: async () => ({}),
  } as unknown as TaskStore;

  const task = {
    id: "FN-9001",
    title: "Archive attribution fixture",
    description: "",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  } as unknown as Task;

  const archivedAt = "2026-09-04T12:00:00.000Z";

  it("records caller class, agent, and origin column when an audit context is supplied", async () => {
    const entry = await taskToArchiveEntryImpl(stubStore, task, archivedAt, {
      agentId: "engine",
      runId: `auto-archive-FN-9001-1`,
      callerKind: "engine",
    });
    expect(entry.log).toHaveLength(1);
    expect(entry.log[0].timestamp).toBe(archivedAt);
    expect(entry.log[0].action).toBe("Task archived from done by engine (engine)");
  });

  it("falls back to api-unattributed/system when no audit context is passed (legacy callers)", async () => {
    const entry = await taskToArchiveEntryImpl(stubStore, task, archivedAt);
    expect(entry.log).toHaveLength(1);
    expect(entry.log[0].action).toBe("Task archived from done by api-unattributed (system)");
  });

  it("reflects the pre-archive column, not the archive lane", async () => {
    const wip = { ...task, column: "in progress" } as unknown as Task;
    const entry = await taskToArchiveEntryImpl(stubStore, wip, archivedAt, {
      agentId: "cli",
      runId: "cli-archive-FN-9001-1",
      callerKind: "operator-cli",
    });
    expect(entry.log[0].action).toBe("Task archived from in progress by operator-cli (cli)");
    expect(entry.column).toBe("archived");
  });
});
