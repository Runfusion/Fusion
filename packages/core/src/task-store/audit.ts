/**
 * Audit / activity-log / run-audit responsibility area.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Responsibility boundary for audit events, the activity log, and run-audit
 * events. The logic currently lives in the TaskStore class body
 * (appendRunAuditEvent, queryRunAuditEvents, activity-log listeners).
 * This module documents the boundary; U14 will migrate these call sites.
 */
export type {
  ActivityLogEntry,
  ActivityEventType,
  RunAuditEvent,
  RunAuditEventInput,
  RunAuditEventFilter,
} from "../types.js";

export type {
  RunAuditEventRow,
  ActivityLogRow,
} from "./row-types.js";

export {
  compactTaskActivityLog,
  truncateTaskLogOutcome,
  __setTaskActivityLogLimitsForTesting,
  getTaskActivityLogEntryLimit,
} from "./comments.js";
