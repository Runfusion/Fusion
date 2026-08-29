import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import { TaskStore } from "../../store.js";
import { ChatStore } from "../../chat/chat-store.js";

pgDescribe("project ownership declaration drift", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_fn8997" });
  beforeAll(h.beforeAll); afterAll(h.afterAll); beforeEach(h.beforeEach); afterEach(h.afterEach);

  it("keeps duplicated workflow, room, member, and message ids in a bound partition", async () => {
    /*
    FNXC:MultiProjectIsolation 2026-08-12-02:12:
    FN-8997 reproduces duplicate ids on an owner-connected cluster, where RLS bypass cannot mask missing ORM predicates. Both membership and parent-room legs must be scoped for the duplicated room id assertion to hold.
    */
    const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
    const a = bind("ownership-a"); const b = bind("ownership-b");
    const now = "2026-08-12T02:12:00.000Z";
    for (const [layer, name] of [[a, "A"], [b, "B"]] as const) {
      await layer.db.insert(schema.project.workflowSteps).values({ projectId: layer.projectId, id: "ws-1", templateId: "shared-template", name, description: name, createdAt: now, updatedAt: now });
      await layer.db.insert(schema.project.chatRooms).values({ projectId: layer.projectId, id: "room-1", name: `Room ${name}`, slug: `room-${name}`, ownerProjectId: `domain-${name}`, status: "active", createdAt: now, updatedAt: now });
      await layer.db.insert(schema.project.chatRoomMembers).values({ projectId: layer.projectId, roomId: "room-1", agentId: "agent-shared", addedAt: now });
      await layer.db.insert(schema.project.chatRoomMessages).values({ projectId: layer.projectId, id: "message-1", roomId: "room-1", role: "user", content: name, createdAt: now });
    }
    const storeA = new TaskStore(h.rootDir(), undefined, { asyncLayer: a }); await storeA.init();
    expect((await storeA.listWorkflowSteps()).filter((step) => step.id === "ws-1").map((step) => step.name)).toEqual(["A"]);
    expect((await storeA.getWorkflowStep("ws-1"))?.name).toBe("A");
    expect((await storeA.getWorkflowStep("shared-template"))?.name).toBe("A");
    await storeA.updateWorkflowStep("ws-1", { name: "A renamed" });
    expect((await h.adminDb().select().from(schema.project.workflowSteps).where(and(eq(schema.project.workflowSteps.projectId, b.projectId), eq(schema.project.workflowSteps.id, "ws-1"))))[0]?.name).toBe("B");
    await storeA.deleteWorkflowStep("ws-1");
    expect((await h.adminDb().select().from(schema.project.workflowSteps).where(and(eq(schema.project.workflowSteps.projectId, b.projectId), eq(schema.project.workflowSteps.id, "ws-1")))).length).toBe(1);

    const chatA = new ChatStore(a);
    expect((await chatA.listRoomsForAgent("agent-shared", { status: "active" })).map((room) => room.name)).toEqual(["Room A"]);
    expect((await chatA.getRoom("room-1"))?.name).toBe("Room A");
    expect((await chatA.listRoomMembers("room-1")).map((member) => member.agentId)).toEqual(["agent-shared"]);
    expect((await chatA.getRoomMessages("room-1")).map((message) => message.content)).toEqual(["A"]);
  });
});
