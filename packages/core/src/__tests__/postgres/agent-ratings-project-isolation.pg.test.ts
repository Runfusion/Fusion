import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { AgentStore } from "../../agents/agent-store.js";
import {
  addRating,
  deleteRating,
  getRatings,
  writeAgent,
} from "../../async-stores/async-agent-store.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import type { Agent, AgentRating } from "../../types.js";

pgDescribe("agent ratings project isolation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_ratings_isolation",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("isolates duplicate agent and rating identities while preserving unbound compatibility", async () => {
    /*
    FNXC:AgentRatingsProjectIsolation 2026-08-12-01:00:
    Owner-connected PostgreSQL deployments bypass RLS, so application predicates must keep duplicate agent and rating IDs in their bound project. Blank bindings remain intentionally unscoped for compatibility while their writes are trigger-stamped.
    */
    const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
    const projectA = bind("ratings-project-a");
    const projectB = bind("ratings-project-b");
    const agentId = "shared-agent";
    const now = "2026-08-12T01:00:00.000Z";
    const agent = (name: string): Agent => ({
      id: agentId,
      name,
      role: "executor",
      roles: ["executor"],
      state: "idle",
      createdAt: now,
      updatedAt: now,
    });
    const rating = (id: string, score: number, category: string, comment: string): AgentRating => ({
      id,
      agentId,
      raterType: "user",
      score,
      category,
      comment,
      createdAt: now,
    });

    await writeAgent(projectA.db, agent("Project A"), projectA.projectId);
    await writeAgent(projectB.db, agent("Project B"), projectB.projectId);
    await addRating(projectA.db, rating("shared-rating", 5, "quality", "A shared"), projectA.projectId);
    await addRating(projectA.db, rating("a-only", 4, "delivery", "A only"), projectA.projectId);
    await addRating(projectB.db, rating("shared-rating", 1, "quality", "B shared"), projectB.projectId);
    await addRating(projectB.db, rating("b-only", 2, "delivery", "B only"), projectB.projectId);

    expect((await getRatings(projectA.db, agentId, undefined, projectA.projectId)).map(({ id, score, comment }) => ({ id, score, comment })))
      .toEqual([
        { id: "shared-rating", score: 5, comment: "A shared" },
        { id: "a-only", score: 4, comment: "A only" },
      ]);
    expect((await getRatings(projectA.db, agentId, { category: "quality" }, projectA.projectId)).map((row) => row.comment))
      .toEqual(["A shared"]);
    expect((await getRatings(projectA.db, agentId, { limit: 1 }, projectA.projectId)).map((row) => row.id))
      .toEqual(["shared-rating"]);

    const agentStoreA = new AgentStore({ rootDir: h.rootDir(), asyncLayer: projectA });
    expect(await agentStoreA.getRatingSummary(agentId)).toMatchObject({
      totalRatings: 2,
      averageScore: 4.5,
      categoryAverages: { quality: 5, delivery: 4 },
    });
    expect(await agentStoreA.getRatingSummary("other-project-agent")).toMatchObject({
      totalRatings: 0,
      averageScore: 0,
      trend: "insufficient-data",
    });

    expect(await deleteRating(projectA.db, "b-only", projectA.projectId)).toBe(false);
    expect((await getRatings(projectB.db, agentId, undefined, projectB.projectId)).map((row) => row.id))
      .toEqual(["shared-rating", "b-only"]);
    expect(await deleteRating(projectA.db, "shared-rating", projectA.projectId)).toBe(true);
    expect((await getRatings(projectB.db, agentId, undefined, projectB.projectId)).map((row) => row.id))
      .toEqual(["shared-rating", "b-only"]);

    const unbound = { ...h.layer(), projectId: "" } satisfies AsyncDataLayer;
    await addRating(unbound.db, {
      id: "unbound-rating",
      agentId: "unbound-agent",
      raterType: "user",
      score: 3,
      createdAt: now,
    }, unbound.projectId);
    expect((await getRatings(unbound.db, "unbound-agent", undefined, unbound.projectId)).map((row) => row.id))
      .toEqual(["unbound-rating"]);
    expect(await deleteRating(unbound.db, "unbound-rating", unbound.projectId)).toBe(true);
    expect(await getRatings(unbound.db, "unbound-agent", undefined, unbound.projectId)).toEqual([]);
  });
});
