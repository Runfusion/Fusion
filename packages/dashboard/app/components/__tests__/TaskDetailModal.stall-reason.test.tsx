/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
The detail view is the one surface that must answer "why isn't this card moving?" for a PAUSED card
independent of its column — every pre-existing banner there (failure alert, ExternalBlockNotice, the
review-lane stall banners) is keyed to a specific column or state, so a paused todo-column card showed
nothing. These tests pin the new generic stall banner: it names the reason for the codes the shared
face-visibility predicate assigns to the detail, and it stays silent wherever a dedicated affordance
already owns the code (failed -> failure alert, external-block -> notice, a flowing card -> nothing).
*/
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Match the rendering suite: keep the shared markdown pipeline's MermaidDiagram resolvable.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mock-mermaid-svg'></svg>" }),
  },
}));

import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailContent } from "../TaskDetailModal";
import type { Task } from "@fusion/core";

setupTaskDetailModalHooks();

function renderDetail(task: Task) {
  return render(
    <TaskDetailContent
      embedded
      active
      task={task}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      addToast={noop}
    />,
  );
}

describe("TaskDetailModal generic stall banner", () => {
  it("names a paused card's reason with no column dependency (symptom b/d)", () => {
    renderDetail(
      makeTask({ id: "FN-PAUSE", column: "todo", status: "paused", paused: true, pausedReason: "heartbeat-unresponsive" }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-PAUSE");
    expect(banner).toHaveTextContent("Heartbeat unresponsive");
    expect(banner.getAttribute("data-stall-code")).toBe("engine-paused");
  });

  it("explains a dependency block on the detail face (headline + action)", () => {
    renderDetail(
      makeTask({ id: "FN-DEP", column: "in-progress", status: "queued", blockedBy: "FN-BLOCK" }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-DEP");
    expect(banner).toHaveTextContent("Waiting on dependency FN-BLOCK");
    expect(banner.getAttribute("data-stall-code")).toBe("dependency-block");
  });

  it("stays silent for a plain resting card (undefined stall)", () => {
    renderDetail(makeTask({ id: "FN-FLOW", column: "todo", status: "pending" }));
    expect(screen.queryByTestId("task-detail-stall-reason-FN-FLOW")).toBeNull();
  });

  it("defers to the failure alert for a failed card instead of stacking a generic banner", () => {
    renderDetail(
      makeTask({ id: "FN-FAIL", column: "in-progress", status: "failed", error: "compile failed" }),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("task-detail-stall-reason-FN-FAIL")).toBeNull();
  });

  it("defers to the ExternalBlockNotice for an externally blocked card", () => {
    const task = makeTask({
      id: "FN-BLK",
      column: "in-progress",
      status: "blocked",
      paused: true,
      pausedReason: "external-block",
      externalBlock: {
        origin: "credentials",
        code: "AUTH_REQUIRED",
        message: "credentials expired",
        source: "session-failure",
        blockedAt: "2026-08-28T00:00:00.000Z",
        resume: { column: "in-progress", currentStep: 0 },
      },
    }) as Task;
    renderDetail(task);
    // The shared notice owns this code; the generic banner must not coexist with it.
    expect(screen.getByTestId("external-block-detail-FN-BLK")).toBeInTheDocument();
    expect(screen.queryByTestId("task-detail-stall-reason-FN-BLK")).toBeNull();
  });

  /*
  FNXC:StallReason 2026-09-02-18:21 (RUFU-175 review):
  Same complete-lane suppression the card and list rows already apply: landing proof ignores `paused`,
  so a done card can be opened still carrying a stale park, an unresolved dependency edge, or an active
  wedge. The detail view must not advertise a stall with a "resume" suggestion on a completed card, so
  the generic banner follows `isDoneColumn`. Each case keeps a matching non-complete control below to
  prove the gate is what suppresses the banner, not that the field never produces one.
  */
  it.each([
    ["a stale pause", { status: "paused", paused: true, pausedReason: "budget-exhausted" }],
    ["an unresolved dependency edge", { status: "queued", blockedBy: "FN-BLOCK" }],
    ["an active wedge", { status: "in-progress", wedgeNotification: { reasonKey: "pending-wedge", episodeId: "e1", status: "active", transitionedAt: "2026-09-01T00:00:00.000Z" } }],
  ] as const)("suppresses the generic banner on a landed card carrying %s", (_label, staleField) => {
    renderDetail(makeTask({ id: "FN-LANDED", column: "done", ...staleField }));
    expect(screen.queryByTestId("task-detail-stall-reason-FN-LANDED")).toBeNull();
  });

  it.each([
    ["a paused card", { status: "paused", paused: true, pausedReason: "budget-exhausted" }, "Output budget exhausted"],
    ["a dependency wait", { status: "queued", blockedBy: "FN-BLOCK" }, "Waiting on dependency FN-BLOCK"],
    ["a wedge hold", { status: "in-progress", wedgeNotification: { reasonKey: "pending-wedge", episodeId: "e1", status: "active", transitionedAt: "2026-09-01T00:00:00.000Z" } }, null],
  ] as const)("still names the reason for %s in a non-complete lane", (_label, staleField, text) => {
    renderDetail(makeTask({ id: "FN-LIVE", column: "todo", ...staleField }));
    const banner = screen.getByTestId("task-detail-stall-reason-FN-LIVE");
    if (text) expect(banner).toHaveTextContent(text);
  });
});

/*
FNXC:StallReason 2026-09-02-22:53 (RUFU-177):
The server-derived stallReason reaches the detail banner: a server merge-blocker rides its own
sentence in the description row (badge/headline/suggestedAction stay localized catalog copy), while
held-human-review -- an ordinary human-hold wait -- is visible only here (detail-only code) and must
never claim "merge is blocked". pre-merge-gate-pending legitimately shares the merge-blocker copy:
an unrun gate does block the merge.
*/
describe("TaskDetailModal server-backed stallReason", () => {
  const observedAt = "2026-09-02T00:00:00.000Z";

  it("names the server's merge-blocker and rides the server sentence as description", () => {
    renderDetail(
      makeTask({
        id: "FN-SMRG",
        column: "in-review",
        status: "in-progress",
        stallReason: { code: "merge-blocker", reason: "verification refused: pnpm test", observedAt },
      }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-SMRG");
    expect(banner.getAttribute("data-stall-code")).toBe("merge-blocker");
    expect(banner).toHaveTextContent("Merge is blocked");
    expect(banner.querySelector(".task-stall-reason-description")?.textContent).toBe("verification refused: pnpm test");
  });

  it("names held-human-review as a person wait, never as merge blocked", () => {
    renderDetail(
      makeTask({
        id: "FN-SHELD",
        column: "awaiting-user-review",
        status: "in-progress",
        stallReason: { code: "held-human-review", reason: "waiting for operator approval", observedAt },
      }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-SHELD");
    expect(banner.getAttribute("data-stall-code")).toBe("held-human-review");
    expect(banner).toHaveTextContent("Waiting on a person");
    expect(banner.textContent).not.toMatch(/merge (is )?blocked/i);
  });

  it("surfaces pre-merge-gate-pending in detail, sharing the merge-blocker copy", () => {
    renderDetail(
      makeTask({
        id: "FN-SGATE",
        column: "in-review",
        status: "in-progress",
        stallReason: { code: "pre-merge-gate-pending", reason: "code-review has not run", observedAt },
      }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-SGATE");
    expect(banner.getAttribute("data-stall-code")).toBe("pre-merge-gate-pending");
    expect(banner).toHaveTextContent("Merge is blocked");
    expect(banner.querySelector(".task-stall-reason-description")?.textContent).toBe("code-review has not run");
  });

  /*
  FNXC:ReviewRevisionWait 2026-09-30-07:19 (RUFU-280 code-review remediation, P2):
  A badge suppression is not a visibility suppression: `awaiting-review-revision` is quiet on the board
  face because a revision in flight is not abnormal, but the detail banner still owns the sentence, and
  it must say "applying review corrections" rather than reuse the merge-blocker copy. That mislabel was
  the original RUFU-280 symptom - the card told the operator the merge was refused while the engine was
  executing its own remediation - so the negative assertion here is the one that matters.
  */
  it("names awaiting-review-revision as work in progress, never as a refused merge", () => {
    renderDetail(
      makeTask({
        id: "FN-SREV",
        column: "in-review",
        status: "in-progress",
        stallReason: { code: "awaiting-review-revision", reason: "Working through review corrections: unfinished remediation steps", observedAt },
      }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-SREV");
    expect(banner.getAttribute("data-stall-code")).toBe("awaiting-review-revision");
    expect(banner).toHaveTextContent("Applying review corrections");
    // Unlike `merge-blocker`, this code rides its OWN catalog copy rather than the server sentence:
    // the server words name a gate, while the operator needs to know whose work it is. Pinning the
    // shipped catalog sentence is what proves the resolver reached this code's copy group.
    expect(banner.querySelector(".task-stall-reason-description")?.textContent).toContain("The latest review asked for changes");
    expect(banner.textContent).not.toMatch(/merge (is )?blocked/i);
  });
});

/*
FNXC:PlanningAdmissionStall 2026-09-25-21:17 (RUFU-273):
The detail banner is where an aged planning card finally answers "why isn't this card being planned?".
Each of the seven planning codes must render ITS OWN copy group — headline, description, and a concrete
next step — and must keep the server's code verbatim, because seven codes collapsing into one sentence is
the exact symptom this feature removes. Unlike `merge-blocker`, a planning code's description row is the
catalog description, not the server's sentence: every planning code has complete localized copy, so
nothing untranslatable reaches the screen. `recoverable-work` is the one code whose subject is branch
work, so it is allowed branch wording while still never reading as a delivery failure. A landed card
shows none of them, matching the card and list surfaces.

The no-failure-language guard is scoped to the headline, not the whole banner: `plan-recovery-backoff`'s
description honestly reports that planning failed earlier, which is the reason for the scheduled retry —
naming that in prose is information, while headlining it would mislabel a wait as a fault.
*/
describe("TaskDetailModal planning-admission stallReason", () => {
  const observedAt = "2026-09-25T00:00:00.000Z";

  it.each([
    ["plan-admission-throttled", "Waiting for a planner slot"],
    ["plan-lane-ineligible", "This lane does not plan cards automatically"],
    ["plan-premise-held", "Planning is held by a rejected plan"],
    ["plan-spec-unreadable", "The written plan cannot be read"],
    ["plan-recovery-backoff", "Waiting out a scheduled retry"],
    ["plan-no-admission", "Planning has not started, and no gate refuses it"],
    ["recoverable-work", "This card's branch holds commits that are not merged"],
  ] as const)("names planning stall %s with its own headline, description, and next step", (code, headline) => {
    const id = `FN-PLAN-${code.toUpperCase()}`;
    renderDetail(
      makeTask({
        id,
        column: "hold",
        status: "pending",
        stallReason: { code, reason: `engine sentence for ${code}`, observedAt },
      }),
    );
    const banner = screen.getByTestId(`task-detail-stall-reason-${id}`);
    expect(banner.getAttribute("data-stall-code")).toBe(code);
    expect(banner).toHaveTextContent(headline);
    const description = banner.querySelector(".task-stall-reason-description")?.textContent ?? "";
    expect(description.trim().length).toBeGreaterThan(0);
    expect(description).not.toContain(`engine sentence for ${code}`);
    // A planning stall always leaves the operator a concrete next step, never a bare fault.
    expect(banner.querySelector(".task-stall-reason-action")?.textContent?.trim().length).toBeGreaterThan(0);
    /*
    The no-failure-language guard binds the HEADLINE — the glance surface — not the description, which
    legitimately says "planning failed earlier" for `plan-recovery-backoff`. A planning stall is a wait
    with a next step, so it must never be headlined as a failure.
    */
    expect(banner.querySelector(".task-stall-reason-headline")?.textContent).not.toMatch(/\bfail(ed)?\b/i);
  });

  it("names unmerged branch work without reading as a delivery failure", () => {
    renderDetail(
      makeTask({
        id: "FN-PLANWORK",
        column: "hold",
        status: "pending",
        stallReason: { code: "recoverable-work", reason: "2 unique commits on fusion/RUFU-000", observedAt },
      }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-PLANWORK");
    expect(banner).toHaveTextContent("This card's branch holds commits that are not merged");
    expect(banner.textContent).not.toMatch(/\bblocked\b/i);
  });

  it("shows no planning stall banner on a landed card", () => {
    renderDetail(
      makeTask({
        id: "FN-PLANDONE",
        column: "done",
        status: "done",
        stallReason: { code: "plan-no-admission", reason: "stale episode on a landed row", observedAt },
      }),
    );
    expect(screen.queryByTestId("task-detail-stall-reason-FN-PLANDONE")).toBeNull();
  });
});

/*
FNXC:WipAdmissionPark 2026-11-02-08:39 (RUFU-393):
The detail banner is where a card refused at its hold->WIP crossing has to explain itself. Measured on the
board this task fixes, one card was refused 16 536 times over 2 d 19 h and its detail view said nothing,
because the refusal changed no observable field. Like the planning family, the copy carries the ELAPSED
WAIT (the number core measures from the episode's own `firstAt`), states that a gate is withholding a
crossing rather than that something failed, and leaves the operator a concrete lever — the column's limit
or its occupants. With no age on the row it headlines the wait without inventing one.
*/
describe("TaskDetailModal wip-admission stallReason", () => {
  it("names a withheld hold->WIP crossing with its elapsed wait, description, and next step", () => {
    const waitedMs = (2 * 24 * 60 + 19 * 60) * 60 * 1000; // 2 d 19 h, the measured RUFU-393 wait
    renderDetail(
      makeTask({
        id: "FN-WIPDETAIL",
        column: "todo",
        status: "pending",
        stallReason: {
          code: "wip-admission-throttled",
          reason: "engine sentence for wip-admission-throttled",
          observedAt: "2026-11-02T00:00:00.000Z",
          waitedMs,
        },
      }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-WIPDETAIL");
    expect(banner.getAttribute("data-stall-code")).toBe("wip-admission-throttled");
    expect(banner).toHaveTextContent("Waiting for a work-in-progress slot (2 d 19 h)");
    const description = banner.querySelector(".task-stall-reason-description")?.textContent ?? "";
    expect(description.trim().length).toBeGreaterThan(0);
    // Localized catalog copy, not the engine's sentence — the same rule the planning family follows.
    expect(description).not.toContain("engine sentence for");
    expect(banner.querySelector(".task-stall-reason-action")?.textContent?.trim().length).toBeGreaterThan(0);
    expect(banner.querySelector(".task-stall-reason-headline")?.textContent).not.toMatch(/\bfail(ed)?\b/i);
  });

  it("headlines the wait without an invented age when the server carries none", () => {
    renderDetail(
      makeTask({
        id: "FN-WIPNOAGE",
        column: "todo",
        status: "pending",
        stallReason: {
          code: "wip-admission-throttled",
          reason: "engine sentence for wip-admission-throttled",
          observedAt: "2026-11-02T00:00:00.000Z",
        },
      }),
    );
    const banner = screen.getByTestId("task-detail-stall-reason-FN-WIPNOAGE");
    expect(banner).toHaveTextContent("Waiting for a work-in-progress slot");
    expect(banner.querySelector(".task-stall-reason-headline")?.textContent).not.toMatch(/\(\s*\)/);
  });

  it("shows no WIP-admission banner on a landed card", () => {
    renderDetail(
      makeTask({
        id: "FN-WIPDONE",
        column: "done",
        status: "done",
        stallReason: {
          code: "wip-admission-throttled",
          reason: "stale episode on a landed row",
          observedAt: "2026-11-02T00:00:00.000Z",
        },
      }),
    );
    expect(screen.queryByTestId("task-detail-stall-reason-FN-WIPDONE")).toBeNull();
  });
});
