import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { pgDescribe, createSharedPgTaskStoreTestHarness, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import { AsyncIdeationStore, AsyncMissionStore } from "@fusion/core";

const pgTest = pgDescribe;

pgTest("AsyncIdeationStore", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_ideation_store" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const ideation = (): AsyncIdeationStore => h.store().getIdeationStore();

  it("persists divergent provenance and atomically creates a linked canonical mission", async () => {
    const session = await ideation().createSession({ title: "Ideas", prompt: "Improve onboarding" });
    await ideation().addCandidate(session.id, { content: "First", origin: "human", sourceRef: "workshop" });
    const selected = await ideation().addCandidate(session.id, { content: "Second", origin: "agent" });
    const converged = await ideation().convergeSession(session.id, selected.id);

    expect(converged.status).toBe("converged");
    expect(converged.targetMissionId).toMatch(/^M-/);
    expect(converged.candidates.find((candidate) => candidate.id === selected.id)).toMatchObject({ selected: true, linkedMissionId: converged.targetMissionId });
    expect(await (h.store().getMissionStore() as AsyncMissionStore).getMission(converged.targetMissionId!)).toMatchObject({ id: converged.targetMissionId });
  });

  it("attaches to an existing mission and rejects foreign candidates", async () => {
    const mission = await (h.store().getMissionStore() as AsyncMissionStore).createMission({ title: "Existing" });
    const first = await ideation().createSession({ title: "First" });
    const second = await ideation().createSession({ title: "Second" });
    const candidate = await ideation().addCandidate(first.id, { content: "Candidate", origin: "research" });
    await expect(ideation().convergeSession(second.id, candidate.id, { targetMissionId: mission.id })).rejects.toThrow("does not belong");
    const converged = await ideation().convergeSession(first.id, candidate.id, { targetMissionId: mission.id });
    expect(converged.targetMissionId).toBe(mission.id);
  });

  it("rolls back session selection and mission creation when canonical handoff fails", async () => {
    const session = await ideation().createSession({ title: "Rollback" });
    const candidate = await ideation().addCandidate(session.id, { content: "Never persisted", origin: "agent" });
    const missionStore = h.store().getMissionStore() as AsyncMissionStore;
    const create = vi.spyOn(missionStore, "createMission").mockRejectedValueOnce(new Error("induced handoff failure"));
    await expect(ideation().convergeSession(session.id, candidate.id)).rejects.toThrow("induced handoff failure");
    create.mockRestore();
    const stored = await ideation().getSessionWithCandidates(session.id);
    expect(stored).toMatchObject({ status: "open", targetMissionId: undefined });
    expect(stored!.candidates[0]).toMatchObject({ selected: false, linkedMissionId: undefined });
  });

  it("cascades candidates when deleting a session", async () => {
    const session = await ideation().createSession({ title: "Disposable" });
    await ideation().addCandidate(session.id, { content: "Disposable", origin: "human" });
    await ideation().deleteSession(session.id);
    expect(await ideation().getSession(session.id)).toBeUndefined();
    expect(await ideation().listCandidates(session.id)).toEqual([]);
  });
});
