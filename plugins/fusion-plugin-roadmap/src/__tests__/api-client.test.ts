/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRoadmap,
  createRoadmapFeature,
  createRoadmapMilestone,
  deleteRoadmap,
  deleteRoadmapFeature,
  deleteRoadmapMilestone,
  fetchRoadmap,
  fetchRoadmapHandoff,
  fetchRoadmaps,
  generateFeatureSuggestions,
  generateMilestoneSuggestions,
  moveRoadmapFeature,
  reorderRoadmapFeatures,
  reorderRoadmapMilestones,
  updateRoadmap,
  updateRoadmapFeature,
  updateRoadmapMilestone,
} from "../dashboard/api";

describe("roadmap dashboard api client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses plugin namespace for roadmap CRUD wrappers", async () => {
    await fetchRoadmaps("proj-1");
    await fetchRoadmap("RM-1", "proj-1");
    await createRoadmap({ title: "A" }, "proj-1");
    await updateRoadmap("RM-1", { title: "B" }, "proj-1");
    await deleteRoadmap("RM-1", "proj-1");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/plugins/fusion-plugin-roadmap/roadmaps?projectId=proj-1");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/plugins/fusion-plugin-roadmap/roadmaps/RM-1?projectId=proj-1");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/plugins/fusion-plugin-roadmap/roadmaps?projectId=proj-1");
    expect(fetchMock.mock.calls[3][0]).toBe("/api/plugins/fusion-plugin-roadmap/roadmaps/RM-1?projectId=proj-1");
    expect(fetchMock.mock.calls[4][0]).toBe("/api/plugins/fusion-plugin-roadmap/roadmaps/RM-1?projectId=proj-1");
  });

  it("uses plugin namespace for milestone and feature reorder/move + suggestions + handoff", async () => {
    await createRoadmapMilestone("RM-1", { title: "M" }, "proj-1");
    await updateRoadmapMilestone("RMS-1", { title: "M2" }, "proj-1");
    await deleteRoadmapMilestone("RMS-1", "proj-1");
    await reorderRoadmapMilestones("RM-1", ["RMS-1", "RMS-2"], "proj-1");

    await createRoadmapFeature("RMS-1", { title: "F" }, "proj-1");
    await updateRoadmapFeature("RF-1", { title: "F2" }, "proj-1");
    await deleteRoadmapFeature("RF-1", "proj-1");
    await reorderRoadmapFeatures("RMS-1", ["RF-1", "RF-2"], "proj-1");
    await moveRoadmapFeature("RF-1", "RMS-2", 0, "proj-1");

    await generateMilestoneSuggestions("RM-1", "goal", 3, "proj-1");
    await generateFeatureSuggestions("RMS-1", { prompt: "p", count: 2 }, "proj-1");
    await fetchRoadmapHandoff("RM-1", "proj-1");

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).toContain("/api/plugins/fusion-plugin-roadmap/roadmaps/RM-1/milestones?projectId=proj-1");
    expect(calledUrls).toContain("/api/plugins/fusion-plugin-roadmap/roadmaps/milestones/RMS-1?projectId=proj-1");
    expect(calledUrls).toContain("/api/plugins/fusion-plugin-roadmap/roadmaps/RM-1/milestones/reorder?projectId=proj-1");
    expect(calledUrls).toContain("/api/plugins/fusion-plugin-roadmap/roadmaps/milestones/RMS-1/features/reorder?projectId=proj-1");
    expect(calledUrls).toContain("/api/plugins/fusion-plugin-roadmap/roadmaps/features/RF-1/move?projectId=proj-1");
    expect(calledUrls).toContain("/api/plugins/fusion-plugin-roadmap/roadmaps/RM-1/suggestions/milestones?projectId=proj-1");
    expect(calledUrls).toContain("/api/plugins/fusion-plugin-roadmap/roadmaps/milestones/RMS-1/suggestions/features?projectId=proj-1");
    expect(calledUrls).toContain("/api/plugins/fusion-plugin-roadmap/roadmaps/RM-1/handoff?projectId=proj-1");
  });

  it("surfaces server error body when available", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "invalid payload" }),
    });

    await expect(fetchRoadmaps()).rejects.toThrow("invalid payload");
  });

  it("returns undefined for 204 responses", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({}),
    });

    await expect(deleteRoadmap("RM-1")).resolves.toBeUndefined();
  });
});
