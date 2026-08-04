/**
 * FNXC:CodeOrganization 2026-08-04-07:15:
 * Single side-effect import for TaskExecutor FNXC/doc hosts (U4) so executor.ts
 * does not spend a line per host module. isBackwardMoveOutOfPlanning body stays
 * on TaskExecutor for inert-sync-lane (2 guards).
 */
import "./is-backward-move-out-of-planning.js";
import "./task-executor-fields.js";
import "./facade-fnxc-pointers.js";
import "./executor-product-fnxc.js";
import "./executor-method-docs.js";

export {};
