/**
 * FNXC:DashboardSSE 2026-06-28-13:15:
 * SSE live-push parity for the PG-backend async satellite stores. The dashboard SSE
 * handler subscribes to store EventEmitter events for live refresh; in PG backend mode
 * the async wrappers (AsyncMissionStore / AsyncResearchStore / AsyncInsightStore) used to
 * be plain classes that never emitted, so the dashboard only refreshed on manual reload.
 *
 * This suite proves the async wrappers now extend EventEmitter and emit the SAME events
 * their sync counterparts emit, from the SAME mutation methods: mutating through the
 * cached store instance (the SAME object SSE subscribes to) fires the expected event with
 * the persisted-entity payload. It guards the live-push contract so a future refactor that
 * drops an emit re-breaks the gate, not just production SSE.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncMissionStore } from "../../async-stores/async-mission-store.js";
import type { AsyncResearchStore } from "../../async-stores/async-research-store.js";
import type { AsyncInsightStore } from "../../async-stores/async-insight-store.js";

const pgTest = pgDescribe;

pgTest("Async satellite stores emit SSE events (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_async_store_events",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode the getters return the async wrappers (cast to the async type for
  // the typed mutation methods, and EventEmitter for the event-subscription surface SSE
  // uses).
  const missions = (): AsyncMissionStore => h.store().getMissionStore() as AsyncMissionStore;
  const research = (): AsyncResearchStore => h.store().getResearchStore() as AsyncResearchStore;
  const insights = (): AsyncInsightStore => h.store().getInsightStore() as AsyncInsightStore;

  it("the async wrappers are EventEmitters (the SSE subscription surface)", () => {
    expect(missions()).toBeInstanceOf(EventEmitter);
    expect(research()).toBeInstanceOf(EventEmitter);
    expect(insights()).toBeInstanceOf(EventEmitter);
  });

  it("AsyncMissionStore.createMission emits mission:created with the mission payload", async () => {
    const m = missions();
    const events: unknown[] = [];
    m.on("mission:created", (mission) => events.push(mission));

    const created = await m.createMission({ title: "Ship payments" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: created.id, title: "Ship payments" });
  });

  it("AsyncMissionStore cascade mutations emit milestone:created / slice:created / feature:created", async () => {
    const m = missions();
    const milestoneEvents: unknown[] = [];
    const sliceEvents: unknown[] = [];
    const featureEvents: unknown[] = [];
    m.on("milestone:created", (x) => milestoneEvents.push(x));
    m.on("slice:created", (x) => sliceEvents.push(x));
    m.on("feature:created", (x) => featureEvents.push(x));

    const mission = await m.createMission({ title: "Mission with hierarchy" });
    const milestone = await m.addMilestone(mission.id, { title: "M1" });
    const slice = await m.addSlice(milestone.id, { title: "S1" });
    const feature = await m.addFeature(slice.id, { title: "F1" });

    expect(milestoneEvents).toContainEqual(expect.objectContaining({ id: milestone.id }));
    expect(sliceEvents).toContainEqual(expect.objectContaining({ id: slice.id }));
    expect(featureEvents).toContainEqual(expect.objectContaining({ id: feature.id }));
  });

  it("AsyncResearchStore.createRun emits run:created with the run payload", async () => {
    const s = research();
    const events: unknown[] = [];
    s.on("run:created", (run) => events.push(run));

    const run = await s.createRun({ query: "What is RAG?", topic: "RAG" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: run.id, query: "What is RAG?" });
  });

  it("AsyncResearchStore.updateStatus emits run:status_changed (+ run:completed on terminal)", async () => {
    const s = research();
    const statusEvents: unknown[] = [];
    const completedEvents: unknown[] = [];
    s.on("run:status_changed", (run) => statusEvents.push(run));
    s.on("run:completed", (run) => completedEvents.push(run));

    const run = await s.createRun({ query: "Status flow" });
    await s.updateStatus(run.id, "running");
    await s.updateStatus(run.id, "completed");

    // Two status transitions → two run:status_changed; one terminal → one run:completed.
    expect(statusEvents).toHaveLength(2);
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({ id: run.id, status: "completed" });
  });

  it("AsyncInsightStore.createRun emits run:created with the run payload", async () => {
    const s = insights();
    const events: unknown[] = [];
    s.on("run:created", (run) => events.push(run));

    const run = await s.createRun("P-EVT", { trigger: "manual" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: run.id, projectId: "P-EVT" });
  });

  it("AsyncInsightStore.upsertInsight emits insight:created then insight:updated by fingerprint", async () => {
    const s = insights();
    const createdEvents: unknown[] = [];
    const updatedEvents: unknown[] = [];
    s.on("insight:created", (insight) => createdEvents.push(insight));
    s.on("insight:updated", (insight) => updatedEvents.push(insight));

    const first = await s.upsertInsight("P-EVT", {
      title: "Use prepared statements",
      content: "v1",
      category: "security",
      fingerprint: "FP-EVT",
    });
    // Create path → insight:created.
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({ id: first.id });
    expect(updatedEvents).toHaveLength(0);

    const second = await s.upsertInsight("P-EVT", {
      title: "Use prepared statements",
      content: "v2",
      category: "security",
      fingerprint: "FP-EVT",
    });
    // Fingerprint-match update path → insight:updated (same row id).
    expect(second.id).toBe(first.id);
    expect(createdEvents).toHaveLength(1);
    expect(updatedEvents).toHaveLength(1);
    expect(updatedEvents[0]).toMatchObject({ id: first.id, content: "v2" });
  });
});
