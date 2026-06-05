import type { ColumnId } from "@fusion/core";

export type NotificationReason = "entered-column" | "new-task" | "left-column" | "completed";

export interface NotificationEvent {
  taskId: string;
  reason: NotificationReason;
  column: ColumnId;
  previousColumn: ColumnId | null;
  updatedAt: string;
}

export interface SnapshotRow {
  taskId: string;
  lastColumn: ColumnId;
  updatedAt: string;
}

export type Snapshot = ReadonlyMap<string, SnapshotRow>;
