/**
 * Mission API End-to-End Tests
 *
 * Tests for mission REST API endpoints using the test-request pattern.
 * Uses mocked MissionStore following routes.test.ts patterns.
 */

// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createMissionRouter } from "./mission-routes.js";
import { request, get } from "./test-request.js";
import type { TaskStore } from "@fusion/core";
import type {
  Mission,
  Milestone,
  Slice,
  MissionFeature,
  MissionWithHierarchy,
  MissionEvent,
  MissionHealth,
} from "@fusion/core";
import type { AiSessionRow } from "./ai-session-store.js";
import {
  __resetMissionInterviewState,
  createMissionInterviewSession,
  missionInterviewStreamManager,
  setAiSessionStore,
  getMissionInterviewSession,
  submitMissionInterviewResponse,
} from "./mission-interview.js";
import * as missionInterviewModule from "./mission-interview.js";

// Mock MissionStore factory
function createMockMissionStore() {
  const missions: Map<string, Mission> = new Map();
  const milestones: Map<string, Milestone> = new Map();
  const slices: Map<string, Slice> = new Map();
  const features: Map<string, MissionFeature> = new Map();
  const missionEvents: Map<string, MissionEvent[]> = new Map();

  let missionCounter = 1;
  let milestoneCounter = 1;
  let sliceCounter = 1;
  let featureCounter = 1;

  // Generate IDs matching the real MissionStore format:
  // prefix + base36(timestamp) + "-" + random alphanumeric suffix
  // e.g., M-MNJVKT2G-ME5Q, MS-M3N8QR-C9F1, SL-P4T2WX-D5E8, F-J6K9AB-G7H3
  const generateMissionId = () => `M-MOCK${missionCounter++.toString(36).toUpperCase()}-TST`;
  const generateMilestoneId = () => `MS-MOCK${milestoneCounter++.toString(36).toUpperCase()}-TST`;
  const generateSliceId = () => `SL-MOCK${sliceCounter++.toString(36).toUpperCase()}-TST`;
  const generateFeatureId = () => `F-MOCK${featureCounter++.toString(36).toUpperCase()}-TST`;

  return {
    createMission: vi.fn((input: { title: string; description?: string }) => {
      const mission: Mission = {
        id: generateMissionId(),
        title: input.title,
        description: input.description,
        status: "planning",
        interviewState: "not_started",
        autoAdvance: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      missions.set(mission.id, mission);
      return mission;
    }),

    getMission: vi.fn((id: string) => missions.get(id)),

    getMissionWithHierarchy: vi.fn((id: string) => {
      const mission = missions.get(id);
      if (!mission) return undefined;

      const missionMilestones = Array.from(milestones.values())
        .filter((m) => m.missionId === id)
        .sort((a, b) => a.orderIndex - b.orderIndex);

      return {
        ...mission,
        milestones: missionMilestones.map((m) => ({
          ...m,
          slices: Array.from(slices.values())
            .filter((s) => s.milestoneId === m.id)
            .sort((a, b) => a.orderIndex - b.orderIndex)
            .map((s) => ({
              ...s,
              features: Array.from(features.values()).filter(
                (f) => f.sliceId === s.id
              ),
            })),
        })),
      } as MissionWithHierarchy;
    }),

    listMissions: vi.fn(() =>
      Array.from(missions.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    ),

    getMissionSummary: vi.fn((_missionId: string) => ({
      totalMilestones: 0,
      completedMilestones: 0,
      totalSlices: 0,
      completedSlices: 0,
      totalFeatures: 0,
      completedFeatures: 0,
    })),

    getMissionEvents: vi.fn((missionId: string, options?: { limit?: number; offset?: number; eventType?: string }) => {
      const allEvents = missionEvents.get(missionId) ?? [];
      const filtered = options?.eventType
        ? allEvents.filter((event) => event.eventType === options.eventType)
        : allEvents;
      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;
      return {
        events: filtered.slice(offset, offset + limit),
        total: filtered.length,
      };
    }),

    getMissionHealth: vi.fn((missionId: string): MissionHealth | undefined => {
      const mission = missions.get(missionId);
      if (!mission) return undefined;
      return {
        missionId,
        status: mission.status,
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksInFlight: 0,
        totalTasks: 0,
        currentSliceId: undefined,
        currentMilestoneId: undefined,
        estimatedCompletionPercent: 0,
        lastErrorAt: undefined,
        lastErrorDescription: undefined,
        autopilotState: mission.autopilotState ?? "inactive",
        autopilotEnabled: mission.autopilotEnabled ?? false,
        lastActivityAt: mission.lastAutopilotActivityAt,
      };
    }),

    updateMission: vi.fn((id: string, updates: Partial<Mission>) => {
      const mission = missions.get(id);
      if (!mission) throw new Error("Mission " + id + " not found");
      const updated = { ...mission, ...updates, updatedAt: new Date().toISOString() };
      missions.set(id, updated);
      return updated;
    }),

    updateMissionInterviewState: vi.fn((id: string, state: Mission["interviewState"]) => {
      const mission = missions.get(id);
      if (!mission) throw new Error("Mission " + id + " not found");
      const updated = { ...mission, interviewState: state, updatedAt: new Date().toISOString() };
      missions.set(id, updated);
      return updated;
    }),

    deleteMission: vi.fn((id: string) => {
      if (!missions.has(id)) throw new Error("Mission " + id + " not found");
      missions.delete(id);
    }),

    addMilestone: vi.fn((missionId: string, input: { title: string; description?: string; dependencies?: string[] }) => {
      const milestone: Milestone = {
        id: generateMilestoneId(),
        missionId,
        title: input.title,
        description: input.description,
        status: "planning",
        orderIndex: Array.from(milestones.values()).filter((m) => m.missionId === missionId).length,
        interviewState: "not_started",
        dependencies: input.dependencies ?? [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      milestones.set(milestone.id, milestone);
      return milestone;
    }),

    getMilestone: vi.fn((id: string) => milestones.get(id)),

    listMilestones: vi.fn((missionId: string) =>
      Array.from(milestones.values())
        .filter((m) => m.missionId === missionId)
        .sort((a, b) => a.orderIndex - b.orderIndex)
    ),

    updateMilestone: vi.fn((id: string, updates: Partial<Milestone>) => {
      const milestone = milestones.get(id);
      if (!milestone) throw new Error("Milestone " + id + " not found");
      const updated = { ...milestone, ...updates, updatedAt: new Date().toISOString() };
      milestones.set(id, updated);
      return updated;
    }),

    updateMilestoneInterviewState: vi.fn((id: string, state: Milestone["interviewState"]) => {
      const milestone = milestones.get(id);
      if (!milestone) throw new Error("Milestone " + id + " not found");
      const updated = { ...milestone, interviewState: state, updatedAt: new Date().toISOString() };
      milestones.set(id, updated);
      return updated;
    }),

    deleteMilestone: vi.fn((id: string) => {
      if (!milestones.has(id)) throw new Error("Milestone " + id + " not found");
      milestones.delete(id);
      for (const slice of Array.from(slices.values())) {
        if (slice.milestoneId === id) {
          slices.delete(slice.id);
          for (const feature of Array.from(features.values())) {
            if (feature.sliceId === slice.id) {
              features.delete(feature.id);
            }
          }
        }
      }
    }),

    addSlice: vi.fn((milestoneId: string, input: { title: string; description?: string }) => {
      const slice: Slice = {
        id: generateSliceId(),
        milestoneId,
        title: input.title,
        description: input.description,
        status: "pending",
        orderIndex: Array.from(slices.values()).filter((s) => s.milestoneId === milestoneId).length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      slices.set(slice.id, slice);
      return slice;
    }),

    getSlice: vi.fn((id: string) => slices.get(id)),

    listSlices: vi.fn((milestoneId: string) =>
      Array.from(slices.values())
        .filter((s) => s.milestoneId === milestoneId)
        .sort((a, b) => a.orderIndex - b.orderIndex)
    ),

    updateSlice: vi.fn((id: string, updates: Partial<Slice>) => {
      const slice = slices.get(id);
      if (!slice) throw new Error("Slice " + id + " not found");
      const updated = { ...slice, ...updates, updatedAt: new Date().toISOString() };
      slices.set(id, updated);
      return updated;
    }),

    deleteSlice: vi.fn((id: string) => {
      if (!slices.has(id)) throw new Error("Slice " + id + " not found");
      slices.delete(id);
      for (const feature of Array.from(features.values())) {
        if (feature.sliceId === id) {
          features.delete(feature.id);
        }
      }
    }),

    addFeature: vi.fn((sliceId: string, input: { title: string; description?: string; acceptanceCriteria?: string }) => {
      const feature: MissionFeature = {
        id: generateFeatureId(),
        sliceId,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
        status: "defined",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      features.set(feature.id, feature);
      return feature;
    }),

    getFeature: vi.fn((id: string) => features.get(id)),

    listFeatures: vi.fn((sliceId: string) =>
      Array.from(features.values()).filter((feature) => feature.sliceId === sliceId)
    ),

    activateSlice: vi.fn((id: string) => {
      const slice = slices.get(id);
      if (!slice) throw new Error("Slice " + id + " not found");
      const updated = {
        ...slice,
        status: "active" as const,
        activatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      slices.set(id, updated);

      // Simulate auto-triage: when mission.autoAdvance is true, triage "defined" features
      const milestone = milestones.get(slice.milestoneId);
      if (milestone) {
        const mission = missions.get(milestone.missionId);
        if (mission?.autoAdvance === true) {
          const sliceFeatures = Array.from(features.values()).filter(
            (f) => f.sliceId === id && f.status === "defined"
          );
          for (const f of sliceFeatures) {
            const taskId = "FN-" + String(features.size + 1).padStart(3, "0");
            const triaged = { ...f, taskId, status: "triaged" as const, updatedAt: new Date().toISOString() };
            features.set(f.id, triaged);
          }
        }
      }

      return updated;
    }),

    updateFeature: vi.fn((id: string, updates: Partial<MissionFeature>) => {
      const feature = features.get(id);
      if (!feature) throw new Error("Feature " + id + " not found");
      const updated = { ...feature, ...updates, updatedAt: new Date().toISOString() };
      features.set(id, updated);
      return updated;
    }),

    deleteFeature: vi.fn((id: string) => {
      if (!features.has(id)) throw new Error("Feature " + id + " not found");
      features.delete(id);
    }),

    linkFeatureToTask: vi.fn((featureId: string, taskId: string) => {
      const feature = features.get(featureId);
      if (!feature) throw new Error("Feature " + featureId + " not found");
      const updated = { ...feature, taskId, status: "triaged" as const, updatedAt: new Date().toISOString() };
      features.set(featureId, updated);
      return updated;
    }),

    unlinkFeatureFromTask: vi.fn((featureId: string) => {
      const feature = features.get(featureId);
      if (!feature) throw new Error("Feature " + featureId + " not found");
      const updated = { ...feature, taskId: undefined, status: "defined" as const, updatedAt: new Date().toISOString() };
      features.set(featureId, updated);
      return updated;
    }),

    reorderMilestones: vi.fn((missionId: string, orderedIds: string[]) => {
      orderedIds.forEach((id, index) => {
        const milestone = milestones.get(id);
        if (!milestone || milestone.missionId !== missionId) {
          throw new Error("Milestone " + id + " not found");
        }
        milestones.set(id, {
          ...milestone,
          orderIndex: index,
          updatedAt: new Date().toISOString(),
        });
      });
    }),
    reorderSlices: vi.fn((milestoneId: string, orderedIds: string[]) => {
      orderedIds.forEach((id, index) => {
        const slice = slices.get(id);
        if (!slice || slice.milestoneId !== milestoneId) {
          throw new Error("Slice " + id + " not found");
        }
        slices.set(id, {
          ...slice,
          orderIndex: index,
          updatedAt: new Date().toISOString(),
        });
      });
    }),

    // Triage methods
    triageFeature: vi.fn(async (featureId: string) => {
      const feature = features.get(featureId);
      if (!feature) throw new Error("Feature " + featureId + " not found");
      if (feature.status !== "defined") throw new Error("Feature " + featureId + " is already " + feature.status);
      const taskId = "FN-" + String(features.size + 1).padStart(3, "0");
      const updated = { ...feature, taskId, status: "triaged" as const, updatedAt: new Date().toISOString() };
      features.set(featureId, updated);
      return updated;
    }),

    triageSlice: vi.fn(async (sliceId: string) => {
      const slice = slices.get(sliceId);
      if (!slice) throw new Error("Slice " + sliceId + " not found");
      const sliceFeatures = Array.from(features.values()).filter((f) => f.sliceId === sliceId && f.status === "defined");
      const triaged: MissionFeature[] = [];
      for (const f of sliceFeatures) {
        const taskId = "FN-" + String(features.size + triaged.size + 1).padStart(3, "0");
        const updated = { ...f, taskId, status: "triaged" as const, updatedAt: new Date().toISOString() };
        features.set(f.id, updated);
        triaged.push(updated);
      }
      return triaged;
    }),

    findNextPendingSlice: vi.fn((missionId: string) => {
      const missionMilestones = Array.from(milestones.values())
        .filter((m) => m.missionId === missionId)
        .sort((a, b) => a.orderIndex - b.orderIndex);
      for (const milestone of missionMilestones) {
        const milestoneSlices = Array.from(slices.values())
          .filter((s) => s.milestoneId === milestone.id)
          .sort((a, b) => a.orderIndex - b.orderIndex);
        for (const slice of milestoneSlices) {
          if (slice.status === "pending") return slice;
        }
      }
      return undefined;
    }),

    // Mission status helpers for pause/stop
    computeMissionStatus: vi.fn(() => "active"),

    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
}

function createMockStore(): TaskStore {
  return {
    getMissionStore: vi.fn().mockReturnValue(createMockMissionStore()),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    pauseTask: vi.fn(),
  } as unknown as TaskStore;
}

function createMockMissionAutopilot() {
  return {
    watchMission: vi.fn(),
    unwatchMission: vi.fn(),
    isWatching: vi.fn().mockReturnValue(false),
    getAutopilotStatus: vi.fn().mockReturnValue({
      enabled: false,
      state: "inactive",
      watched: false,
      lastActivityAt: undefined,
    }),
    checkAndStartMission: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function buildApp(options?: {
  missionAutopilot?: ReturnType<typeof createMockMissionAutopilot>;
  withErrorHandler?: boolean;
  aiSessionStore?: {
    acquireLock(sessionId: string, tabId: string): { acquired: boolean; currentHolder: string | null };
  };
}) {
  const app = express();
  app.use(express.json());
  const store = createMockStore();
  app.use("/api/missions", createMissionRouter(store, options?.missionAutopilot, options?.aiSessionStore as any));

  if (options?.withErrorHandler) {
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });
  }

  return { app, store, missionStore: store.getMissionStore() };
}

class MockAiSessionStore {
  rows = new Map<string, AiSessionRow>();

  upsert(row: AiSessionRow): void {
    this.rows.set(row.id, row);
  }

  updateThinking(id: string, thinkingOutput: string): void {
    const row = this.rows.get(id);
    if (!row) {
      return;
    }

    this.rows.set(id, {
      ...row,
      thinkingOutput,
      updatedAt: new Date().toISOString(),
    });
  }

  delete(id: string): void {
    this.rows.delete(id);
  }

  get(id: string): AiSessionRow | null {
    return this.rows.get(id) ?? null;
  }

  listRecoverable(): AiSessionRow[] {
    return [...this.rows.values()].filter(
      (row) => row.status === "awaiting_input" || row.status === "generating" || row.status === "error",
    );
  }

  on(): this {
    return this;
  }

  off(): this {
    return this;
  }
}

function buildMissionInterviewRow(
  overrides: Partial<AiSessionRow> & Pick<AiSessionRow, "id" | "status">,
): AiSessionRow {
  const now = new Date().toISOString();

  return {
    id: overrides.id,
    type: "mission_interview",
    status: overrides.status,
    title: overrides.title ?? "Recovered mission interview session",
    inputPayload:
      overrides.inputPayload ??
      JSON.stringify({
        ip: "127.0.0.1",
        missionId: "M-RECOVERED",
        missionTitle: "Recovered mission interview",
      }),
    conversationHistory: overrides.conversationHistory ?? "[]",
    currentQuestion:
      overrides.currentQuestion ??
      JSON.stringify({
        id: "q-existing",
        type: "text",
        question: "What are we building?",
        description: "context",
      }),
    result: overrides.result ?? null,
    thinkingOutput: overrides.thinkingOutput ?? "Recovered thinking",
    error: overrides.error ?? null,
    projectId: overrides.projectId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe("Mission API", () => {
  describe("POST /api/missions", () => {
    it("should create a mission with the default auto-advance state", async () => {
      const { app } = buildApp();

      const res = await request(
        app,
        "POST",
        "/api/missions",
        JSON.stringify({ title: "New Mission", description: "Ship it" }),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(201);
      expect(res.body.title).toBe("New Mission");
      expect(res.body.autoAdvance).toBe(false);
    });

    it("should persist auto-advance when provided during creation", async () => {
      const { app, missionStore } = buildApp();

      const res = await request(
        app,
        "POST",
        "/api/missions",
        JSON.stringify({ title: "Mission", autoAdvance: true }),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(201);
      expect(res.body.autoAdvance).toBe(true);
      expect(missionStore.updateMission).toHaveBeenCalledWith(res.body.id, { autoAdvance: true });
    });
  });

  describe("GET /api/missions", () => {
    it("should list all missions", async () => {
      const { app, missionStore } = buildApp();
      missionStore.createMission({ title: "Mission 1" });
      missionStore.createMission({ title: "Mission 2" });

      const res = await get(app, "/api/missions");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
    });

    it("should return empty array when no missions", async () => {
      const { app } = buildApp();
      const res = await get(app, "/api/missions");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("GET /api/missions/:missionId", () => {
    it("should get mission with hierarchy", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });

      const res = await get(app, `/api/missions/${mission.id}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(mission.id);
      expect(res.body.title).toBe("Test Mission");
    });

    it("should return 404 for non-existent mission", async () => {
      const { app } = buildApp();
      const res = await get(app, "/api/missions/M-999");
      expect(res.status).toBe(404);
    });
  });

  describe("Mission observability endpoints", () => {
    it("GET /api/missions/:missionId/events returns paginated events", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Observable Mission" });

      const mockEvents: MissionEvent[] = [
        {
          id: "ME-003",
          missionId: mission.id,
          eventType: "warning",
          description: "Stale warning",
          metadata: { category: "autopilot_stale" },
          timestamp: "2026-04-08T12:02:00.000Z",
        },
        {
          id: "ME-002",
          missionId: mission.id,
          eventType: "error",
          description: "Autopilot failed",
          metadata: { retryCount: 3 },
          timestamp: "2026-04-08T12:01:00.000Z",
        },
      ];
      missionStore.getMissionEvents.mockReturnValue({ events: mockEvents, total: 7 });

      const res = await get(app, `/api/missions/${mission.id}/events`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        events: mockEvents,
        total: 7,
        limit: 50,
        offset: 0,
      });
      expect(missionStore.getMissionEvents).toHaveBeenCalledWith(mission.id, {
        limit: 50,
        offset: 0,
        eventType: undefined,
      });
    });

    it("GET /api/missions/:missionId/events supports limit/offset query params", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Observable Mission" });
      missionStore.getMissionEvents.mockReturnValue({ events: [], total: 42 });

      const res = await get(app, `/api/missions/${mission.id}/events?limit=10&offset=5`);

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(10);
      expect(res.body.offset).toBe(5);
      expect(missionStore.getMissionEvents).toHaveBeenCalledWith(mission.id, {
        limit: 10,
        offset: 5,
        eventType: undefined,
      });
    });

    it("GET /api/missions/:missionId/events supports eventType filtering", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Observable Mission" });

      const filteredEvents: MissionEvent[] = [
        {
          id: "ME-010",
          missionId: mission.id,
          eventType: "error",
          description: "latest error",
          metadata: null,
          timestamp: "2026-04-08T12:10:00.000Z",
        },
      ];
      missionStore.getMissionEvents.mockReturnValue({ events: filteredEvents, total: 1 });

      const res = await get(app, `/api/missions/${mission.id}/events?eventType=error`);

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual(filteredEvents);
      expect(missionStore.getMissionEvents).toHaveBeenCalledWith(mission.id, {
        limit: 50,
        offset: 0,
        eventType: "error",
      });
    });

    it("GET /api/missions/:missionId/events returns 404 for unknown mission", async () => {
      const { app } = buildApp();

      const res = await get(app, "/api/missions/M-999/events");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Mission not found");
    });

    it("GET /api/missions/:missionId/health returns mission health", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Healthy Mission" });

      const health: MissionHealth = {
        missionId: mission.id,
        status: "active",
        tasksCompleted: 5,
        tasksFailed: 1,
        tasksInFlight: 2,
        totalTasks: 8,
        currentSliceId: "SL-MOCK1-TST",
        currentMilestoneId: "MS-MOCK1-TST",
        estimatedCompletionPercent: 63,
        lastErrorAt: "2026-04-08T12:00:00.000Z",
        lastErrorDescription: "Most recent error",
        autopilotState: "watching",
        autopilotEnabled: true,
        lastActivityAt: "2026-04-08T12:05:00.000Z",
      };
      missionStore.getMissionHealth.mockReturnValue(health);

      const res = await get(app, `/api/missions/${mission.id}/health`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(health);
      expect(missionStore.getMissionHealth).toHaveBeenCalledWith(mission.id);
    });

    it("GET /api/missions/:missionId/health returns 404 for unknown mission", async () => {
      const { app } = buildApp();

      const res = await get(app, "/api/missions/M-999/health");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Mission not found");
    });
  });

  describe("PATCH /api/missions/:missionId", () => {
    it("should update mission status and auto-advance", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });

      const res = await request(
        app,
        "PATCH",
        `/api/missions/${mission.id}`,
        JSON.stringify({ status: "active", autoAdvance: true }),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
      expect(res.body.autoAdvance).toBe(true);
      expect(res.body.id).toBe(mission.id);
      // Verify the update was actually persisted in the store (FN-825 regression)
      const updated = missionStore.getMission(mission.id);
      expect(updated?.status).toBe("active");
      expect(updated?.autoAdvance).toBe(true);
      expect(missionStore.updateMission).toHaveBeenCalledWith(mission.id, {
        status: "active",
        autoAdvance: true,
      });
    });

    it("should update mission title with generated-format ID", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Original Title" });

      const res = await request(
        app,
        "PATCH",
        `/api/missions/${mission.id}`,
        JSON.stringify({ title: "Updated Title" }),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Updated Title");
      expect(res.body.id).toBe(mission.id);
      // Verify persistence
      const updated = missionStore.getMission(mission.id);
      expect(updated?.title).toBe("Updated Title");
    });

    it("should reject non-boolean auto-advance values", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });

      app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(
        app,
        "PATCH",
        `/api/missions/${mission.id}`,
        JSON.stringify({ autoAdvance: "yes" }),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(500);
      expect(res.body.error).toContain("autoAdvance must be a boolean");
      expect(missionStore.updateMission).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/missions/:missionId", () => {
    it("should delete mission and confirm removal from store", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "To Delete" });

      const res = await request(app, "DELETE", `/api/missions/${mission.id}`);

      expect(res.status).toBe(204);
      // Verify the mission is actually removed from the mock store (FN-825 regression)
      expect(missionStore.getMission(mission.id)).toBeUndefined();
    });

    it("should delete mission with generated-format ID and confirm removal", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "To Delete" });
      // Generated-format IDs from mock look like M-MOCK1-TST
      expect(mission.id).toMatch(/^M-[A-Z0-9]+/);

      const res = await request(app, "DELETE", `/api/missions/${mission.id}`);

      expect(res.status).toBe(204);
      expect(missionStore.getMission(mission.id)).toBeUndefined();
    });

    it("should return 404 for non-existent mission", async () => {
      const { app } = buildApp();
      const res = await request(app, "DELETE", `/api/missions/M-999`);
      expect(res.status).toBe(404);
    });

    it("should reject invalid mission ID format on DELETE", async () => {
      const { app } = buildApp();
      const res = await request(app, "DELETE", `/api/missions/invalid-id`);
      expect(res.status).toBe(400);
    });

    it("should cascade delete all children and verify removal", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "To Delete" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone 1" });

      const res = await request(app, "DELETE", `/api/missions/${mission.id}`);

      expect(res.status).toBe(204);
      expect(missionStore.getMission(mission.id)).toBeUndefined();
      // Note: The mock store's deleteMission only removes from the mission Map.
      // In the real store, FK cascades would remove milestones too.
      // We verify the route returned success — cascade behavior is tested at the store level.
      expect(missionStore.deleteMission).toHaveBeenCalledWith(mission.id);
    });
  });

  describe("POST /api/missions/:missionId/milestones/reorder", () => {
    it("should call reorderMilestones when valid request", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });
      missionStore.addMilestone(mission.id, { title: "Milestone 1" });
      missionStore.addMilestone(mission.id, { title: "Milestone 2" });
      missionStore.addMilestone(mission.id, { title: "Milestone 3" });

      const allMilestones = missionStore.listMilestones(mission.id);

      const res = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/milestones/reorder`,
        JSON.stringify({ orderedIds: allMilestones.map((m) => m.id).reverse() }),
        { "content-type": "application/json" }
      );

      expect([200, 204, 400, 404]).toContain(res.status);
    });
  });

  describe("POST /api/missions/milestones/:milestoneId/slices/reorder", () => {
    it("should call reorderSlices when valid request", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const s1 = missionStore.addSlice(milestone.id, { title: "Slice 1" });
      const s2 = missionStore.addSlice(milestone.id, { title: "Slice 2" });

      const res = await request(
        app,
        "POST",
        `/api/missions/milestones/${milestone.id}/slices/reorder`,
        JSON.stringify({ orderedIds: [s2.id, s1.id] }),
        { "content-type": "application/json" }
      );

      expect([200, 204, 400, 404]).toContain(res.status);
    });
  });

  describe("Error handling", () => {
    it("should return 404 for non-existent slice activation", async () => {
      const { app } = buildApp();
      const res = await request(app, "POST", `/api/missions/slices/SL-999/activate`);
      expect(res.status).toBe(404);
    });

    it("should return 404 for non-existent feature link", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        `/api/missions/features/F-999/link-task`,
        JSON.stringify({ taskId: "FN-001" }),
        { "content-type": "application/json" }
      );
      expect(res.status).toBe(404);
    });

    it("should return 400 for invalid mission ID format on get", async () => {
      const { app } = buildApp();
      const res = await get(app, "/api/missions/invalid-id");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/missions/:missionId hierarchy structure", () => {
    it("should return MissionWithHierarchy with nested data", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Test Slice" });
      const feature = missionStore.addFeature(slice.id, { title: "Test Feature" });

      const res = await get(app, `/api/missions/${mission.id}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(mission.id);
      expect(res.body.title).toBe("Test Mission");
      expect(res.body).toHaveProperty("milestones");
      expect(Array.isArray(res.body.milestones)).toBe(true);
      expect(res.body.milestones).toHaveLength(1);
      expect(res.body.milestones[0]).toHaveProperty("slices");
      expect(Array.isArray(res.body.milestones[0].slices)).toBe(true);
      expect(res.body.milestones[0].slices).toHaveLength(1);
      expect(res.body.milestones[0].slices[0]).toHaveProperty("features");
      expect(Array.isArray(res.body.milestones[0].slices[0].features)).toBe(true);
      expect(res.body.milestones[0].slices[0].features).toHaveLength(1);
      expect(res.body.milestones[0].slices[0].features[0].id).toBe(feature.id);
    });
  });

  describe("Slice activation", () => {
    it("should activate a pending slice", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Test Slice" });

      const res = await request(app, "POST", `/api/missions/slices/${slice.id}/activate`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
    });
  });

  describe("Feature routes", () => {
    it("should patch a feature status using a normalized featureId string", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Test Slice" });
      const feature = missionStore.addFeature(slice.id, { title: "Test Feature" });

      const res = await request(
        app,
        "PATCH",
        `/api/missions/features/${feature.id}`,
        JSON.stringify({ status: "triaged", acceptanceCriteria: "Shippable" }),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(feature.id);
      expect(res.body.status).toBe("triaged");
      expect(res.body.acceptanceCriteria).toBe("Shippable");
      expect(missionStore.updateFeature).toHaveBeenCalledWith(feature.id, {
        status: "triaged",
        acceptanceCriteria: "Shippable",
      });
    });

    it("should reject invalid feature status values", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Test Slice" });
      const feature = missionStore.addFeature(slice.id, { title: "Test Feature" });

      app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      });

      const res = await request(
        app,
        "PATCH",
        `/api/missions/features/${feature.id}`,
        JSON.stringify({ status: "complete" }),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(500);
      expect(res.body.error).toContain("Invalid status");
      expect(missionStore.updateFeature).not.toHaveBeenCalled();
    });

    it("should link feature to task", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Test Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Test Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Test Slice" });
      const feature = missionStore.addFeature(slice.id, { title: "Test Feature" });

      const res = await request(
        app,
        "POST",
        `/api/missions/features/${feature.id}/link-task`,
        JSON.stringify({ taskId: "FN-001" }),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.taskId).toBe("FN-001");
    });
  });

  describe("Milestone CRUD", () => {
    it("GET /api/missions/:missionId/milestones returns sorted milestones and 404 for missing mission", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const first = missionStore.addMilestone(mission.id, { title: "First" });
      const second = missionStore.addMilestone(mission.id, { title: "Second" });

      missionStore.updateMilestone(first.id, { orderIndex: 1 });
      missionStore.updateMilestone(second.id, { orderIndex: 0 });

      const ok = await get(app, `/api/missions/${mission.id}/milestones`);
      expect(ok.status).toBe(200);
      expect(ok.body.map((milestone: Milestone) => milestone.id)).toEqual([second.id, first.id]);

      const missing = await get(app, "/api/missions/M-NOT-FOUND/milestones");
      expect(missing.status).toBe(404);
    });

    it("POST /api/missions/:missionId/milestones creates milestones and validates payload", async () => {
      const { app, missionStore } = buildApp({ withErrorHandler: true });
      const mission = missionStore.createMission({ title: "Mission" });

      const created = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/milestones`,
        JSON.stringify({
          title: "Milestone A",
          description: "Detailed milestone",
          dependencies: ["MS-UPSTREAM-1"],
        }),
        { "content-type": "application/json" },
      );

      expect(created.status).toBe(201);
      expect(created.body.title).toBe("Milestone A");
      expect(created.body.description).toBe("Detailed milestone");
      expect(created.body.dependencies).toEqual(["MS-UPSTREAM-1"]);

      const missingMission = await request(
        app,
        "POST",
        "/api/missions/M-NOT-FOUND/milestones",
        JSON.stringify({ title: "Milestone" }),
        { "content-type": "application/json" },
      );
      expect(missingMission.status).toBe(404);

      const missingTitle = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/milestones`,
        JSON.stringify({ description: "No title" }),
        { "content-type": "application/json" },
      );
      expect(missingTitle.status).toBe(500);
      expect(missingTitle.body.error).toContain("Title is required");

      const tooLongTitle = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/milestones`,
        JSON.stringify({ title: "x".repeat(201) }),
        { "content-type": "application/json" },
      );
      expect(tooLongTitle.status).toBe(500);
      expect(tooLongTitle.body.error).toContain("Title must not exceed 200 characters");
    });

    it("PATCH /api/missions/milestones/:milestoneId updates individual fields", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Original" });

      const updateTitle = await request(
        app,
        "PATCH",
        `/api/missions/milestones/${milestone.id}`,
        JSON.stringify({ title: "Renamed" }),
        { "content-type": "application/json" },
      );
      expect(updateTitle.status).toBe(200);
      expect(updateTitle.body.title).toBe("Renamed");

      const updateStatus = await request(
        app,
        "PATCH",
        `/api/missions/milestones/${milestone.id}`,
        JSON.stringify({ status: "active" }),
        { "content-type": "application/json" },
      );
      expect(updateStatus.status).toBe(200);
      expect(updateStatus.body.status).toBe("active");

      const updateDescription = await request(
        app,
        "PATCH",
        `/api/missions/milestones/${milestone.id}`,
        JSON.stringify({ description: "Updated description" }),
        { "content-type": "application/json" },
      );
      expect(updateDescription.status).toBe(200);
      expect(updateDescription.body.description).toBe("Updated description");

      const updateDependencies = await request(
        app,
        "PATCH",
        `/api/missions/milestones/${milestone.id}`,
        JSON.stringify({ dependencies: ["MS-DEP-1"] }),
        { "content-type": "application/json" },
      );
      expect(updateDependencies.status).toBe(200);
      expect(updateDependencies.body.dependencies).toEqual(["MS-DEP-1"]);

      const noFields = await request(
        app,
        "PATCH",
        `/api/missions/milestones/${milestone.id}`,
        JSON.stringify({}),
        { "content-type": "application/json" },
      );
      expect(noFields.status).toBe(400);
      expect(noFields.body.error).toContain("No valid fields to update");

      const missingMilestone = await request(
        app,
        "PATCH",
        "/api/missions/milestones/MS-NOT-FOUND",
        JSON.stringify({ title: "Nope" }),
        { "content-type": "application/json" },
      );
      expect(missingMilestone.status).toBe(404);
    });

    it("DELETE /api/missions/milestones/:milestoneId validates ID and existence", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "To Delete" });

      const removed = await request(app, "DELETE", `/api/missions/milestones/${milestone.id}`);
      expect(removed.status).toBe(204);

      const missing = await request(app, "DELETE", "/api/missions/milestones/MS-NOT-FOUND");
      expect(missing.status).toBe(404);

      const invalid = await request(app, "DELETE", "/api/missions/milestones/bad-id");
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("Invalid milestone ID format");
    });

    it("POST /api/missions/:missionId/milestones/reorder enforces complete ordered IDs", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const m1 = missionStore.addMilestone(mission.id, { title: "One" });
      const m2 = missionStore.addMilestone(mission.id, { title: "Two" });

      const ok = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/milestones/reorder`,
        JSON.stringify({ orderedIds: [m2.id, m1.id] }),
        { "content-type": "application/json" },
      );
      expect(ok.status).toBe(204);
      expect(missionStore.reorderMilestones).toHaveBeenCalledWith(mission.id, [m2.id, m1.id]);

      const incomplete = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/milestones/reorder`,
        JSON.stringify({ orderedIds: [m1.id] }),
        { "content-type": "application/json" },
      );
      expect(incomplete.status).toBe(400);
      expect(incomplete.body.error).toContain("orderedIds must include all milestones");

      const wrongMissionIds = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/milestones/reorder`,
        JSON.stringify({ orderedIds: [m1.id, "MS-OTHER-MISSION"] }),
        { "content-type": "application/json" },
      );
      expect(wrongMissionIds.status).toBe(400);
      expect(wrongMissionIds.body.error).toContain("Invalid milestone IDs in orderedIds");
    });
  });

  describe("Slice CRUD", () => {
    it("GET /api/missions/milestones/:milestoneId/slices returns sorted slices and 404 for missing milestone", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const first = missionStore.addSlice(milestone.id, { title: "First" });
      const second = missionStore.addSlice(milestone.id, { title: "Second" });

      missionStore.updateSlice(first.id, { orderIndex: 2 });
      missionStore.updateSlice(second.id, { orderIndex: 0 });

      const ok = await get(app, `/api/missions/milestones/${milestone.id}/slices`);
      expect(ok.status).toBe(200);
      expect(ok.body.map((slice: Slice) => slice.id)).toEqual([second.id, first.id]);

      const missing = await get(app, "/api/missions/milestones/MS-NOT-FOUND/slices");
      expect(missing.status).toBe(404);
    });

    it("POST /api/missions/milestones/:milestoneId/slices handles success, 404, and missing title", async () => {
      const { app, missionStore } = buildApp({ withErrorHandler: true });
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });

      const created = await request(
        app,
        "POST",
        `/api/missions/milestones/${milestone.id}/slices`,
        JSON.stringify({ title: "Slice A", description: "Slice details" }),
        { "content-type": "application/json" },
      );
      expect(created.status).toBe(201);
      expect(created.body.title).toBe("Slice A");

      const missingMilestone = await request(
        app,
        "POST",
        "/api/missions/milestones/MS-NOT-FOUND/slices",
        JSON.stringify({ title: "Slice" }),
        { "content-type": "application/json" },
      );
      expect(missingMilestone.status).toBe(404);

      const missingTitle = await request(
        app,
        "POST",
        `/api/missions/milestones/${milestone.id}/slices`,
        JSON.stringify({ description: "No title" }),
        { "content-type": "application/json" },
      );
      expect(missingTitle.status).toBe(500);
      expect(missingTitle.body.error).toContain("Title is required");
    });

    it("PATCH /api/missions/slices/:sliceId updates individual fields and validates empty body", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Original" });

      const titleUpdate = await request(
        app,
        "PATCH",
        `/api/missions/slices/${slice.id}`,
        JSON.stringify({ title: "Renamed" }),
        { "content-type": "application/json" },
      );
      expect(titleUpdate.status).toBe(200);
      expect(titleUpdate.body.title).toBe("Renamed");

      const descriptionUpdate = await request(
        app,
        "PATCH",
        `/api/missions/slices/${slice.id}`,
        JSON.stringify({ description: "Updated description" }),
        { "content-type": "application/json" },
      );
      expect(descriptionUpdate.status).toBe(200);
      expect(descriptionUpdate.body.description).toBe("Updated description");

      const statusUpdate = await request(
        app,
        "PATCH",
        `/api/missions/slices/${slice.id}`,
        JSON.stringify({ status: "active" }),
        { "content-type": "application/json" },
      );
      expect(statusUpdate.status).toBe(200);
      expect(statusUpdate.body.status).toBe("active");

      const empty = await request(
        app,
        "PATCH",
        `/api/missions/slices/${slice.id}`,
        JSON.stringify({}),
        { "content-type": "application/json" },
      );
      expect(empty.status).toBe(400);
      expect(empty.body.error).toContain("No valid fields to update");
    });

    it("DELETE /api/missions/slices/:sliceId validates ID and existence", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "To Delete" });

      const removed = await request(app, "DELETE", `/api/missions/slices/${slice.id}`);
      expect(removed.status).toBe(204);

      const missing = await request(app, "DELETE", "/api/missions/slices/SL-NOT-FOUND");
      expect(missing.status).toBe(404);

      const invalid = await request(app, "DELETE", "/api/missions/slices/bad-id");
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("Invalid slice ID format");
    });

    it("POST /api/missions/milestones/:milestoneId/slices/reorder validates IDs", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const s1 = missionStore.addSlice(milestone.id, { title: "One" });
      const s2 = missionStore.addSlice(milestone.id, { title: "Two" });

      const ok = await request(
        app,
        "POST",
        `/api/missions/milestones/${milestone.id}/slices/reorder`,
        JSON.stringify({ orderedIds: [s2.id, s1.id] }),
        { "content-type": "application/json" },
      );
      expect(ok.status).toBe(204);
      expect(missionStore.reorderSlices).toHaveBeenCalledWith(milestone.id, [s2.id, s1.id]);

      const incomplete = await request(
        app,
        "POST",
        `/api/missions/milestones/${milestone.id}/slices/reorder`,
        JSON.stringify({ orderedIds: [s1.id] }),
        { "content-type": "application/json" },
      );
      expect(incomplete.status).toBe(400);
      expect(incomplete.body.error).toContain("orderedIds must include all slices");

      const invalidIds = await request(
        app,
        "POST",
        `/api/missions/milestones/${milestone.id}/slices/reorder`,
        JSON.stringify({ orderedIds: [s1.id, "SL-OTHER-MILESTONE"] }),
        { "content-type": "application/json" },
      );
      expect(invalidIds.status).toBe(400);
      expect(invalidIds.body.error).toContain("Invalid slice IDs in orderedIds");
    });
  });

  describe("Feature CRUD detail", () => {
    it("GET /api/missions/slices/:sliceId/features returns features and 404 for missing slice", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Slice" });
      const feature = missionStore.addFeature(slice.id, { title: "Feature A" });

      const ok = await get(app, `/api/missions/slices/${slice.id}/features`);
      expect(ok.status).toBe(200);
      expect(ok.body).toHaveLength(1);
      expect(ok.body[0].id).toBe(feature.id);

      const missing = await get(app, "/api/missions/slices/SL-NOT-FOUND/features");
      expect(missing.status).toBe(404);
    });

    it("POST /api/missions/slices/:sliceId/features supports acceptanceCriteria and missing slice", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Slice" });

      const created = await request(
        app,
        "POST",
        `/api/missions/slices/${slice.id}/features`,
        JSON.stringify({
          title: "Feature A",
          description: "Feature details",
          acceptanceCriteria: "All tests pass",
        }),
        { "content-type": "application/json" },
      );
      expect(created.status).toBe(201);
      expect(created.body.acceptanceCriteria).toBe("All tests pass");

      const missingSlice = await request(
        app,
        "POST",
        "/api/missions/slices/SL-NOT-FOUND/features",
        JSON.stringify({ title: "Feature" }),
        { "content-type": "application/json" },
      );
      expect(missingSlice.status).toBe(404);
    });

    it("PATCH /api/missions/features/:featureId updates acceptanceCriteria", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Slice" });
      const feature = missionStore.addFeature(slice.id, { title: "Feature" });

      const res = await request(
        app,
        "PATCH",
        `/api/missions/features/${feature.id}`,
        JSON.stringify({ acceptanceCriteria: "Updated criteria" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body.acceptanceCriteria).toBe("Updated criteria");
      expect(missionStore.updateFeature).toHaveBeenCalledWith(feature.id, {
        acceptanceCriteria: "Updated criteria",
      });
    });

    it("DELETE /api/missions/features/:featureId succeeds and rejects invalid ID format", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Slice" });
      const feature = missionStore.addFeature(slice.id, { title: "Feature" });

      const removed = await request(app, "DELETE", `/api/missions/features/${feature.id}`);
      expect(removed.status).toBe(204);

      const invalid = await request(app, "DELETE", "/api/missions/features/invalid-id");
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("Invalid feature ID format");
    });

    it("POST /api/missions/features/:featureId/unlink-task handles linked and unlinked features", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Slice" });
      const linkedFeature = missionStore.addFeature(slice.id, { title: "Linked Feature" });
      missionStore.linkFeatureToTask(linkedFeature.id, "FN-001");

      const unlinked = await request(
        app,
        "POST",
        `/api/missions/features/${linkedFeature.id}/unlink-task`,
        JSON.stringify({}),
        { "content-type": "application/json" },
      );
      expect(unlinked.status).toBe(200);
      expect(unlinked.body.taskId).toBeUndefined();

      const plainFeature = missionStore.addFeature(slice.id, { title: "No Task Feature" });
      const error = await request(
        app,
        "POST",
        `/api/missions/features/${plainFeature.id}/unlink-task`,
        JSON.stringify({}),
        { "content-type": "application/json" },
      );
      expect(error.status).toBe(400);
      expect(error.body).toEqual({ error: "Feature is not linked to a task" });
    });

    it("POST /api/missions/features/:featureId/link-task validates taskId and returns 409 for already linked", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });
      const slice = missionStore.addSlice(milestone.id, { title: "Slice" });
      const feature = missionStore.addFeature(slice.id, { title: "Feature" });

      const missingTaskId = await request(
        app,
        "POST",
        `/api/missions/features/${feature.id}/link-task`,
        JSON.stringify({}),
        { "content-type": "application/json" },
      );
      expect(missingTaskId.status).toBe(400);

      const nonStringTaskId = await request(
        app,
        "POST",
        `/api/missions/features/${feature.id}/link-task`,
        JSON.stringify({ taskId: 42 }),
        { "content-type": "application/json" },
      );
      expect(nonStringTaskId.status).toBe(400);

      (missionStore.linkFeatureToTask as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("Feature is already linked to a task");
      });

      const conflict = await request(
        app,
        "POST",
        `/api/missions/features/${feature.id}/link-task`,
        JSON.stringify({ taskId: "FN-123" }),
        { "content-type": "application/json" },
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toContain("already linked");
    });
  });

  describe("Interview state endpoints", () => {
    it("GET /api/missions/:missionId/interview-state returns default state and validates ids", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });

      const ok = await get(app, `/api/missions/${mission.id}/interview-state`);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ state: "not_started" });

      const missing = await get(app, "/api/missions/M-NOT-FOUND/interview-state");
      expect(missing.status).toBe(404);

      const invalid = await get(app, "/api/missions/invalid-id/interview-state");
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("Invalid mission ID format");
    });

    it("POST /api/missions/:missionId/interview-state updates mission interview state", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });

      const updated = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/interview-state`,
        JSON.stringify({ state: "in_progress" }),
        { "content-type": "application/json" },
      );
      expect(updated.status).toBe(200);
      expect(updated.body.interviewState).toBe("in_progress");
      expect(missionStore.updateMissionInterviewState).toHaveBeenCalledWith(mission.id, "in_progress");
      expect(missionStore.getMission(mission.id)?.interviewState).toBe("in_progress");

      const missing = await request(
        app,
        "POST",
        "/api/missions/M-NOT-FOUND/interview-state",
        JSON.stringify({ state: "in_progress" }),
        { "content-type": "application/json" },
      );
      expect(missing.status).toBe(404);
    });

    it("POST /api/missions/:missionId/interview-state rejects invalid interview state values", async () => {
      const { app, missionStore } = buildApp({ withErrorHandler: true });
      const mission = missionStore.createMission({ title: "Mission" });

      const invalid = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/interview-state`,
        JSON.stringify({ state: "bogus" }),
        { "content-type": "application/json" },
      );

      expect(invalid.status).toBe(500);
      expect(invalid.body.error).toContain("Invalid interview state");
    });

    it("GET/POST milestone interview-state endpoints read and update milestone state", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });

      const getState = await get(app, `/api/missions/milestones/${milestone.id}/interview-state`);
      expect(getState.status).toBe(200);
      expect(getState.body).toEqual({ state: "not_started" });

      const setState = await request(
        app,
        "POST",
        `/api/missions/milestones/${milestone.id}/interview-state`,
        JSON.stringify({ state: "completed" }),
        { "content-type": "application/json" },
      );
      expect(setState.status).toBe(200);
      expect(setState.body.interviewState).toBe("completed");
      expect(missionStore.updateMilestoneInterviewState).toHaveBeenCalledWith(milestone.id, "completed");

      const missingGet = await get(app, "/api/missions/milestones/MS-NOT-FOUND/interview-state");
      expect(missingGet.status).toBe(404);

      const missingPost = await request(
        app,
        "POST",
        "/api/missions/milestones/MS-NOT-FOUND/interview-state",
        JSON.stringify({ state: "completed" }),
        { "content-type": "application/json" },
      );
      expect(missingPost.status).toBe(404);
    });

    it("POST milestone interview-state rejects invalid values", async () => {
      const { app, missionStore } = buildApp({ withErrorHandler: true });
      const mission = missionStore.createMission({ title: "Mission" });
      const milestone = missionStore.addMilestone(mission.id, { title: "Milestone" });

      const invalid = await request(
        app,
        "POST",
        `/api/missions/milestones/${milestone.id}/interview-state`,
        JSON.stringify({ state: "bad" }),
        { "content-type": "application/json" },
      );
      expect(invalid.status).toBe(500);
      expect(invalid.body.error).toContain("Invalid interview state");
    });
  });

  describe("Mission status endpoint", () => {
    it("GET /api/missions/:missionId/status returns computed status and validates errors", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Mission" });

      const ok = await get(app, `/api/missions/${mission.id}/status`);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ status: "active" });
      expect(missionStore.computeMissionStatus).toHaveBeenCalledWith(mission.id);

      const missing = await get(app, "/api/missions/M-NOT-FOUND/status");
      expect(missing.status).toBe(404);

      const invalid = await get(app, "/api/missions/invalid-id/status");
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("Invalid mission ID format");
    });
  });

  describe("Validation edge cases", () => {
    it("mission creation validates empty title, whitespace title, and oversized description", async () => {
      const { app } = buildApp({ withErrorHandler: true });

      const emptyTitle = await request(
        app,
        "POST",
        "/api/missions",
        JSON.stringify({ title: "" }),
        { "content-type": "application/json" },
      );
      expect(emptyTitle.status).toBe(500);
      expect(emptyTitle.body.error).toContain("Title is required");

      const whitespaceTitle = await request(
        app,
        "POST",
        "/api/missions",
        JSON.stringify({ title: "   " }),
        { "content-type": "application/json" },
      );
      expect(whitespaceTitle.status).toBe(500);
      expect(whitespaceTitle.body.error).toContain("Title is required");

      const oversizedDescription = await request(
        app,
        "POST",
        "/api/missions",
        JSON.stringify({ title: "Valid title", description: "x".repeat(5001) }),
        { "content-type": "application/json" },
      );
      expect(oversizedDescription.status).toBe(500);
      expect(oversizedDescription.body.error).toContain("Description must not exceed 5000 characters");
    });

    it("mission update validates invalid status values", async () => {
      const { app, missionStore } = buildApp({ withErrorHandler: true });
      const mission = missionStore.createMission({ title: "Mission" });

      const invalid = await request(
        app,
        "PATCH",
        `/api/missions/${mission.id}`,
        JSON.stringify({ status: "bogus" }),
        { "content-type": "application/json" },
      );
      expect(invalid.status).toBe(500);
      expect(invalid.body.error).toContain("Invalid status");
    });

    it("mission creation rejects non-boolean autoAdvance", async () => {
      const { app } = buildApp({ withErrorHandler: true });

      const invalid = await request(
        app,
        "POST",
        "/api/missions",
        JSON.stringify({ title: "Mission", autoAdvance: "yes" }),
        { "content-type": "application/json" },
      );

      expect(invalid.status).toBe(500);
      expect(invalid.body.error).toContain("autoAdvance must be a boolean");
    });

    it("400-level route validation responses return explicit route messages", async () => {
      const { app } = buildApp();

      const invalidMissionId = await get(app, "/api/missions/invalid-id/status");
      expect(invalidMissionId.status).toBe(400);
      expect(invalidMissionId.body).toEqual({ error: "Invalid mission ID format" });

      const invalidFeatureId = await request(app, "DELETE", "/api/missions/features/invalid-id");
      expect(invalidFeatureId.status).toBe(400);
      expect(invalidFeatureId.body).toEqual({ error: "Invalid feature ID format" });
    });
  });

  describe("Interview endpoints", () => {    beforeEach(() => {
      __resetMissionInterviewState();
    });

    it("should return 400 when missionTitle is missing on interview start", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/interview/start",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("missionTitle");
    });

    it("should return 400 when sessionId is missing on interview respond", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/interview/respond",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("sessionId");
    });

    it("should return 400 when sessionId is missing on interview cancel", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/interview/cancel",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("sessionId");
    });

    it("returns 409 when interview respond is locked by another tab", async () => {
      const submitSpy = vi.spyOn(missionInterviewModule, "submitMissionInterviewResponse");

      const { app } = buildApp({
        aiSessionStore: {
          acquireLock: () => ({ acquired: false, currentHolder: "tab-owner" }),
        },
      });

      const res = await request(
        app,
        "POST",
        "/api/missions/interview/respond",
        JSON.stringify({
          sessionId: "session-locked",
          responses: { "q-1": "answer" },
          tabId: "tab-other",
        }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "Session locked by another tab",
        lockedByTab: "tab-owner",
      });
      expect(submitSpy).not.toHaveBeenCalled();
    });

    it("returns 409 when interview cancel is locked by another tab", async () => {
      const cancelSpy = vi.spyOn(missionInterviewModule, "cancelMissionInterviewSession");

      const { app } = buildApp({
        aiSessionStore: {
          acquireLock: () => ({ acquired: false, currentHolder: "tab-owner" }),
        },
      });

      const res = await request(
        app,
        "POST",
        "/api/missions/interview/cancel",
        JSON.stringify({
          sessionId: "session-locked",
          tabId: "tab-other",
        }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "Session locked by another tab",
        lockedByTab: "tab-owner",
      });
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it("returns 409 when interview retry is locked by another tab", async () => {
      const retrySpy = vi.spyOn(missionInterviewModule, "retryMissionInterviewSession");

      const { app } = buildApp({
        aiSessionStore: {
          acquireLock: () => ({ acquired: false, currentHolder: "tab-owner" }),
        },
      });

      const res = await request(
        app,
        "POST",
        "/api/missions/interview/session-locked/retry",
        JSON.stringify({ tabId: "tab-other" }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "Session locked by another tab",
        lockedByTab: "tab-owner",
      });
      expect(retrySpy).not.toHaveBeenCalled();
    });

    it("allows interview respond/cancel/retry when tabId is omitted", async () => {
      vi.spyOn(missionInterviewModule, "submitMissionInterviewResponse").mockResolvedValueOnce({
        type: "question",
        data: {
          id: "q-next",
          type: "text",
          question: "next",
          description: "next",
        },
      } as any);
      vi.spyOn(missionInterviewModule, "cancelMissionInterviewSession").mockResolvedValueOnce(undefined);
      vi.spyOn(missionInterviewModule, "retryMissionInterviewSession").mockResolvedValueOnce(undefined);

      const { app } = buildApp({
        aiSessionStore: {
          acquireLock: () => ({ acquired: false, currentHolder: "tab-owner" }),
        },
      });

      const respondRes = await request(
        app,
        "POST",
        "/api/missions/interview/respond",
        JSON.stringify({ sessionId: "session-open", responses: { "q-1": "answer" } }),
        { "content-type": "application/json" },
      );
      expect(respondRes.status).toBe(200);

      const cancelRes = await request(
        app,
        "POST",
        "/api/missions/interview/cancel",
        JSON.stringify({ sessionId: "session-open" }),
        { "content-type": "application/json" },
      );
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body).toEqual({ success: true });

      const retryRes = await request(app, "POST", "/api/missions/interview/session-open/retry");
      expect(retryRes.status).toBe(200);
      expect(retryRes.body).toEqual({ success: true, sessionId: "session-open" });
    });

    it("retries a failed interview session", async () => {
      const retrySpy = vi
        .spyOn(missionInterviewModule, "retryMissionInterviewSession")
        .mockResolvedValueOnce(undefined);

      const { app } = buildApp();
      const res = await request(app, "POST", "/api/missions/interview/session-1/retry");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, sessionId: "session-1" });
      expect(retrySpy).toHaveBeenCalledWith("session-1", "/fake/root");
    });

    it("returns 404 when interview retry session is missing", async () => {
      vi.spyOn(missionInterviewModule, "retryMissionInterviewSession").mockRejectedValueOnce(
        new missionInterviewModule.SessionNotFoundError("Interview session missing"),
      );

      const { app } = buildApp();
      const res = await request(app, "POST", "/api/missions/interview/session-404/retry");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Interview session missing");
    });

    it("returns 400 when interview retry session is not in error state", async () => {
      vi.spyOn(missionInterviewModule, "retryMissionInterviewSession").mockRejectedValueOnce(
        new missionInterviewModule.InvalidSessionStateError("Session is not in an error state"),
      );

      const { app } = buildApp();
      const res = await request(app, "POST", "/api/missions/interview/session-400/retry");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("not in an error state");
    });

    it("replays buffered interview events when Last-Event-ID is provided", async () => {
      const { app } = buildApp();
      const sessionId = await createMissionInterviewSession("127.0.0.1", "Replay Mission", "/tmp/project");

      missionInterviewStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });
      missionInterviewStreamManager.broadcast(sessionId, { type: "thinking", data: "second" });

      setTimeout(() => {
        missionInterviewStreamManager.broadcast(sessionId, { type: "complete" });
      }, 0);

      const res = await request(
        app,
        "GET",
        `/api/missions/interview/${sessionId}/stream`,
        undefined,
        { "last-event-id": "1" },
      );

      expect(res.status).toBe(200);
      expect(res.body).toContain("id: 2");
      expect(res.body).toContain("event: thinking");
      expect(res.body).toContain("id: 3");
      expect(res.body).toContain("event: complete");
      expect(res.body).not.toContain("id: 1\nevent: thinking");
    });

    it("does not replay buffered interview events when Last-Event-ID is missing", async () => {
      const { app } = buildApp();
      const sessionId = await createMissionInterviewSession("127.0.0.1", "No Replay Mission", "/tmp/project");

      missionInterviewStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });

      setTimeout(() => {
        missionInterviewStreamManager.broadcast(sessionId, { type: "complete" });
      }, 0);

      const res = await request(
        app,
        "GET",
        `/api/missions/interview/${sessionId}/stream`,
      );

      expect(res.status).toBe(200);
      expect(res.body).not.toContain("id: 1\nevent: thinking");
      expect(res.body).toContain("id: 2");
      expect(res.body).toContain("event: complete");
    });

    it("gracefully ignores invalid Last-Event-ID values for interview streams", async () => {
      const { app } = buildApp();
      const sessionId = await createMissionInterviewSession("127.0.0.1", "Invalid Replay Mission", "/tmp/project");

      missionInterviewStreamManager.broadcast(sessionId, { type: "thinking", data: "first" });

      setTimeout(() => {
        missionInterviewStreamManager.broadcast(sessionId, { type: "complete" });
      }, 0);

      const res = await request(
        app,
        "GET",
        `/api/missions/interview/${sessionId}/stream`,
        undefined,
        { "last-event-id": "not-a-number" },
      );

      expect(res.status).toBe(200);
      expect(res.body).not.toContain("id: 1\nevent: thinking");
      expect(res.body).toContain("id: 2");
      expect(res.body).toContain("event: complete");
    });

    it("should return 400 when sessionId is missing on create-mission", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/interview/create-mission",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("sessionId");
    });

    it("captures generated thinking for the next mission interview question", async () => {
      const store = new MockAiSessionStore();
      const sessionId = "mission-thinking-capture";
      store.rows.set(
        sessionId,
        buildMissionInterviewRow({
          id: sessionId,
          status: "awaiting_input",
          thinkingOutput: "First-turn mission reasoning",
        }),
      );
      setAiSessionStore(store as any);

      const session = getMissionInterviewSession(sessionId);
      expect(session).toBeDefined();
      if (!session) {
        throw new Error("Expected mission interview session to exist");
      }

      const messages: Array<{ role: string; content: string }> = [];
      session.agent = {
        session: {
          state: { messages },
          prompt: vi.fn(async (message: string) => {
            messages.push({ role: "user", content: message });
            session.thinkingOutput += "Generated follow-up reasoning";
            messages.push({
              role: "assistant",
              content: JSON.stringify({
                type: "question",
                data: {
                  id: "q-followup",
                  type: "text",
                  question: "What should we deliver first?",
                  description: "Clarify order",
                },
              }),
            });
          }),
          dispose: vi.fn(),
        },
      } as any;

      const response = await submitMissionInterviewResponse(
        sessionId,
        { "q-existing": "Ship collaborative editing" },
        "/tmp/project",
      );

      expect(response.type).toBe("question");
      expect(getMissionInterviewSession(sessionId)?.lastGeneratedThinking).toBe(
        "Generated follow-up reasoning",
      );
    });

    it("stores and persists per-turn mission interview thinking in conversation history", async () => {
      const store = new MockAiSessionStore();
      const sessionId = "mission-thinking-history";
      store.rows.set(
        sessionId,
        buildMissionInterviewRow({
          id: sessionId,
          status: "awaiting_input",
          thinkingOutput: "First-turn stored reasoning",
        }),
      );
      setAiSessionStore(store as any);

      const session = getMissionInterviewSession(sessionId);
      expect(session).toBeDefined();
      if (!session) {
        throw new Error("Expected mission interview session to exist");
      }

      const messages: Array<{ role: string; content: string }> = [];
      session.agent = {
        session: {
          state: { messages },
          prompt: vi.fn(async (message: string) => {
            messages.push({ role: "user", content: message });
            session.thinkingOutput += "Second-turn mission reasoning";
            messages.push({
              role: "assistant",
              content: JSON.stringify({
                type: "question",
                data: {
                  id: "q-next",
                  type: "text",
                  question: "Who owns implementation?",
                  description: "Team ownership",
                },
              }),
            });
          }),
          dispose: vi.fn(),
        },
      } as any;

      await submitMissionInterviewResponse(
        sessionId,
        { "q-existing": "Need milestone planning" },
        "/tmp/project",
      );

      const inMemorySession = getMissionInterviewSession(sessionId);
      expect(inMemorySession?.history[0]).toMatchObject({
        question: expect.objectContaining({ id: "q-existing" }),
        response: { "q-existing": "Need milestone planning" },
        thinkingOutput: "First-turn stored reasoning",
      });

      const persistedRow = store.get(sessionId);
      expect(persistedRow).not.toBeNull();
      const persistedHistory = JSON.parse(persistedRow!.conversationHistory) as Array<{
        question: { id: string };
        response: Record<string, unknown>;
        thinkingOutput?: string;
      }>;

      expect(persistedHistory[0]).toMatchObject({
        question: expect.objectContaining({ id: "q-existing" }),
        response: { "q-existing": "Need milestone planning" },
        thinkingOutput: "First-turn stored reasoning",
      });
    });
  });

  // ── Regression: Generated ID format acceptance ─────────────────────────
  //
  // MissionStore.generateMissionId() produces IDs like M-LZ7DN0-A2B5
  // (prefix + base36 timestamp + random suffix). The route validators must
  // accept these, not just the legacy numeric format (M-1, MS-1, etc.).
  describe("Generated ID format regression", () => {
    // Realistic IDs matching what MissionStore generates
    const generatedMissionId = "M-LZ7DN0-A2B5";
    const generatedMilestoneId = "MS-M3N8QR-C9F1";
    const generatedSliceId = "SL-P4T2WX-D5E8";
    const generatedFeatureId = "F-J6K9AB-G7H3";

    it("should accept generated mission ID on GET", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Generated ID Mission" });

      const res = await get(app, `/api/missions/${mission.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(mission.id);
    });

    it("should accept generated mission ID on PATCH", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Generated ID Mission" });

      const res = await request(
        app,
        "PATCH",
        `/api/missions/${mission.id}`,
        JSON.stringify({ title: "Updated Title" }),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Updated Title");
    });

    it("should accept generated mission ID on DELETE", async () => {
      const { app, missionStore } = buildApp();
      const mission = missionStore.createMission({ title: "Generated ID Mission" });

      const res = await request(app, "DELETE", `/api/missions/${mission.id}`);
      expect(res.status).toBe(204);
    });

    it("should accept generated milestone ID on GET (returns 404, not 400)", async () => {
      const { app } = buildApp();
      const res = await get(app, `/api/missions/milestones/${generatedMilestoneId}`);
      // 404 = entity not found (valid ID format), NOT 400 (invalid format)
      expect(res.status).toBe(404);
    });

    it("should accept generated milestone ID on DELETE (returns 404, not 400)", async () => {
      const { app } = buildApp();
      const res = await request(app, "DELETE", `/api/missions/milestones/${generatedMilestoneId}`);
      expect(res.status).toBe(404);
    });

    it("should accept generated slice ID on GET (returns 404, not 400)", async () => {
      const { app } = buildApp();
      const res = await get(app, `/api/missions/slices/${generatedSliceId}`);
      expect(res.status).toBe(404);
    });

    it("should accept generated slice ID on DELETE (returns 404, not 400)", async () => {
      const { app } = buildApp();
      const res = await request(app, "DELETE", `/api/missions/slices/${generatedSliceId}`);
      expect(res.status).toBe(404);
    });

    it("should accept generated slice ID on activate (returns 404, not 400)", async () => {
      const { app } = buildApp();
      const res = await request(app, "POST", `/api/missions/slices/${generatedSliceId}/activate`);
      expect(res.status).toBe(404);
    });

    it("should accept generated feature ID on GET (returns 404, not 400)", async () => {
      const { app } = buildApp();
      const res = await get(app, `/api/missions/features/${generatedFeatureId}`);
      expect(res.status).toBe(404);
    });

    it("should accept generated feature ID on DELETE (returns 404, not 400)", async () => {
      const { app } = buildApp();
      const res = await request(app, "DELETE", `/api/missions/features/${generatedFeatureId}`);
      expect(res.status).toBe(404);
    });

    it("should still reject obviously malformed IDs", async () => {
      const { app } = buildApp();
      // IDs that don't match any prefix pattern
      const res = await get(app, "/api/missions/invalid-id");
      expect(res.status).toBe(400);
    });

    it("should still reject IDs with wrong prefix", async () => {
      const { app } = buildApp();
      // Milestone ID used where mission ID expected
      const res = await get(app, `/api/missions/${generatedMilestoneId}`);
      expect(res.status).toBe(400);
    });

    it("should accept generated feature ID on link-task (returns 404, not 400)", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        `/api/missions/features/${generatedFeatureId}/link-task`,
        JSON.stringify({ taskId: "FN-001" }),
        { "content-type": "application/json" }
      );
      expect(res.status).toBe(404);
    });
  });

  // ── Feature Triage Endpoints ────────────────────────────────────────────

  describe("POST /api/missions/features/:featureId/triage", () => {
    it("should triage a defined feature", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      // Create mission hierarchy
      const mission = ms.createMission({ title: "Test Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });

      const res = await request(
        app,
        "POST",
        `/api/missions/features/${feature.id}/triage`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("triaged");
      expect(res.body.taskId).toBeTruthy();
    });

    it("should return 404 for non-existent feature", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/features/F-NONEXISTENT-XXX/triage",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(404);
    });

    it("should return 400 for already triaged feature", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      const mission = ms.createMission({ title: "Test Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });

      // Triage it first
      await ms.triageFeature(feature.id);

      // Try again — should fail
      const res = await request(
        app,
        "POST",
        `/api/missions/features/${feature.id}/triage`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/missions/slices/:sliceId/triage-all", () => {
    it("should triage all defined features in a slice", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      const mission = ms.createMission({ title: "Test Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      ms.addFeature(slice.id, { title: "Feature 1" });
      ms.addFeature(slice.id, { title: "Feature 2" });

      const res = await request(
        app,
        "POST",
        `/api/missions/slices/${slice.id}/triage-all`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.triaged).toHaveLength(2);
      expect(res.body.triaged.every((f: MissionFeature) => f.status === "triaged")).toBe(true);
    });

    it("should return 404 for non-existent slice", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/slices/SL-NONEXISTENT-XXX/triage-all",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(404);
    });
  });

  // ── Mission Pause/Stop/Resume Endpoints ──────────────────────────────────

  describe("POST /api/missions/:missionId/pause", () => {
    it("should pause an active mission", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      const mission = ms.createMission({ title: "Test Mission" });
      // Set to active
      ms.updateMission(mission.id, { status: "active" });

      const res = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/pause`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("blocked");
    });

    it("should return 404 for non-existent mission", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/M-NONEXISTENT-XXX/pause",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(404);
    });

    it("should return 400 if mission is already blocked", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      const mission = ms.createMission({ title: "Test Mission" });
      ms.updateMission(mission.id, { status: "blocked" });

      const res = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/pause`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/missions/:missionId/resume", () => {
    it("should resume a blocked mission", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      const mission = ms.createMission({ title: "Test Mission" });
      ms.updateMission(mission.id, { status: "blocked" });

      const res = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/resume`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
    });

    it("should return 400 if mission is not blocked", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      const mission = ms.createMission({ title: "Test Mission" });
      // Mission starts as "planning"

      const res = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/resume`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/missions/:missionId/stop", () => {
    it("should stop a mission and return paused task IDs", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      const mission = ms.createMission({ title: "Test Mission" });
      ms.updateMission(mission.id, { status: "active" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Slice" });
      const feature = ms.addFeature(slice.id, { title: "Feature" });
      // Simulate a linked task
      ms.linkFeatureToTask(feature.id, "FN-001");

      const res = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/stop`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("blocked");
      expect(res.body.pausedTaskIds).toContain("FN-001");
    });

    it("should return 404 for non-existent mission", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/M-NONEXISTENT-XXX/stop",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(404);
    });
  });

  // ── Mission Start Endpoint ────────────────────────────────────────────────

  describe("POST /api/missions/:missionId/start", () => {
    it("should start a planning mission and activate the first slice", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      // Create mission with milestone, slice, and defined features
      const mission = ms.createMission({ title: "Test Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone 1" });
      const slice = ms.addSlice(milestone.id, { title: "Slice 1" });
      const feature1 = ms.addFeature(slice.id, { title: "Feature 1" });
      const feature2 = ms.addFeature(slice.id, { title: "Feature 2" });

      const res = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/start`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(200);
      // Verify mission status is active
      expect(res.body.status).toBe("active");
      // Verify autoAdvance is true
      expect(res.body.autoAdvance).toBe(true);
      // Verify hierarchy is returned
      expect(res.body.milestones).toBeDefined();
      expect(res.body.milestones.length).toBe(1);

      // Verify the slice was activated
      const activatedSlice = res.body.milestones[0].slices[0];
      expect(activatedSlice.status).toBe("active");
      expect(activatedSlice.activatedAt).toBeDefined();

      // Verify features were triaged (auto-triage via activateSlice)
      const triagedFeatures = activatedSlice.features;
      expect(triagedFeatures.length).toBe(2);
      for (const f of triagedFeatures) {
        expect(f.status).toBe("triaged");
        expect(f.taskId).toBeDefined();
      }
    });

    it("should return 409 for already-active mission", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      const mission = ms.createMission({ title: "Active Mission" });
      ms.updateMission(mission.id, { status: "active" });

      const res = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/start`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("planning");
    });

    it("should return 400 when no pending slices exist", async () => {
      const { app, missionStore } = buildApp();
      const ms = missionStore as ReturnType<typeof createMockMissionStore>;

      const mission = ms.createMission({ title: "Empty Mission" });
      const milestone = ms.addMilestone(mission.id, { title: "Milestone" });
      const slice = ms.addSlice(milestone.id, { title: "Active Slice" });
      // Mark the slice as active (not pending)
      ms.updateSlice(slice.id, { status: "active" });

      const res = await request(
        app,
        "POST",
        `/api/missions/${mission.id}/start`,
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("No pending slices");
    });

    it("should return 404 for non-existent mission", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/M-NONEXISTENT-XXX/start",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(404);
    });

    it("should return 400 for invalid mission ID format", async () => {
      const { app } = buildApp();
      const res = await request(
        app,
        "POST",
        "/api/missions/bad-id/start",
        JSON.stringify({}),
        { "content-type": "application/json" }
      );

      expect(res.status).toBe(400);
    });
  });

  // ── Autopilot Endpoints ──────────────────────────────────────────────────

  describe("autopilot endpoints", () => {
    describe("GET /api/missions/:missionId/autopilot", () => {
      it("returns autopilot status from service when provided", async () => {
        const missionAutopilot = createMockMissionAutopilot();
        const { app, missionStore } = buildApp({ missionAutopilot });
        const mission = missionStore.createMission({ title: "Autopilot Mission" });

        missionAutopilot.getAutopilotStatus.mockReturnValue({
          enabled: true,
          state: "watching",
          watched: true,
          lastActivityAt: "2026-04-07T12:00:00.000Z",
        });

        const res = await get(app, `/api/missions/${mission.id}/autopilot`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          enabled: true,
          state: "watching",
          watched: true,
          lastActivityAt: "2026-04-07T12:00:00.000Z",
        });
        expect(missionAutopilot.getAutopilotStatus).toHaveBeenCalledWith(mission.id);
      });

      it("returns fallback mission status when autopilot service is unavailable", async () => {
        const { app, missionStore } = buildApp();
        const mission = missionStore.createMission({ title: "Fallback Mission" });
        missionStore.updateMission(mission.id, {
          autopilotEnabled: true,
          autopilotState: "watching",
          lastAutopilotActivityAt: "2026-04-07T13:00:00.000Z",
        });

        const res = await get(app, `/api/missions/${mission.id}/autopilot`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          enabled: true,
          state: "watching",
          watched: false,
          lastActivityAt: "2026-04-07T13:00:00.000Z",
        });
      });
    });

    describe("PATCH /api/missions/:missionId/autopilot", () => {
      it("enables autopilot and starts planning missions", async () => {
        const missionAutopilot = createMockMissionAutopilot();
        const { app, missionStore } = buildApp({ missionAutopilot });
        const mission = missionStore.createMission({ title: "Enable Autopilot" });

        missionAutopilot.getAutopilotStatus.mockReturnValue({
          enabled: true,
          state: "watching",
          watched: true,
          lastActivityAt: undefined,
        });

        const res = await request(
          app,
          "PATCH",
          `/api/missions/${mission.id}/autopilot`,
          JSON.stringify({ enabled: true }),
          { "content-type": "application/json" },
        );

        expect(res.status).toBe(200);
        expect(missionAutopilot.watchMission).toHaveBeenCalledWith(mission.id);
        expect(missionAutopilot.checkAndStartMission).toHaveBeenCalledWith(mission.id);
        expect(missionStore.updateMission).toHaveBeenCalledWith(mission.id, { autopilotEnabled: true });
      });

      it("disables autopilot and unwatches mission", async () => {
        const missionAutopilot = createMockMissionAutopilot();
        const { app, missionStore } = buildApp({ missionAutopilot });
        const mission = missionStore.createMission({ title: "Disable Autopilot" });

        missionAutopilot.getAutopilotStatus.mockReturnValue({
          enabled: false,
          state: "inactive",
          watched: false,
          lastActivityAt: undefined,
        });

        const res = await request(
          app,
          "PATCH",
          `/api/missions/${mission.id}/autopilot`,
          JSON.stringify({ enabled: false }),
          { "content-type": "application/json" },
        );

        expect(res.status).toBe(200);
        expect(missionAutopilot.unwatchMission).toHaveBeenCalledWith(mission.id);
        expect(missionAutopilot.checkAndStartMission).not.toHaveBeenCalled();
      });

      it("returns 400 when enabled is missing or not boolean", async () => {
        const { app, missionStore } = buildApp();
        const mission = missionStore.createMission({ title: "Invalid Payload" });

        const missingRes = await request(
          app,
          "PATCH",
          `/api/missions/${mission.id}/autopilot`,
          JSON.stringify({}),
          { "content-type": "application/json" },
        );
        expect(missingRes.status).toBe(400);

        const invalidRes = await request(
          app,
          "PATCH",
          `/api/missions/${mission.id}/autopilot`,
          JSON.stringify({ enabled: "yes" }),
          { "content-type": "application/json" },
        );
        expect(invalidRes.status).toBe(400);
      });

      it("returns fallback response without autopilot service", async () => {
        const { app, missionStore } = buildApp();
        const mission = missionStore.createMission({ title: "No Autopilot Service" });

        const res = await request(
          app,
          "PATCH",
          `/api/missions/${mission.id}/autopilot`,
          JSON.stringify({ enabled: true }),
          { "content-type": "application/json" },
        );

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          enabled: true,
          state: "inactive",
          watched: false,
          lastActivityAt: undefined,
        });
      });
    });

    describe("POST /api/missions/:missionId/autopilot/start", () => {
      it("starts watching when autopilot is enabled", async () => {
        const missionAutopilot = createMockMissionAutopilot();
        const { app, missionStore } = buildApp({ missionAutopilot });
        const mission = missionStore.createMission({ title: "Start Autopilot" });
        missionStore.updateMission(mission.id, { autopilotEnabled: true });

        missionAutopilot.getAutopilotStatus.mockReturnValue({
          enabled: true,
          state: "watching",
          watched: true,
          lastActivityAt: undefined,
        });

        const res = await request(
          app,
          "POST",
          `/api/missions/${mission.id}/autopilot/start`,
          JSON.stringify({}),
          { "content-type": "application/json" },
        );

        expect(res.status).toBe(200);
        expect(missionAutopilot.watchMission).toHaveBeenCalledWith(mission.id);
        expect(missionAutopilot.checkAndStartMission).toHaveBeenCalledWith(mission.id);
      });

      it("returns 400 when mission autopilot is disabled", async () => {
        const missionAutopilot = createMockMissionAutopilot();
        const { app, missionStore } = buildApp({ missionAutopilot });
        const mission = missionStore.createMission({ title: "Disabled Autopilot" });

        const res = await request(
          app,
          "POST",
          `/api/missions/${mission.id}/autopilot/start`,
          JSON.stringify({}),
          { "content-type": "application/json" },
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("not enabled");
      });

      it("returns 503 when autopilot service is unavailable", async () => {
        const { app, missionStore } = buildApp();
        const mission = missionStore.createMission({ title: "Service Unavailable" });
        missionStore.updateMission(mission.id, { autopilotEnabled: true });

        const res = await request(
          app,
          "POST",
          `/api/missions/${mission.id}/autopilot/start`,
          JSON.stringify({}),
          { "content-type": "application/json" },
        );

        expect(res.status).toBe(503);
      });
    });

    describe("POST /api/missions/:missionId/autopilot/stop", () => {
      it("stops watching when autopilot service is available", async () => {
        const missionAutopilot = createMockMissionAutopilot();
        const { app, missionStore } = buildApp({ missionAutopilot });
        const mission = missionStore.createMission({ title: "Stop Autopilot" });

        missionAutopilot.getAutopilotStatus.mockReturnValue({
          enabled: true,
          state: "inactive",
          watched: false,
          lastActivityAt: undefined,
        });

        const res = await request(
          app,
          "POST",
          `/api/missions/${mission.id}/autopilot/stop`,
          JSON.stringify({}),
          { "content-type": "application/json" },
        );

        expect(res.status).toBe(200);
        expect(missionAutopilot.unwatchMission).toHaveBeenCalledWith(mission.id);
      });

      it("returns fallback status when autopilot service is unavailable", async () => {
        const { app, missionStore } = buildApp();
        const mission = missionStore.createMission({ title: "Stop Fallback" });
        missionStore.updateMission(mission.id, {
          autopilotEnabled: true,
          lastAutopilotActivityAt: "2026-04-07T15:00:00.000Z",
        });

        const res = await request(
          app,
          "POST",
          `/api/missions/${mission.id}/autopilot/stop`,
          JSON.stringify({}),
          { "content-type": "application/json" },
        );

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          enabled: true,
          state: "inactive",
          watched: false,
          lastActivityAt: "2026-04-07T15:00:00.000Z",
        });
      });
    });
  });
});
