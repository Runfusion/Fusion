/*
FNXC:AgentActivityStream 2026-08-09-22:35:
FN-8915 publishes the agent-activity cursor contract. These PostgreSQL checks pin its wire shape,
exclusive bounds, and lossless descending handoff against the transactional outbox rather than mocks.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { AGENT_ACTIVITY_RETENTION_MS, AGENT_ACTIVITY_RETENTION_ROW_CAP, appendAgentActivityEvent, pruneAgentActivityEvents, queryAgentActivityEvents } from "../../task-store/async/async-agent-activity.js";
import { resolveAgentActivityAttribution } from "../../task-store/agent-activity-outbox.js";

pgDescribe("agent activity cursor contract (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_agent_activity_contract", projectId: "agent-activity-contract" });
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);

  const laneClaim = resolveAgentActivityAttribution([{ id: "executor", provenance: "lane" }], "executor");
  const append = (discriminator: string, occurredAt = "2026-08-09T00:00:00.000Z", extra = {}) => appendAgentActivityEvent(h.layer(), {
    type: "task:started", attributionClaim: laneClaim, taskId: "FN-8915", occurredAt, discriminator, metadata: { runId: "exec_FN-8915_12345678" }, ...extra,
  });
  const seed = async (count: number) => { for (let index = 1; index <= count; index++) await append(`seed-${index}`); };

  it("pins the documented wire set, decimal seq, and exact response envelope", async () => {
    // docs/agent-activity-contract.md#wire-shape
    await append("wire");
    const page = await queryAgentActivityEvents(h.layer());
    expect(Object.keys(page).sort()).toEqual(["events", "nextCursor"]);
    expect(Object.keys(page.events[0]!).sort()).toEqual(["agentAttribution", "agentId", "eventId", "fromAgentId", "metadata", "occurredAt", "projectId", "seq", "summary", "taskId", "toAgentId", "type"]);
    expect(page.events[0]!.seq).toMatch(/^\d+$/);
  });

  it("uses exclusive bounds, strict seq ordering, and null ascending cursors", async () => {
    // docs/agent-activity-contract.md#bounds-and-ordering and #cursor-and-continuation
    await seed(5);
    expect((await queryAgentActivityEvents(h.layer(), { before: "3" })).events.map(({ seq }) => seq)).toEqual(["2", "1"]);
    expect((await queryAgentActivityEvents(h.layer(), { since: "3" })).events.map(({ seq }) => seq)).toEqual(["5", "4"]);
    expect((await queryAgentActivityEvents(h.layer(), { since: "1", before: "5" })).events.map(({ seq }) => seq)).toEqual(["4", "3", "2"]);
    expect((await queryAgentActivityEvents(h.layer(), { order: "asc", limit: 2 })).events.map(({ seq }) => seq)).toEqual(["1", "2"]);
    expect((await queryAgentActivityEvents(h.layer(), { order: "asc", limit: 2 })).nextCursor).toBeNull();
  });

  it("does not advertise dead cursors and accepts a zero limit", async () => {
    // docs/agent-activity-contract.md#cursor-and-continuation and #filters-and-limits
    await expect(queryAgentActivityEvents(h.layer(), { limit: 0 })).resolves.toEqual({ events: [], nextCursor: null });
    await append("only");
    await expect(queryAgentActivityEvents(h.layer(), { limit: 1 })).resolves.toMatchObject({ nextCursor: null });
    await append("older");
    const page = await queryAgentActivityEvents(h.layer(), { limit: 1 });
    expect(page.nextCursor).toBe(page.events.at(-1)!.seq);
  });

  it("walks a descending range without duplicates or gaps during concurrent appends", async () => {
    // docs/agent-activity-contract.md#lossless-cursor-mode
    await seed(7);
    const first = await queryAgentActivityEvents(h.layer(), { limit: 2 });
    await append("concurrent-8"); await append("concurrent-9"); await append("concurrent-10");
    const events = [...first.events];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await queryAgentActivityEvents(h.layer(), { before: cursor, limit: 2 });
      events.push(...page.events);
      cursor = page.nextCursor;
    }
    const seqs = events.map(({ seq }) => seq);
    expect(seqs).toEqual(["7", "6", "5", "4", "3", "2", "1"]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("nulls non-roster from and to attribution claims", async () => {
    // docs/agent-activity-contract.md#wire-shape
    const event = await append("non-roster", "2026-08-09T00:00:00.000Z", { fromAgentIdClaim: laneClaim, toAgentIdClaim: laneClaim });
    expect(event).toMatchObject({ fromAgentId: null, toAgentId: null });
  });

  it("prunes aged rows without rewinding the project counter", async () => {
    // docs/agent-activity-contract.md#append-only-and-retention
    await append("stale", new Date(Date.now() - AGENT_ACTIVITY_RETENTION_MS - 1_000).toISOString());
    await append("fresh", new Date().toISOString());
    await pruneAgentActivityEvents(h.layer());
    expect((await queryAgentActivityEvents(h.layer())).events.map(({ seq }) => seq)).toEqual(["2"]);
    const counter = await h.adminDb().execute(sql`SELECT last_seq FROM project.agent_activity_event_seq WHERE project_id = 'agent-activity-contract'`);
    expect(String((counter as unknown as Array<{ last_seq: string }>)[0]!.last_seq)).toBe("2");
    expect((await append("after-prune"))?.seq).toBe("3");
  });

  it("pins the exported retention constants without a slow row-cap fixture", () => {
    // docs/agent-activity-contract.md#claim-to-proof-coverage
    expect(AGENT_ACTIVITY_RETENTION_MS).toBe(30 * 86_400_000);
    expect(AGENT_ACTIVITY_RETENTION_ROW_CAP).toBe(50_000);
  });
});
