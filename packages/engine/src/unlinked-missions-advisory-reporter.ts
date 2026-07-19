import { computeInsightFingerprint, type AsyncMissionStore, type Mission, type MissionStore, type TaskStore } from "@fusion/core";
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
      /*
      FNXC:UnlinkedMissionsAdvisory 2026-07-17-16:20:
      Scheduled advisory behavior must be identical for the synchronous MissionStore
      and PostgreSQL AsyncMissionStore. Both expose the same mission and goal-link
      queries, so await their union rather than disabling a production scheduler path.
      */
      const missionStore: MissionStore | AsyncMissionStore = this.store.getMissionStore();
      const missions = await missionStore.listMissions();
      const unlinkedActiveMissions: Mission[] = [];

      for (const mission of missions) {
        if (mission.status !== "active") {
          continue;
        }
        if ((await missionStore.listGoalIdsForMission(mission.id)).length > 0) {
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
        // FNXC:PostgresInsights 2026-07-14-17:25: Persist through the async
        // insight store instead of treating PostgreSQL as unavailable.
        insightStore = this.store.getInsightStore();
      } catch (error) {
        await this.store.logEntry(
          missionIds[0],
          `[unlinked-missions-advisory] ${content}`,
        );
        this.logger.warn("[unlinked-missions-advisory] insight store unavailable; logged fallback payload", error);
        return { alerted: true };
      }

      const existingInsights = await insightStore.listInsights({
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

      await insightStore.upsertInsight(this.projectId, {
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
