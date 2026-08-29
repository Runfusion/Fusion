/**
 * INTERIM IN-MEMORY STORE — replaced by FN-3784's persistent storage.
 * The `ReportRunRecord` shape is intended to be a strict subset of FN-3784's eventual schema.
 */
import type { ReportsCadence } from "./cadence.js";

export type ReportRunStatus = "queued" | "running" | "review" | "approved" | "published" | "failed";

export interface ReportRunRecord {
  id: string;
  cadence: ReportsCadence;
  status: ReportRunStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  reportId?: string;
}

export interface ReportsRunsStore {
  create(record: ReportRunRecord): Promise<ReportRunRecord>;
  update(
    id: string,
    patch: Partial<Omit<ReportRunRecord, "id" | "createdAt">>,
  ): Promise<ReportRunRecord | undefined>;
  get(id: string): Promise<ReportRunRecord | undefined>;
  list(limit?: number): Promise<ReportRunRecord[]>;
}

function cloneRecord(record: ReportRunRecord): ReportRunRecord {
  return { ...record };
}

export function createInMemoryReportsRunsStore(seed: ReportRunRecord[] = []): ReportsRunsStore {
  const records = new Map<string, ReportRunRecord>(seed.map((record) => [record.id, cloneRecord(record)]));

  return {
    async create(record) {
      const stored = cloneRecord(record);
      records.set(stored.id, stored);
      return cloneRecord(stored);
    },

    async update(id, patch) {
      const current = records.get(id);
      if (!current) return undefined;

      const next: ReportRunRecord = {
        ...current,
        ...patch,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      };
      records.set(id, next);
      return cloneRecord(next);
    },

    async get(id) {
      const record = records.get(id);
      return record ? cloneRecord(record) : undefined;
    },

    async list(limit = 50) {
      const clampedLimit = Math.max(0, limit);
      return Array.from(records.values())
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, clampedLimit)
        .map((record) => cloneRecord(record));
    },
  };
}
