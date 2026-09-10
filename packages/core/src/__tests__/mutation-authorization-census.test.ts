/*
FNXC:IdentityStoreMutations 2026-08-09-03:04:
U5/R17 — the mutation-authorization census.

Purpose: make "a new gated mutation shipped with no permission" a CI failure instead of a silent
allow. Without it the map rots in the one direction nobody notices, because a missing entry does not
throw anywhere — the method simply is not authorized, and the system looks like it works.

This suite deliberately asserts the census MECHANISM as well as its current result. A census that
cannot fail is a rubber stamp, and the failure mode is invisible: it reports "0 unmapped" whether
the map is complete or the scan is broken.
*/

import { describe, expect, it } from "vitest";
import {
  assertEveryGatedMutationIsMapped,
  NON_MUTATING_GATED_MEMBERS,
  TASK_STORE_MUTATION_PERMISSIONS,
} from "../identity/store-mutation-permissions.js";
import {
  PLUGIN_ALLOWED_WRITE_METHODS,
  PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS,
  PLUGIN_READ_SHAPED_WRITE_METHODS,
} from "../plugin-task-store-gate.js";
import { isCatalogPermission } from "../identity/permissions.js";

describe("mutation-authorization census", () => {
  it("maps every gated mutation to a permission", () => {
    expect(assertEveryGatedMutationIsMapped()).toEqual([]);
  });

  /*
  The control. If the census scanned nothing — wrong import, empty gate lists, a filter that excludes
  everything — the assertion above would still pass. This proves it actually inspects the gate lists,
  so "no unmapped mutations" means the map is complete rather than the scan being dead.
  */
  it("actually scans the gate lists rather than reporting an empty set", () => {
    const scanned = new Set([
      ...PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS,
      ...PLUGIN_ALLOWED_WRITE_METHODS,
      ...PLUGIN_READ_SHAPED_WRITE_METHODS,
    ]);
    for (const lifecycle of NON_MUTATING_GATED_MEMBERS) scanned.delete(lifecycle);

    expect(scanned.size).toBeGreaterThan(10);
    for (const method of scanned) {
      expect(TASK_STORE_MUTATION_PERMISSIONS[method]).toBeDefined();
    }
  });

  it("reports a gated mutation that has no permission", () => {
    // Simulates the real regression: a destructive method added to the gate without a map entry.
    const gated = new Set<string>([...PLUGIN_DESTRUCTIVE_TASK_STORE_METHODS, "purgeEverything"]);
    const unmapped = [...gated].filter((m) => TASK_STORE_MUTATION_PERMISSIONS[m] === undefined);
    expect(unmapped).toEqual(["purgeEverything"]);
  });

  /*
  A permission that is not in the catalog is worse than a missing one: `resolveHeldDisposition`
  deny-by-defaults on it forever, because no role can hold a permission that does not exist. That
  reads as "correctly locked down" and is why the census checks catalog membership, not just presence.
  */
  it("treats a permission outside the catalog as unmapped, not as valid", () => {
    expect(isCatalogPermission("tasks:obliterate")).toBe(false);
    for (const permission of Object.values(TASK_STORE_MUTATION_PERMISSIONS)) {
      expect(isCatalogPermission(permission)).toBe(true);
    }
  });

  it("does not require a permission to open or close a store handle", () => {
    // Lifecycle, not data: gating construction would fail an unauthenticated read path at connect.
    for (const lifecycle of NON_MUTATING_GATED_MEMBERS) {
      expect(TASK_STORE_MUTATION_PERMISSIONS[lifecycle]).toBeUndefined();
    }
  });

  /*
  Narrowest-true-permission rule. archive is reversible via unarchiveTask, so collapsing it into
  tasks:delete would force an operator to grant deletion authority to allow board hygiene — and
  bypassing a failed review gate is a distinct authority from merging.
  */
  it("keeps reversible and privileged operations on distinct permissions", () => {
    expect(TASK_STORE_MUTATION_PERMISSIONS.archiveTask).toBe("tasks:archive");
    expect(TASK_STORE_MUTATION_PERMISSIONS.deleteTask).toBe("tasks:delete");
    expect(TASK_STORE_MUTATION_PERMISSIONS.bypassFailedPreMergeReviewStep).toBe(
      "runtime:review-gate-bypass",
    );
    // A raw database handle is not a task permission — its blast radius is arbitrary SQL.
    expect(TASK_STORE_MUTATION_PERMISSIONS.getDatabase).toBe("runtime:file-write-delete");
  });
});
