import { describe, expect, it } from "vitest";
import { clearBlockedStatusOnly } from "../scheduler.js";

/*
FNXC:DependencyUnblock 2026-08-10-08:20:
Dependency auto-unblock owns exactly one status value — the `queued` blocked marker it writes itself. Both of
its call sites used to write `status: null` unconditionally, so completing a blocker silently erased whatever
else was on the shared lifecycle channel.

FN-8923 is what that costs: a `needs-replan` set by a planning routing hold was nulled when its blocker
finished, and `needs-replan` is the ONLY signal that re-admits a hold-column card whose PROMPT.md is already a
real spec. The card went unowned by triage and the executor alike and sat silent for 7+ hours.

The invariant is asserted over every status this channel actually carries, not just the reported one — a
repro-only test would have passed while `planning`, `awaiting-approval`, and the rest stayed erasable.
*/
describe("clearBlockedStatusOnly", () => {
  it("clears only the blocked marker it owns", () => {
    expect(clearBlockedStatusOnly({ status: "queued" } as never)).toEqual({ status: null });
    expect(clearBlockedStatusOnly({ status: null } as never)).toEqual({ status: null });
    expect(clearBlockedStatusOnly({} as never)).toEqual({ status: null });
  });

  it("never erases another lane's lifecycle signal", () => {
    for (const status of ["needs-replan", "planning", "awaiting-approval", "failed", "stuck-killed", "plan-review-unavailable"]) {
      expect(clearBlockedStatusOnly({ status } as never)).toEqual({});
    }
  });
});
