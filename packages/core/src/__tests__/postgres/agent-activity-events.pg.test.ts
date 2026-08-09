/*
FNXC:AgentActivityStream 2026-08-09-12:27:
The durable stream must remain partitioned and cursor-ordered in the real Postgres
backend; unit mocks cannot prove the counter/outbox contract.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { appendAgentActivityEvent, queryAgentActivityEvents } from "../../task-store/async/async-agent-activity.js";
import { resolveAgentActivityAttribution } from "../../task-store/agent-activity-outbox.js";

pgDescribe("agent activity outbox (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_agent_activity_events", projectId: "agent-activity-a" });
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);
  const input = (discriminator: string) => ({ type: "task:started" as const, attributionClaim: resolveAgentActivityAttribution([{ id: "executor", provenance: "lane" }], "executor"), taskId: "FN-8864", occurredAt: "2026-08-09T00:00:00.000Z", discriminator, metadata: { runId: "exec_FN-8864_12345678" } });

  it("registers the migration and persists a project-scoped seq outbox row", async () => {
    const tables = await h.adminDb().execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'project' AND table_name IN ('agent_activity_events', 'agent_activity_event_seq')`);
    expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual(expect.arrayContaining(["agent_activity_events", "agent_activity_event_seq"]));
    const event = await appendAgentActivityEvent(h.layer(), input("one"));
    expect(event).toMatchObject({ seq: "1", agentId: "executor", agentAttribution: "lane", type: "task:started" });
    const other = { ...h.layer(), projectId: "agent-activity-b" };
    expect((await queryAgentActivityEvents(other, {})).events).toEqual([]);
  });

  it("deduplicates a replay without burning a cursor and pages in seq order", async () => {
    const first = await appendAgentActivityEvent(h.layer(), input("same"));
    expect(await appendAgentActivityEvent(h.layer(), input("same"))).toBeNull();
    const second = await appendAgentActivityEvent(h.layer(), input("next"));
    expect([first?.seq, second?.seq]).toEqual(["1", "2"]);
    expect((await queryAgentActivityEvents(h.layer(), { limit: 1 })).events.map((event) => event.seq)).toEqual(["2"]);
    expect((await queryAgentActivityEvents(h.layer(), { since: "0", order: "asc" })).events.map((event) => event.seq)).toEqual(["1", "2"]);
  });

  it("paginates and composes durable seq filters without timestamp tie-breaks", async () => {
    const sameInstant = "2026-08-09T00:00:00.000Z";
    for (const [taskId, discriminator] of [["FN-1", "one"], ["FN-2", "two"], ["FN-1", "three"], ["FN-3", "four"]] as const) {
      await appendAgentActivityEvent(h.layer(), {
        ...input(discriminator),
        taskId,
        occurredAt: sameInstant,
      });
    }
    const newest = await queryAgentActivityEvents(h.layer(), { limit: 2 });
    const older = await queryAgentActivityEvents(h.layer(), { before: newest.nextCursor!, limit: 2 });
    expect([...newest.events, ...older.events].map((item) => item.seq)).toEqual(["4", "3", "2", "1"]);
    expect((await queryAgentActivityEvents(h.layer(), { since: "2", order: "asc" })).events.map((item) => item.seq)).toEqual(["3", "4"]);
    expect((await queryAgentActivityEvents(h.layer(), { taskId: "FN-1", type: "task:started" })).events.map((item) => item.seq)).toEqual(["3", "1"]);
  });

  it("uses the default SQL limit when a programmatic caller supplies NaN", async () => {
    await appendAgentActivityEvent(h.layer(), input("finite-limit"));
    await expect(queryAgentActivityEvents(h.layer(), { limit: Number.NaN })).resolves.toMatchObject({
      events: [expect.objectContaining({ eventId: expect.any(String) })],
    });
  });
});
