import { computeInsightFingerprint, InsightStore, MissionStore, type Mission, type TaskStore } from "@fusion/core";
import { createLogger } from "./logger.js";

const reporterLog = createLogger("unlinked-missions-advisory");
export const UNLINKED_MISSIONS_ADVISORY_TITLE = "Unlinked active missions need goal links";
export const UNLINKED_MISSIONS_ADVISORY_KEY = "unlinked_missions_advisory";

type UnlinkedMissionsAdvisoryReporterLogger = {
  warn: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
};

interface UnlinkedMissionsAdvisoryReporterOptions {
  store: TaskStore;
  projectId: string;
  logger?: UnlinkedMissionsAdvisoryReporterLogger;
  now?: () => number;
}

export class UnlinkedMissionsAdvisoryReporter {
  private readonly store: TaskStore;
  private readonly projectId: string;
  private readonly logger: UnlinkedMissionsAdvisoryReporterLogger;
  private readonly now: () => number;

  constructor(options: UnlinkedMissionsAdvisoryReporterOptions) {
    this.store = options.store;
    this.projectId = options.projectId;
    this.logger = options.logger ?? reporterLog;
    this.now = options.now ?? (() => Date.now());
  }

  async report(): Promise<{ alerted: boolean; reason?: string }> {
    try {
      // FNXC:MissionStore 2026-06-27-15:40:
      // This reporter reads the MissionStore synchronously. In PG backend mode
      // getMissionStore() returns the AsyncMissionStore (CRUD-only, not an
      // EventEmitter); guard with instanceof and degrade gracefully — the advisory
      // is sync-mode only this unit.
      const resolvedMissionStore = this.store.getMissionStore();
      if (!(resolvedMissionStore instanceof MissionStore)) {
        return { alerted: false, reason: "mission-store-async-unsupported" };
      }
      const missionStore = resolvedMissionStore;
      const missions = missionStore.listMissions();
      const unlinkedActiveMissions: Mission[] = [];

      for (const mission of missions) {
        if (mission.status !== "active") {
          continue;
        }
        if (missionStore.listGoalIdsForMission(mission.id).length > 0) {
          continue;
        }
        unlinkedActiveMissions.push(mission);
      }

      if (unlinkedActiveMissions.length === 0) {
        return { alerted: false, reason: "none-unlinked" };
      }

      const detectedAt = new Date(this.now()).toISOString();
      const missionIds = unlinkedActiveMissions.map((mission) => mission.id);
      const content = JSON.stringify({
        unlinkedCount: missionIds.length,
        missionIds,
        detectedAt,
      });

      let insightStore;
      try {
        if (!this.projectId) {
          throw new Error("empty projectId");
        }
        // FNXC:InsightStore 2026-06-27-09:25:
        // getInsightStore() now returns InsightStore | AsyncInsightStore. This
        // reporter calls the store synchronously and stays on graceful fallback
        // in PG backend mode (not ported this unit) — route async into the catch.
        const resolved = this.store.getInsightStore();
        if (!(resolved instanceof InsightStore)) {
          throw new Error("InsightStore not available in PG backend mode");
        }
        insightStore = resolved;
      } catch (error) {
        await this.store.logEntry(
          missionIds[0],
          `[unlinked-missions-advisory] ${content}`,
        );
        this.logger.warn("[unlinked-missions-advisory] insight store unavailable; logged fallback payload", error);
        return { alerted: true };
      }

      const existingInsights = insightStore.listInsights({
        projectId: this.projectId,
        category: "workflow",
        limit: 10,
      });
      const existing = existingInsights.find(
        (insight) =>
          insight.title === UNLINKED_MISSIONS_ADVISORY_TITLE &&
          insight.provenance?.metadata?.advisoryKey === UNLINKED_MISSIONS_ADVISORY_KEY,
      );
      if (existing) {
        return { alerted: false, reason: "already-reported" };
      }

      insightStore.upsertInsight(this.projectId, {
        title: UNLINKED_MISSIONS_ADVISORY_TITLE,
        content,
        category: "workflow",
        fingerprint: computeInsightFingerprint(UNLINKED_MISSIONS_ADVISORY_TITLE, "workflow"),
        provenance: {
          trigger: "schedule",
          description:
            "Advisory for active missions that still need explicit goal links after the no-backfill decision.",
          relatedEntityIds: missionIds,
          metadata: {
            generator: "unlinked-missions-advisory-reporter",
            advisoryKey: UNLINKED_MISSIONS_ADVISORY_KEY,
          },
        },
      });

      this.logger.warn(
        `[unlinked-missions-advisory] advisory emitted for active missions without goal links: ${missionIds.join(",")}`,
      );
      return { alerted: true };
    } catch (error) {
      this.logger.error?.("[unlinked-missions-advisory] reporter failed", error);
      return { alerted: false, reason: "error" };
    }
  }
}
