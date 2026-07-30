/*
FNXC:WorkflowLifecycleColumns 2026-07-30-12:25 (Phase C convergence — DocumentsView.tsx):

The task-documents status dot encodes four LIFECYCLE ROLES: complete, archived,
pre-implementation (waiting), and everything else (working). Only the pre-implementation arm
named columns — and it named the default lineage's two — so on a renamed board a queued card
showed the "working" dot.

Both halves are pinned here because either alone is misleading: flags must DECIDE when present
(otherwise the conversion is decoration), and the legacy names must still answer when flags are
ABSENT (the documents list spans archived and historical tasks whose columns are not on the
current board, and "not pre-implementation" would be as much a guess as the legacy pair — the
same no-basis rule as `live-agent-count.ts`).
*/
import { describe, expect, it } from "vitest";

import { getTaskColumnStatusDotClass } from "../components/DocumentsView";

const PENDING = "status-dot status-dot--pending";
const WORKING = "status-dot status-dot--connecting";
const DONE = "status-dot status-dot--online";
const ARCHIVED = "status-dot status-dot--offline";

describe("the documents status dot resolves lifecycle roles when traits are available", () => {
  it("shows the waiting dot for a RENAMED planning column via its traits", () => {
    // Pre-fix: `backlog` matched neither literal, so a queued card read as working.
    expect(getTaskColumnStatusDotClass("backlog", { intake: true })).toBe(PENDING);
    expect(getTaskColumnStatusDotClass("queued", { hold: true })).toBe(PENDING);
  });

  it("shows the working dot for a renamed WIP column", () => {
    expect(getTaskColumnStatusDotClass("building", {})).toBe(WORKING);
  });

  it("prefers archived over complete when a column carries both", () => {
    // Order matters: an archived-and-complete column is archived to an operator scanning dots.
    expect(getTaskColumnStatusDotClass("shipped", { archived: true, complete: true })).toBe(ARCHIVED);
    expect(getTaskColumnStatusDotClass("shipped", { complete: true })).toBe(DONE);
  });

  it("lets traits OVERRIDE a legacy name in both directions", () => {
    // A board that declares `todo` as its complete column: traits win, not the name.
    expect(getTaskColumnStatusDotClass("todo", { complete: true })).toBe(DONE);
    // And a board that declares `done` as intake.
    expect(getTaskColumnStatusDotClass("done", { intake: true })).toBe(PENDING);
  });
});

describe("with no traits the documented legacy names still answer", () => {
  it("keeps the pre-U11 planner ids on the waiting dot", () => {
    expect(getTaskColumnStatusDotClass("todo")).toBe(PENDING);
    expect(getTaskColumnStatusDotClass("triage")).toBe(PENDING);
  });

  it("keeps done and archived", () => {
    expect(getTaskColumnStatusDotClass("done")).toBe(DONE);
    expect(getTaskColumnStatusDotClass("archived")).toBe(ARCHIVED);
  });

  it("does NOT invent a role for a renamed column with no traits", () => {
    // The known, documented gap: unchanged behavior, not a guess. Supplying flags is the fix.
    expect(getTaskColumnStatusDotClass("backlog")).toBe(WORKING);
  });
});
