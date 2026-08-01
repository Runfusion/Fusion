/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:45:
IS `archived` ALREADY A NON-RENAMEABLE SYSTEM COLUMN? NO — AND THE DOC COMMENT READS AS IF IT IS.

`archived-column-gate-parity.test.ts` offers two ways to close its three-encoding split: convert all
three encodings, or "declare `archived` a non-renameable system column and mark the sites deliberate".
The second option is far cheaper, and the codebase looks like it has already been taken:

    "Globally archived; hidden from the board. RESTRICTED (built-in only)."
    archived?: boolean;                                    // trait-types.ts

Read at a glance, "RESTRICTED (built-in only)" says a custom board cannot have an archive lane of its
own — which would make every `archived` literal correct by construction and the whole family
DELIBERATE rather than debt.

That reading is wrong, and the two meanings point to opposite decisions. The restriction is on which
traits may DECLARE the flag: `trait-registry.ts` rejects a NON-BUILTIN (plugin-defined) trait that
declares `archived` or `complete` (R22). It says nothing about which COLUMN may carry the built-in
`archived` trait, and a custom workflow may put it on a column with any id.

Proved below rather than argued, because the distinction is invisible in the comment and a reviewer
who takes the cheap option on the strength of it would be REMOVING a capability that exists today —
silently breaking any board that already renamed its archive lane — while believing they were
documenting a constraint that was already there.

This file does not argue for either option. It removes one wrong reason for choosing between them.
*/

import { describe, expect, it } from "vitest";
import { columnsWithFlag, resolveColumnFlags } from "../index.js";
import { RESTRICTED_TRAIT_FLAGS } from "../trait-types.js";
import "../builtin-traits.js";

/** A custom workflow whose archive lane is `filed` and whose complete lane is `shipped`. */
const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    { id: "filed", name: "Filed", traits: [{ trait: "archived" }] },
  ],
};

describe("`archived` is a renameable lane today, whatever the flag comment suggests", () => {
  it("resolves a custom workflow's renamed archive lane", () => {
    /* If this ever returns [] or ["archived"], the cheap option has effectively been taken and the
       parity test's framing should be revisited — that is the signal this case exists to give. */
    expect(columnsWithFlag(RENAMED_IR as never, "archived")).toEqual(["filed"]);
  });

  it("gives that column the archived trait flags, so every role helper treats it as the archive lane", () => {
    const flags = resolveColumnFlags({ id: "filed", name: "Filed", traits: [{ trait: "archived" }] } as never);

    expect(flags.archived).toBe(true);
    /* Carried with it, and worth pinning: the renamed lane is hidden from the board like the legacy
       one, so a board that renames it does not gain a visible extra column by accident. */
    expect(flags.hiddenFromBoard).toBe(true);
  });

  it("the same is true of `complete`, the other restricted flag", () => {
    /* Both restricted flags behave identically, so the misreading is not specific to `archived` —
       anyone reaching the same conclusion about `complete` would be wrong for the same reason. */
    expect(columnsWithFlag(RENAMED_IR as never, "complete")).toEqual(["shipped"]);
  });

  /*
  What the restriction ACTUALLY constrains, pinned so the correction cannot drift from the mechanism
  it corrects. `RESTRICTED_TRAIT_FLAGS` is consumed by the trait REGISTRY when a trait is registered,
  not by workflow validation when a column is declared.
  */
  it("the restriction is over trait REGISTRATION, not column naming", () => {
    expect([...RESTRICTED_TRAIT_FLAGS]).toEqual(["complete", "archived"]);
  });
});
