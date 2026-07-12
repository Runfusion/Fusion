import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CeSessionStore, PlanHandoffClaimError, STALE_INTERVAL_MULTIPLE } from "../session/session-store.js";
import { ensureCeSchema } from "../schema.js";
import { makeHarness, type TestHarness } from "./_harness.js";

let h: TestHarness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.close();
});

describe("ensureCeSchema", () => {
  it("is idempotent (safe to run repeatedly)", () => {
    ensureCeSchema(h.db);
    ensureCeSchema(h.db);
    const cols = h.db.prepare("PRAGMA table_info(ce_sessions)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "stage",
        "status",
        "currentQuestion",
        "conversationHistory",
        "projectId",
        "lastActivityAt",
      ]),
    );
    const claimsTable = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ce_plan_handoff_claims'")
      .get() as { name: string } | undefined;
    expect(claimsTable?.name).toBe("ce_plan_handoff_claims");
  });
});

describe("CeSessionStore CRUD + JSON round-trip", () => {
  it("creates, reads back, and round-trips JSON fields", () => {
    const store = new CeSessionStore(h.db);
    const created = store.create({ stage: "brainstorm", projectId: "p1" });
    expect(created.status).toBe("launching");

    store.update(created.id, {
      currentQuestion: { id: "q", type: "confirm", question: "ok?" },
      status: "awaiting_input",
    });
    store.appendHistory(created.id, { role: "user", text: "hi", at: "2026-06-02T00:00:00Z" });

    const read = store.get(created.id)!;
    expect(read.currentQuestion?.id).toBe("q");
    expect(read.conversationHistory).toHaveLength(1);
    expect(read.status).toBe("awaiting_input");
    expect(read.projectId).toBe("p1");
  });

  it("persists brainstorm and plan sessions with unified docs/plans artifact paths", () => {
    const store = new CeSessionStore(h.db);
    const brainstorm = store.create({
      stage: "brainstorm",
      projectId: "p1",
      artifactPath: "docs/plans/2026-06-27-001-topic-plan.md",
      turnIntervalMs: 1000,
    });
    const plan = store.create({
      stage: "plan",
      projectId: "p1",
      artifactPath: "docs/plans/2026-06-27-001-topic-plan.md",
      turnIntervalMs: 1000,
    });

    expect(store.get(brainstorm.id)).toMatchObject({
      stage: "brainstorm",
      artifactPath: "docs/plans/2026-06-27-001-topic-plan.md",
    });
    expect(store.list({ stage: "brainstorm" }).map((s) => s.id)).toEqual([brainstorm.id]);
    expect(store.list({ stage: "plan" }).map((s) => s.id)).toEqual([plan.id]);

    const now = Date.now();
    store.update(brainstorm.id, { status: "active", lastActivityAt: now - 10_000 });
    store.update(plan.id, { status: "active", lastActivityAt: now - 10_000 });
    expect(store.recoverStaleSessions(now)).toEqual(expect.arrayContaining([brainstorm.id, plan.id]));
    expect(store.get(brainstorm.id)).toMatchObject({
      stage: "brainstorm",
      status: "interrupted",
      artifactPath: "docs/plans/2026-06-27-001-topic-plan.md",
    });
    expect(store.get(plan.id)).toMatchObject({
      stage: "plan",
      status: "interrupted",
      artifactPath: "docs/plans/2026-06-27-001-topic-plan.md",
    });
  });
});

describe("multi-session independence + delete", () => {
  it("holds many independent sessions; deleting one leaves the others untouched", () => {
    const store = new CeSessionStore(h.db);
    const a = store.create({ stage: "brainstorm", projectId: "p1" });
    const b = store.create({ stage: "plan", projectId: "p1" });
    const c = store.create({ stage: "work" });
    expect(store.list()).toHaveLength(3);

    expect(store.delete(b.id)).toBe(true);
    expect(store.get(b.id)).toBeUndefined();
    expect(store.get(a.id)).toBeDefined();
    expect(store.get(c.id)).toBeDefined();
    // Deleting a missing row reports false, no throw.
    expect(store.delete(b.id)).toBe(false);
  });

  it("atomically claims a requirements artifact for one Plan session and releases it on discard", () => {
    const store = new CeSessionStore(h.db);
    const artifactPath = "docs/plans/2026-07-11-001-topic-plan.md";
    const first = store.createWithPlanHandoffClaim({ stage: "plan", projectId: "p1" }, artifactPath);

    expect(() => store.createWithPlanHandoffClaim({ stage: "plan", projectId: "p1" }, artifactPath)).toThrow(PlanHandoffClaimError);
    expect(store.delete(first.id)).toBe(true);

    const retry = store.createWithPlanHandoffClaim({ stage: "plan", projectId: "p1" }, artifactPath);
    expect(retry.artifactPath).toBe(artifactPath);
  });
});

describe("interval-relative staleness (FN-4172 rubric)", () => {
  it("does NOT misclassify a healthy-but-slow session as stale", () => {
    const store = new CeSessionStore(h.db);
    const s = store.create({ stage: "brainstorm", turnIntervalMs: 1000 });
    store.update(s.id, { status: "active" });

    const now = Date.now();
    // 2.5× the interval old: slow, but within the 3× band → NOT stale.
    const slow = store.update(s.id, { status: "active", lastActivityAt: now - 2_500 })!;
    expect(STALE_INTERVAL_MULTIPLE).toBe(3);
    expect(store.isStale(slow, now)).toBe(false);

    // 4× the interval old → stale.
    const stalled = store.update(s.id, { status: "active", lastActivityAt: now - 4_000 })!;
    expect(store.isStale(stalled, now)).toBe(true);
  });

  it("never flags terminal sessions as stale regardless of age", () => {
    const store = new CeSessionStore(h.db);
    const s = store.create({ stage: "brainstorm", turnIntervalMs: 1000 });
    const completed = store.update(s.id, { status: "completed", lastActivityAt: Date.now() - 1_000_000 })!;
    expect(store.isStale(completed)).toBe(false);
  });

  it("Bug 2: a human-slow awaiting_input session past 3× is NOT recovered, while a stuck active one still is", () => {
    const store = new CeSessionStore(h.db);
    const now = Date.now();

    // A session legitimately waiting on a human, far past 3× the interval. Human
    // response time is unbounded — this is not a crashed turn.
    const waiting = store.create({ stage: "brainstorm", turnIntervalMs: 1000 });
    store.update(waiting.id, {
      status: "awaiting_input",
      currentQuestion: { id: "q", type: "text", question: "?" },
      lastActivityAt: now - 100_000, // 100× interval
    });

    // A genuinely stuck in-flight agent turn past the threshold.
    const stuck = store.create({ stage: "brainstorm", turnIntervalMs: 1000 });
    store.update(stuck.id, { status: "active", lastActivityAt: now - 100_000 });

    const recovered = store.recoverStaleSessions(now);

    // The human-wait is excluded from the interval rubric entirely.
    expect(recovered).not.toContain(waiting.id);
    expect(store.get(waiting.id)!.status).toBe("awaiting_input");

    // The stuck active turn is still recovered (here: no question → interrupted).
    expect(recovered).toContain(stuck.id);
    expect(store.get(stuck.id)!.status).toBe("interrupted");
  });
});

describe("corrupt-JSON resilience + status validation", () => {
  it("degrades gracefully when a JSON column is corrupted (no throw)", () => {
    const store = new CeSessionStore(h.db);
    const s = store.create({ stage: "brainstorm" });
    // Corrupt both JSON columns directly in the DB.
    h.db
      .prepare("UPDATE ce_sessions SET currentQuestion = ?, conversationHistory = ? WHERE id = ?")
      .run("{not valid json", "also not json", s.id);

    // Reading the row must not throw; corrupt fields fall back to null / [].
    const read = store.get(s.id)!;
    expect(read.id).toBe(s.id);
    expect(read.currentQuestion).toBeNull();
    expect(read.conversationHistory).toEqual([]);
    // The rest of the row still surfaces the session's real state.
    expect(read.stage).toBe("brainstorm");
  });

  it("degrades semantically-wrong-but-valid JSON to null / [] (not just syntax errors)", () => {
    const store = new CeSessionStore(h.db);
    const s = store.create({ stage: "brainstorm" });
    // Valid JSON, wrong shape: conversationHistory='null' parses to a non-array;
    // currentQuestion='{}' parses to an object missing the required question fields.
    h.db
      .prepare("UPDATE ce_sessions SET currentQuestion = ?, conversationHistory = ? WHERE id = ?")
      .run("{}", "null", s.id);

    const read = store.get(s.id)!;
    expect(read.currentQuestion).toBeNull();
    expect(read.conversationHistory).toEqual([]);
    // appendHistory must not throw spreading the recovered (array) history.
    expect(() => store.appendHistory(s.id, { role: "user", text: "hi", at: "t" })).not.toThrow();
    expect(store.get(s.id)!.conversationHistory).toHaveLength(1);
  });
});

describe("asCeSessionStatus validation", () => {
  it("accepts valid statuses and rejects anything else", async () => {
    const { asCeSessionStatus } = await import("../session/session-store.js");
    expect(asCeSessionStatus("active")).toBe("active");
    expect(asCeSessionStatus("interrupted")).toBe("interrupted");
    expect(asCeSessionStatus("bogus")).toBeUndefined();
    expect(asCeSessionStatus("")).toBeUndefined();
    expect(asCeSessionStatus(undefined)).toBeUndefined();
  });
});
