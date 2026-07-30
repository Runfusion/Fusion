/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
Re-export only. The column-ROLE helpers are defined in `@fusion/core`
(`packages/core/src/column-roles.ts`) because the server side needs the same fallback —
live agent counting and comment gating ask the same question. Keeping a second copy here
would put the legacy-id guess in two places, which is the drift this conversion removes.

This shim exists so the ~8 dashboard call sites keep a local import path; delete it and
point them at `@fusion/core` if that ever stops being worth a file.
*/
export type { ColumnRoleFlags } from "@fusion/core";
export {
  isHoldColumnRole,
  isIntakeColumnRole,
  isPlannerLaneColumnRole,
  isPreExecutionHoldColumnRole,
  isPreImplementationColumnRole,
} from "@fusion/core";
