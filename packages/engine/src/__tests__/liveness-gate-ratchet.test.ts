import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/*
FNXC:NodeWorktreeIsolation 2026-07-29-07:10 (FN-6756 — make the fourth door a CI failure):
RATCHET for the "is an agent working this task?" gate.

This bug reached users THREE times, each time as the same mistake in a new place:

  FN-8600  the self-owned-branch reclaim sweep removed a worktree a live PLANNER was
           using. Fixed by registering planning paths in activeSessionRegistry and
           teaching THAT sweep to consult isPathActive.
  FN-6756  the leaked-slot reaper never got the same signal. Its last-line-of-defense,
           clearPhantomExecutorBinding, computed liveness from four TaskExecutor-owned
           maps, so a triage planner — owned by TriageProcessor — matched none of them.
  (same)   fixing that was not enough either: recoverPausedAbortFailures DISCARDED the
           refusal and still logged "Auto-recovered…", emitted its audit and counted
           the task, so it did the whole bug again while reporting success.

The shared cause is not any one sweep. It is that "liveness" was RE-DERIVED at each
call site, so closing one door left the next one open and no test failed. These
assertions encode the three properties that keep the doors shut, and each is written
to fail on the exact defect that got through before — see the revert-proof notes in
PR #2531.

Grep-level and comment-stripped, per the existing tombstone ratchet: no engine boot,
no fixtures (FN-5048 — do not add slow tests). Production source only.
*/

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

function readSource(relPath: string): string {
  const source = readFileSync(join(REPO_ROOT, relPath), "utf8");
  // FAIL CLOSED: a moved/emptied file must not silently pass every assertion below.
  expect(source.length, `${relPath} is empty or unreadable — the ratchet checked nothing`).toBeGreaterThan(1000);
  return source;
}

/** Strip comments so an explanatory FNXC note naming a pattern is not read as the pattern. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SELF_HEALING = "packages/engine/src/self-healing.ts";
const EXECUTOR = "packages/engine/src/executor.ts";
const IN_PROCESS_RUNTIME = "packages/engine/src/runtimes/in-process-runtime.ts";

describe("FN-6756 liveness-gate ratchet", () => {
  /*
  PROPERTY 1 — every clearPhantomExecutorBinding call site CONSUMES its return value.

  The defect: `recoverPausedAbortFailures` called it bare and threw the boolean away,
  so the refusal that the other two callers treat as a stop signal did nothing, and a
  live planner lost its worktree while the sweep reported a clean recovery.

  A bare call is the signature of that mistake: the method's entire contract is that
  `false` means "refused, do not proceed". Consuming it is `const x = …` or a direct
  comparison; anything else is discarding a safety signal.
  */
  it("every clearPhantomExecutorBinding call site consumes the return value", () => {
    const source = stripComments(readSource(SELF_HEALING));
    const callSites = source
      .split("\n")
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => line.includes("clearPhantomExecutorBinding?.("));

    expect(callSites.length, "no call sites found — the ratchet is scanning the wrong thing").toBeGreaterThan(0);

    /*
    A call site CONSUMES the result when the call is not a bare expression statement:
    it is bound (`const x = …`) or evaluated in a condition/return. A bare statement —
    optionally prefixed with `void`/`await`, which discard just as thoroughly — is the
    exact shape of the defect.
    */
    const discarded = callSites.filter(({ line }) =>
      /^(void\s+|await\s+)*this\.options\.clearPhantomExecutorBinding\?\.\(/.test(line),
    );

    expect(
      discarded.map(({ lineNumber, line }) => `${SELF_HEALING}:${lineNumber} ${line}`),
      "a clearPhantomExecutorBinding call discards its return value — `false` means the release was REFUSED because an agent is live, and ignoring it is how FN-6756 pulled a worktree from under a running planner while logging success",
    ).toEqual([]);
  });

  /*
  PROPERTY 2 — the destructive path does not RE-DERIVE liveness.

  `clearPhantomExecutorBinding` must delegate to `hasLiveSessionSurface` rather than
  inlining the session-map disjunction again. A probe that can disagree with the guard
  it stands in for is worse than no probe: callers would gate on one answer and the
  release would act on another, which is precisely the drift that let each successive
  sweep be "fixed" without fixing the next.
  */
  it("clearPhantomExecutorBinding delegates to the shared hasLiveSessionSurface probe", () => {
    const source = stripComments(readSource(EXECUTOR));
    const start = source.indexOf("clearPhantomExecutorBinding(taskId: string");
    expect(start, "clearPhantomExecutorBinding not found in executor source").toBeGreaterThan(-1);
    const body = source.slice(start, start + 1200);

    expect(
      body.includes("this.hasLiveSessionSurface(taskId)"),
      "clearPhantomExecutorBinding must call the shared hasLiveSessionSurface probe, not re-derive liveness inline — a second copy can drift from the one callers gate on",
    ).toBe(true);

    expect(
      /activeStepExecutors\.has|activeWorkflowStepSessions\.has|activeCliTaskSessions\.has/.test(body),
      "the session-map disjunction is inlined here again; it belongs only in hasLiveSessionSurface",
    ).toBe(false);
  });

  /*
  PROPERTY 3 — the probe is WIRED into the runtime.

  self-healing.ts records that `releaseExecutorWorktreeOwnership` was a
  declared-but-never-wired option that silently no-opped. An unwired liveness probe is
  strictly worse: `this.options.hasLiveSessionSurface?.(id) === true` is FALSE when
  unwired, so every gate depending on it would quietly stop deferring for live
  sessions and the FN-6756 fix would evaporate with no test failing.
  */
  it("hasLiveSessionSurface is wired from the runtime to the self-healing options", () => {
    expect(
      /hasLiveSessionSurface:\s*\(/.test(stripComments(readSource(IN_PROCESS_RUNTIME))),
      "hasLiveSessionSurface is not wired in in-process-runtime — an unwired probe reads as `false` and silently disables every liveness gate that consumes it",
    ).toBe(true);

    const selfHealing = stripComments(readSource(SELF_HEALING));
    expect(
      selfHealing.includes("hasLiveSessionSurface?:"),
      "the self-healing option declaration is gone",
    ).toBe(true);
    expect(
      selfHealing.includes("this.options.hasLiveSessionSurface?.("),
      "no self-healing sweep consults the liveness probe — FN-6756's pre-mutation gate is gone",
    ).toBe(true);
  });

  /*
  PROPERTY 4 — the registry is part of the liveness answer.

  A triage PLANNING session appears in NONE of the executor-owned maps; it registers
  in the module-level activeSessionRegistry. Dropping the registry term from the probe
  restores the exact blind spot FN-8600 and FN-6756 both went through.
  */
  it("hasLiveSessionSurface counts registered session paths, not just executor maps", () => {
    const source = stripComments(readSource(EXECUTOR));
    const start = source.indexOf("hasLiveSessionSurface(taskId: string): boolean");
    expect(start, "hasLiveSessionSurface not found — the probe was removed or renamed").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n  }", start));

    expect(
      body.includes("activeSessionRegistry.pathsForTask(taskId)"),
      "hasLiveSessionSurface no longer consults activeSessionRegistry — a triage planner is owned by TriageProcessor and appears in NO executor-owned map, so this term is the only thing that sees it",
    ).toBe(true);
  });
});
