import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeInsightFingerprint, type Mission, type TaskStore } from "@fusion/core";
import {
  UNLINKED_MISSIONS_ADVISORY_KEY,
  UNLINKED_MISSIONS_ADVISORY_TITLE,
  UnlinkedMissionsAdvisoryReporter,
} from "../unlinked-missions-advisory-reporter.js";

function createMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "M-001",
    title: "Mission",
    status: "active",
    interviewState: "complete",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  } as Mission;
}

function createStore(params: {
  missions?: Mission[];
  goalIdsByMissionId?: Record<string, string[]>;
  insightStore?: { upsertInsight: ReturnType<typeof vi.fn>; listInsights: ReturnType<typeof vi.fn> };
  throwInsightStore?: boolean;
  asyncMissionStore?: boolean;
}): TaskStore {
  const resolve = <T>(value: T) => params.asyncMissionStore ? Promise.resolve(value) : value;
  const missionStore = {
    listMissions: vi.fn().mockImplementation(() => resolve(params.missions ?? [])),
    listGoalIdsForMission: vi.fn().mockImplementation((missionId: string) => resolve(params.goalIdsByMissionId?.[missionId] ?? [])),
  };

  return {
    getMissionStore: vi.fn().mockReturnValue(missionStore),
    getInsightStore: vi.fn().mockImplementation(() => {
      if (params.throwInsightStore) {
        throw new Error("missing insight store");
      }
      return params.insightStore;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskStore;
}

describe("UnlinkedMissionsAdvisoryReporter", () => {
  const logger = { warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns none-unlinked when there are zero missions", async () => {
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) };
    const store = createStore({ missions: [], insightStore });
    const reporter = new UnlinkedMissionsAdvisoryReporter({ store, projectId: "/tmp/project", logger });

    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "none-unlinked" });
    expect(insightStore.upsertInsight).not.toHaveBeenCalled();
  });

  it("emits exactly one advisory for active unlinked missions", async () => {
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) };
    const store = createStore({
      missions: [createMission({ id: "M-UNLINKED" })],
      insightStore,
    });
    const reporter = new UnlinkedMissionsAdvisoryReporter({
      store,
      projectId: "/tmp/project",
      logger,
      now: () => Date.parse("2026-06-03T12:00:00.000Z"),
    });

    await expect(reporter.report()).resolves.toEqual({ alerted: true });
    expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);
    const input = insightStore.upsertInsight.mock.calls[0][1];
    expect(input.title).toBe(UNLINKED_MISSIONS_ADVISORY_TITLE);
    expect(input.fingerprint).toBe(computeInsightFingerprint(UNLINKED_MISSIONS_ADVISORY_TITLE, "workflow"));
    expect(input.provenance.metadata).toMatchObject({
      generator: "unlinked-missions-advisory-reporter",
      advisoryKey: UNLINKED_MISSIONS_ADVISORY_KEY,
    });
    expect(JSON.parse(input.content)).toEqual({
      unlinkedCount: 1,
      missionIds: ["M-UNLINKED"],
      detectedAt: "2026-06-03T12:00:00.000Z",
    });
  });

  it("supports promise-returning PostgreSQL-shaped mission stores", async () => {
    const insightStore = { upsertInsight: vi.fn().mockResolvedValue(undefined), listInsights: vi.fn().mockResolvedValue([]) };
    const store = createStore({
      missions: [createMission({ id: "M-ASYNC" })],
      insightStore,
      asyncMissionStore: true,
    });
    const reporter = new UnlinkedMissionsAdvisoryReporter({ store, projectId: "/tmp/project", logger });

    await expect(reporter.report()).resolves.toEqual({ alerted: true });
    expect(insightStore.upsertInsight).toHaveBeenCalledTimes(1);
    expect(store.getMissionStore).toHaveBeenCalledTimes(1);
  });

  it("excludes active missions that already have linked goals", async () => {
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) };
    const store = createStore({
      missions: [createMission({ id: "M-LINKED" })],
      goalIdsByMissionId: { "M-LINKED": ["G-001"] },
      insightStore,
    });
    const reporter = new UnlinkedMissionsAdvisoryReporter({ store, projectId: "/tmp/project", logger });

    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "none-unlinked" });
    expect(insightStore.upsertInsight).not.toHaveBeenCalled();
  });

  it("excludes archived unlinked missions", async () => {
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) };
    const store = createStore({
      missions: [createMission({ id: "M-ARCHIVED", status: "archived" })],
      insightStore,
    });
    const reporter = new UnlinkedMissionsAdvisoryReporter({ store, projectId: "/tmp/project", logger });

    await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "none-unlinked" });
    expect(insightStore.upsertInsight).not.toHaveBeenCalled();
  });

  it("reports only the active unlinked subset for mixed mission states", async () => {
    const insightStore = { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) };
    const store = createStore({
      missions: [
        createMission({ id: "M-UNLINKED-A" }),
        createMission({ id: "M-LINKED" }),
        createMission({ id: "M-ARCHIVED", status: "archived" }),
        createMission({ id: "M-UNLINKED-B" }),
      ],
      goalIdsByMissionId: { "M-LINKED": ["G-001"], "M-ARCHIVED": [] },
      insightStore,
    });
    const reporter = new UnlinkedMissionsAdvisoryReporter({ store, projectId: "/tmp/project", logger });

    await expect(reporter.report()).resolves.toEqual({ alerted: true });
    const content = JSON.parse(insightStore.upsertInsight.mock.calls[0][1].content);
    expect(content.unlinkedCount).toBe(2);
    expect(content.missionIds).toEqual(["M-UNLINKED-A", "M-UNLINKED-B"]);
  });

  it.each(["generated", "dismissed", "archived", "confirmed"] as const)(
    "does not emit a second advisory when an existing %s advisory insight already exists",
    async (status) => {
      const insightStore = {
        upsertInsight: vi.fn(),
        listInsights: vi.fn().mockReturnValue([
          {
            title: UNLINKED_MISSIONS_ADVISORY_TITLE,
            status,
            updatedAt: "2026-06-03T12:00:00.000Z",
            provenance: { metadata: { advisoryKey: UNLINKED_MISSIONS_ADVISORY_KEY } },
          },
        ]),
      };
      const store = createStore({
        missions: [createMission({ id: "M-UNLINKED" })],
        insightStore,
      });
      const reporter = new UnlinkedMissionsAdvisoryReporter({ store, projectId: "/tmp/project", logger });

      await expect(reporter.report()).resolves.toEqual({ alerted: false, reason: "already-reported" });
      expect(insightStore.listInsights).toHaveBeenCalledWith({
        projectId: "/tmp/project",
        category: "workflow",
        limit: 10,
      });
      expect(insightStore.upsertInsight).not.toHaveBeenCalled();
    },
  );

  it.each([
    { projectId: "", throwInsightStore: false },
    { projectId: "/tmp/project", throwInsightStore: true },
  ])("fails soft when insight infrastructure is unavailable %#", async ({ projectId, throwInsightStore }) => {
    const store = createStore({
      missions: [createMission({ id: "M-UNLINKED" })],
      insightStore: { upsertInsight: vi.fn(), listInsights: vi.fn().mockReturnValue([]) },
      throwInsightStore,
    });
    const reporter = new UnlinkedMissionsAdvisoryReporter({ store, projectId, logger });

    await expect(reporter.report()).resolves.toEqual({ alerted: true });
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledWith("M-UNLINKED", expect.stringContaining("[unlinked-missions-advisory]"));
  });
});
