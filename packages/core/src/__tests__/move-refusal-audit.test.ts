import { describe, it, expect, vi } from "vitest";
import { recordCompleteColumnGateRefusal } from "../task-store/moves.js";
import {
  CompleteColumnGateEvidenceRejectionError,
  describeCompleteColumnGateFindings,
  type CompleteColumnGateFinding,
} from "../workflows/complete-column-gate-evidence.js";
import { makeTransitionRejection } from "../tasks/transition-types.js";
import type { MoveTaskOptions } from "../store.js";
import type { TaskStore } from "../store.js";

/*
FNXC:CompleteColumnGateEvidence 2026-10-11-20:10 (RUFU-406):
The refusal has two observability writes and one contract: the caller receives the typed
`CompleteColumnGateEvidenceRejectionError` whose message names the gates. RUFU-406 exists because a card
reached the terminal lane with NO evidence and NO trace, so a refusal must leave a row and a History line —
but FN-9175/FN-9177 make telemetry best-effort, so an absent, throwing, rejecting, or hanging sink must
never replace the refusal with its own failure, and a store without `logEntry` must not turn a 409-shaped
refusal into a TypeError. These cases pin both halves at the seam itself (no database needed), including
the closed metadata vocabulary: ids, columns, fixed enums, and counts only — never the refusal sentence,
gate prose, reviewer findings, or paths.
*/

function finding(
  gateId: string,
  lane: CompleteColumnGateFinding["lane"],
  state: CompleteColumnGateFinding["state"],
): CompleteColumnGateFinding {
  return { gateId, lane, state };
}

/*
The message is built by the shipped describer rather than hand-typed: the History line echoes this exact
string, so a test that wrote its own sentence would keep passing after the sentence drifted from the
product and the assertions would stop describing what a person on the card actually reads.
*/
function refusal(gateFindings: readonly CompleteColumnGateFinding[]): CompleteColumnGateEvidenceRejectionError {
  return new CompleteColumnGateEvidenceRejectionError(
    makeTransitionRejection(
      "gate-evidence-missing",
      "transition.rejected.gateEvidenceMissing",
      true,
      `Required workflow gate evidence is missing on FN-406 for ${gateFindings.map((finding) => finding.gateId).join(", ")}`,
    ),
    describeCompleteColumnGateFindings(gateFindings, { taskId: "FN-406", toColumn: "done" }),
    gateFindings,
  );
}

/** Minimal sink host: only the two surfaces the refusal actually touches. */
function fakeStore(overrides: Partial<{ recordRunAuditEvent: unknown; logEntry: unknown }> = {}): TaskStore {
  const events: Array<Record<string, unknown>> = [];
  const history: Array<{ taskId: string; message: string; kind: string }> = [];
  const store = {
    recordRunAuditEvent: (event: Record<string, unknown>) => {
      events.push(event);
      return Promise.resolve();
    },
    logEntry: (taskId: string, message: string, kind: string) => {
      history.push({ taskId, message, kind });
      return Promise.resolve();
    },
    ...overrides,
  } as unknown as TaskStore;
  return Object.assign(store, { __events: events, __history: history }) as TaskStore;
}

function emitted(store: TaskStore): Record<string, unknown> {
  const events = (store as unknown as { __events: Array<Record<string, unknown>> }).__events;
  expect(events).toHaveLength(1);
  return events[0]!;
}

function metadataOf(store: TaskStore): Record<string, unknown> {
  return emitted(store).metadata as Record<string, unknown>;
}

const findings = [finding("code-review", "pre-merge", "missing")];

describe("recordCompleteColumnGateRefusal", () => {
  it("records one bounded audit row plus one History line naming the gates", () => {
    const store = fakeStore();
    const error = refusal(findings);

    expect(() =>
      recordCompleteColumnGateRefusal(store, {
        taskId: "FN-406",
        toColumn: "done",
        options: { moveSource: "user", moveCallerSurface: "agent-cli" },
        error,
      }),
    ).not.toThrow();

    const event = emitted(store);
    expect(event.mutationType).toBe("task:move-refused-complete-column-gate-evidence");
    expect(event.agentId).toBe("task-store");
    expect(event.target).toBe("FN-406");

    const history = (store as unknown as { __history: Array<{ message: string; kind: string }> }).__history;
    expect(history).toHaveLength(1);
    // The card shows the operator exactly what the mover saw, including the remedy.
    expect(history[0]!.kind).toBe("refused");
    expect(history[0]!.message).toBe(error.message);
    expect(history[0]!.message).toContain("code-review");
    expect(history[0]!.message).toContain("bypass-review");
  });

  it("keeps metadata inside the closed ids/counts/enums vocabulary", () => {
    const store = fakeStore();
    recordCompleteColumnGateRefusal(store, {
      taskId: "FN-406",
      toColumn: "done",
      options: { moveSource: "user", moveCallerSurface: "operator-cli" },
      error: refusal(findings),
    });

    expect(metadataOf(store)).toEqual({
      rejectionCode: "gate-evidence-missing",
      toColumn: "done",
      moveSource: "user",
      moveCallerSurface: "operator-cli",
      gateCount: 1,
      gateFindings: ["pre-merge:code-review:missing"],
    });
  });

  it("never writes the refusal sentence, gate prose, or a path into the audit row", () => {
    const store = fakeStore();
    recordCompleteColumnGateRefusal(store, {
      taskId: "FN-406",
      toColumn: "done",
      options: { moveSource: "user", moveCallerSurface: "dashboard-http" },
      error: refusal([
        finding("code-review", "pre-merge", "not-approved"),
        finding("post-merge-verification", "post-merge", "unwaived-skip"),
      ]),
    });

    const serialized = JSON.stringify(metadataOf(store));
    for (const leaked of ["run the gate", "bypass-review", "A card may not enter", "/home/", "packages/"]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(serialized).not.toContain("transition.rejected");
  });

  it("attaches the caller session only when a marker actually proved one", () => {
    const withSession = fakeStore();
    recordCompleteColumnGateRefusal(withSession, {
      taskId: "FN-406",
      toColumn: "done",
      options: { moveSource: "user", moveCallerSurface: "agent-cli", moveCallerPrincipal: { sessionId: "sess-77" } },
      error: refusal(findings),
    });
    expect(metadataOf(withSession).callerSessionId).toBe("sess-77");

    const withoutSession = fakeStore();
    recordCompleteColumnGateRefusal(withoutSession, {
      taskId: "FN-406",
      toColumn: "done",
      options: { moveSource: "user", moveCallerSurface: "agent-cli", moveCallerPrincipal: {} },
      error: refusal(findings),
    });
    expect("callerSessionId" in metadataOf(withoutSession)).toBe(false);
  });

  it("labels an optionless store-direct move instead of guessing a human", () => {
    const store = fakeStore();
    recordCompleteColumnGateRefusal(store, {
      taskId: "FN-406",
      toColumn: "done",
      options: undefined,
      error: refusal(findings),
    });

    expect(metadataOf(store).moveSource).toBe("unset");
    expect(metadataOf(store).moveCallerSurface).toBe("store-direct");
  });

  it("counts every finding but caps the enumerated list at eight", () => {
    const store = fakeStore();
    const many = Array.from({ length: 12 }, (_, index) =>
      finding(`gate-${index}`, "pre-merge" as const, "missing" as const),
    );
    recordCompleteColumnGateRefusal(store, {
      taskId: "FN-406",
      toColumn: "done",
      options: { moveSource: "user", moveCallerSurface: "operator-cli" } satisfies MoveTaskOptions,
      error: refusal(many),
    });

    const metadata = metadataOf(store);
    expect(metadata.gateCount).toBe(12);
    expect(metadata.gateFindings).toHaveLength(8);
  });

  it("still refuses when the audit sink throws, rejects, hangs, or does not exist", () => {
    const hostileSinks: Array<[string, () => unknown]> = [
      ["throws synchronously", () => { throw new Error("sink exploded"); }],
      ["rejects", () => Promise.reject(new Error("sink down"))],
      ["never settles", () => new Promise(() => {})],
      ["is absent", undefined as unknown as () => unknown],
    ];

    for (const [label, recordRunAuditEvent] of hostileSinks) {
      const store = fakeStore({ recordRunAuditEvent });
      expect(
        () =>
          recordCompleteColumnGateRefusal(store, {
            taskId: "FN-406",
            toColumn: "done",
            options: { moveSource: "user", moveCallerSurface: "operator-cli" },
            error: refusal(findings),
          }),
        label,
      ).not.toThrow();
      // History line is still attempted for every sink shape, so the card is never silent.
      expect((store as unknown as { __history: unknown[] }).__history, label).toHaveLength(1);
    }
  });

  it("survives a store whose History writer is missing or throws synchronously", () => {
    const missing = fakeStore({ logEntry: undefined });
    expect(() =>
      recordCompleteColumnGateRefusal(missing, {
        taskId: "FN-406",
        toColumn: "done",
        options: { moveSource: "user", moveCallerSurface: "operator-cli" },
        error: refusal(findings),
      }),
    ).not.toThrow();
    expect(emitted(missing).mutationType).toBe("task:move-refused-complete-column-gate-evidence");

    const throwing = fakeStore({
      logEntry: () => {
        throw new Error("no history writer");
      },
    });
    expect(() =>
      recordCompleteColumnGateRefusal(throwing, {
        taskId: "FN-406",
        toColumn: "review",
        options: { moveSource: "user", moveCallerSurface: "operator-cli" },
        error: refusal(findings),
      }),
    ).not.toThrow();
    expect(emitted(throwing).target).toBe("FN-406");
  });

  it("does not await the sink, so a hanging audit adapter cannot delay the refusal", async () => {
    const slowSink = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.()),
    );
    const store = fakeStore({ recordRunAuditEvent: slowSink });
    const started = Date.now();

    recordCompleteColumnGateRefusal(store, {
      taskId: "FN-406",
      toColumn: "done",
      options: { moveSource: "user", moveCallerSurface: "operator-cli" },
      error: refusal(findings),
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(slowSink).toHaveBeenCalledTimes(1);
  });
});
