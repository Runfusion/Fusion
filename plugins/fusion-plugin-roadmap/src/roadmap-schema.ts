import type { Database } from "@fusion/core";

export function ensureRoadmapSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roadmaps (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roadmap_milestones (
      id TEXT PRIMARY KEY,
      roadmapId TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      orderIndex INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (roadmapId) REFERENCES roadmaps(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS roadmap_features (
      id TEXT PRIMARY KEY,
      milestoneId TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      orderIndex INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (milestoneId) REFERENCES roadmap_milestones(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idxRoadmapMilestonesRoadmapOrder
      ON roadmap_milestones(roadmapId, orderIndex, createdAt, id);

    CREATE INDEX IF NOT EXISTS idxRoadmapFeaturesMilestoneOrder
      ON roadmap_features(milestoneId, orderIndex, createdAt, id);
  `);
}
