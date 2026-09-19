/*
FNXC:IdentityStoreMutations 2026-08-09-03:04:
THE STORE-MUTATION PERMISSION MAP (U5, R15/R17).

Which catalog permission each gated `TaskStore` mutation requires. `assertAuthorized` answers "may
this actor do X"; this table is what supplies X at the store seam, so a mutation cannot be guarded
with whatever permission happened to be in scope at the call site.

SCOPE, STATED PLAINLY so this is not read as more than it is: `TaskStore` exposes ~299 methods, ~184
of them mutating. This table covers the surface the plugin gate already classifies — the destructive
methods and the writes plugins may perform — NOT all 184. That is a deliberate first tranche, not an
oversight, and {@link assertEveryGatedMutationIsMapped} is what keeps it honest: a method added to
either gate list without a permission here fails CI rather than silently defaulting to allow.

Two rules for extending it:
  1. A new destructive method needs an entry in the SAME commit that adds it to the gate list. The
     census exists to make that non-optional.
  2. Map to the narrowest permission that is true. `archiveTask` is `tasks:archive`, not
     `tasks:delete` — archive is reversible via `unarchiveTask`, and collapsing them would force an
     operator to grant deletion authority to allow board hygiene.
*/

import {
  PLUGIN_ALLOWED_WRITE_METHODS,
  PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS,
  PLUGIN_READ_SHAPED_WRITE_METHODS,
} from "../plugin-task-store-gate.js";
import { isCatalogPermission, type CatalogPermission } from "./permissions.js";

/**
 * FNXC:IdentityStoreMutations 2026-08-09-03:04:
 * Gated mutation -> required permission.
 *
 * `getDatabase` maps to `runtime:file-write-delete` rather than any `tasks:*` entry because it hands
 * out a raw handle whose blast radius is not tasks at all — it is arbitrary SQL. Mapping it to
 * `tasks:delete` would understate it and would let an actor with ordinary task-deletion authority
 * reach the whole database.
 *
 * `bypassFailedPreMergeReviewStep` maps to `runtime:review-gate-bypass`, its own entry, for the same
 * reason it is denylisted in the plugin gate: bypassing a failed review gate is a distinct authority
 * from merging, and an operator must be able to grant `tasks:merge` without granting it.
 *
 * `init`/`close` are deliberately ABSENT and excluded by the census below: they are lifecycle, not
 * data. Requiring a permission to open a store handle would gate the act of connecting rather than
 * any mutation, and would make an unauthenticated read path fail at construction.
 */
export const TASK_STORE_MUTATION_PERMISSIONS: Readonly<Record<string, CatalogPermission>> =
  Object.freeze({
    // Destructive (plugin gate additionally requires a manifest declaration).
    deleteTask: "tasks:delete",
    deleteTaskIf: "tasks:delete",
    deleteTaskById: "tasks:delete",
    deleteTaskBackend: "tasks:delete",
    archiveAllDone: "tasks:archive",
    cleanupArchivedTasks: "tasks:delete",
    bypassFailedPreMergeReviewStep: "runtime:review-gate-bypass",
    getDatabase: "runtime:file-write-delete",

    // Writes plugins may perform without a declaration.
    createTask: "tasks:create",
    updateTask: "runtime:task-agent-mutation",
    moveTask: "runtime:task-agent-mutation",
    archiveTask: "tasks:archive",
    unarchiveTask: "tasks:archive",
    updateSettings: "settings:update",

    // Read-prefix names that still mutate. Denied for plugins; mapped so authorization cannot skip them.
    selectTaskWorkflow: "runtime:task-agent-mutation",
    selectTaskWorkflowAndReconcile: "runtime:task-agent-mutation",
    resolveWorkspaceLandIntent: "tasks:merge",
    resolveOrphanedWorkspaceLandIntent: "tasks:merge",
  });

/**
 * FNXC:IdentityStoreMutations 2026-08-09-03:04:
 * Lifecycle members that are gate-listed but are not mutations. Kept as an explicit, named exclusion
 * rather than an implicit gap so the census cannot be quietly widened by adding entries here — an
 * addition to this list is as visible in review as a missing permission would be.
 */
export const NON_MUTATING_GATED_MEMBERS: readonly string[] = Object.freeze(["init", "close"]);

export interface UnmappedMutationReport {
  method: string;
  reason: "missing-permission" | "unknown-permission";
}

/**
 * FNXC:IdentityStoreMutations 2026-08-09-03:04:
 * The census (R17). Returns every gated mutation that has no permission, or whose permission is not
 * in the catalog — the second case matters because a typo'd or renamed permission is indistinguishable
 * from a real one at a call site, and `resolveHeldDisposition` would deny-by-default forever on a
 * permission no role can ever hold, which reads as "correctly locked down" rather than as a bug.
 *
 * Exported as a function rather than asserted inline so the same check is reusable by a lint script
 * or a startup self-check, not only by the test that currently calls it.
 */
export function assertEveryGatedMutationIsMapped(): UnmappedMutationReport[] {
  const gated = new Set<string>([
    ...PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS,
    ...PLUGIN_ALLOWED_WRITE_METHODS,
    ...PLUGIN_READ_SHAPED_WRITE_METHODS,
  ]);
  for (const member of NON_MUTATING_GATED_MEMBERS) gated.delete(member);

  const unmapped: UnmappedMutationReport[] = [];
  for (const method of [...gated].sort()) {
    const permission = TASK_STORE_MUTATION_PERMISSIONS[method];
    if (permission === undefined) {
      unmapped.push({ method, reason: "missing-permission" });
      continue;
    }
    if (!isCatalogPermission(permission)) {
      unmapped.push({ method, reason: "unknown-permission" });
    }
  }
  return unmapped;
}
