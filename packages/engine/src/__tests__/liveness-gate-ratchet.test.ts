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

function readSource(relPath: string, minLength = 1000): string {
  const source = readFileSync(join(REPO_ROOT, relPath), "utf8");
  // FAIL CLOSED: a moved/emptied file must not silently pass every assertion below.
  // Peeled U4 free functions can be short pure helpers; still require non-trivial content.
  expect(source.length, `${relPath} is empty or unreadable — the ratchet checked nothing`).toBeGreaterThan(minLength);
  return source;
}

/** Strip comments so an explanatory FNXC note naming a pattern is not read as the pattern. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}


/** Count call sites of `name`, regardless of receiver or formatting. */
function countCalls(source: string, name: string): number {
  return source.split(`${name}?.(`).length - 1;
}

/*
FNXC:NodeWorktreeIsolation 2026-07-29-16:20 (PR #2540 review — greptile P2 + coderabbit):
Detect a DISCARDED return receiver-agnostically and across line breaks.

The first version scanned line-by-line for a literal `this.options.` prefix, which
three separate evasions walked straight through: a call split across lines
(`this.options` / `.clearPhantomExecutorBinding?.(…)`), a local alias
(`options.clearPhantomExecutorBinding?.(…)`), and any other receiver spelling. A
ratchet that a reformat defeats is worse than no ratchet — it reports the invariant
is held while it is not, which is the exact failure this file exists to prevent.

Instead of matching the receiver, walk LEFT from the call over its receiver chain and
any `await`/`void` prefix, then look at the first meaningful character before it. A
statement boundary (`;` `{` `}`) or start-of-file means the call is a bare expression
statement and its `false` goes nowhere. Anything else — `=`, `(`, `&&`, `||`, `!`,
`?`, `:`, `,`, `return` — means the value is consumed.
*/
function findDiscardedCalls(source: string, name: string): string[] {
  const marker = `${name}?.(`;
  const discarded: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;

    /*
    Walk left over the receiver chain INCLUDING the whitespace inside it, so a call
    split across lines (`this.options` \n `.clearPhantomExecutorBinding?.(…)`) is
    treated the same as the single-line form. Missing that was the greptile P2: the
    first fix walked only chain characters, stopped at the newline, and read
    `options` as a consuming context.
    */
    let i = at - 1;
    while (i >= 0 && /[A-Za-z0-9_$.?!\s]/.test(source[i]!)) i--;
    // ...then over any await/void prefix, repeatedly.
    for (;;) {
      const prefix = source.slice(Math.max(0, i - 5), i + 1);
      const matched = /(await|void)$/.exec(prefix);
      if (!matched) break;
      i -= matched[1]!.length;
      while (i >= 0 && /\s/.test(source[i]!)) i--;
    }
    const preceding = i < 0 ? "" : source[i]!;
    if (preceding === "" || preceding === ";" || preceding === "{" || preceding === "}") {
      const lineNumber = source.slice(0, at).split("\n").length;
      discarded.push(`${SELF_HEALING}:${lineNumber} bare ${name} call`);
    }
  }
  return discarded;
}

const SELF_HEALING = "packages/engine/src/self-healing.ts";
const EXECUTOR = "packages/engine/src/executor.ts";
/*
FNXC:CodeOrganization 2026-08-03-20:25:
U4 peels move free-function bodies under executor/*. Source-scan ratchets must
follow the peel (facade in executor.ts + body in the peeled module) so they do
not re-block legitimate extractions.
*/
const CLEAR_PHANTOM = "packages/engine/src/executor/clear-phantom-executor-binding.ts";
const HAS_LIVE_SESSION_SURFACE = "packages/engine/src/executor/has-live-session-surface.ts";
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
    const discarded = findDiscardedCalls(source, "clearPhantomExecutorBinding");

    expect(
      countCalls(source, "clearPhantomExecutorBinding"),
      "no call sites found — the ratchet is scanning the wrong thing",
    ).toBeGreaterThan(0);
    expect(
      discarded,
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
    // Facade on TaskExecutor must forward to the free function (or call the probe).
    const facadeSource = stripComments(readSource(EXECUTOR));
    const facadeStart = facadeSource.indexOf("clearPhantomExecutorBinding(taskId: string");
    expect(facadeStart, "clearPhantomExecutorBinding not found in executor source").toBeGreaterThan(-1);
    const facadeBody = facadeSource.slice(facadeStart, facadeStart + 1200);
    expect(
      facadeBody.includes("this.hasLiveSessionSurface(taskId)")
        || /hasLiveSessionSurface:\s*\(id\)\s*=>\s*this\.hasLiveSessionSurface\(id\)/.test(facadeBody)
        || /clearPhantomExecutorBindingImpl\(/.test(facadeBody),
      "clearPhantomExecutorBinding facade must call the shared hasLiveSessionSurface probe (directly or via peeled Impl deps), not re-derive liveness inline",
    ).toBe(true);
    expect(
      /activeSessions\.has|activeStepExecutors\.has|activeWorkflowStepSessions\.has|activeCliTaskSessions\.has/.test(facadeBody),
      "the session-map disjunction is inlined on the facade; it belongs only in hasLiveSessionSurface",
    ).toBe(false);

    // Peeled free function must consume the hasLiveSessionSurface deps callback.
    const peelSource = stripComments(readSource(CLEAR_PHANTOM));
    expect(
      peelSource.includes("deps.hasLiveSessionSurface(taskId)"),
      "clearPhantomExecutorBinding peel must call deps.hasLiveSessionSurface, not re-derive liveness inline",
    ).toBe(true);
    expect(
      /activeSessions\.has|activeStepExecutors\.has|activeWorkflowStepSessions\.has|activeCliTaskSessions\.has/.test(peelSource),
      "the session-map disjunction is inlined in clear-phantom-executor-binding; it belongs only in hasLiveSessionSurface",
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
    /*
    FNXC:NodeWorktreeIsolation 2026-07-29-16:20 (PR #2540 review — coderabbit):
    Assert DELEGATION, not the presence of the option key. `hasLiveSessionSurface:
    () => false` satisfies a key-presence regex while disabling the gate completely —
    the same "declared but inert" shape as the never-wired option this property was
    written to catch. Require the callback to forward its argument to the executor's
    implementation.
    */
    expect(
      /hasLiveSessionSurface:\s*\((\w+)[^)]*\)\s*=>\s*this\.executor\?\.hasLiveSessionSurface\(\1/.test(
        stripComments(readSource(IN_PROCESS_RUNTIME)),
      ),
      "in-process-runtime does not forward hasLiveSessionSurface to the executor — an absent or stubbed probe reads as `false` and silently disables every liveness gate that consumes it",
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
    // Facade must remain on TaskExecutor (public API for self-healing wiring).
    const facadeSource = stripComments(readSource(EXECUTOR));
    const facadeStart = facadeSource.indexOf("hasLiveSessionSurface(taskId: string): boolean");
    expect(facadeStart, "hasLiveSessionSurface not found — the probe was removed or renamed").toBeGreaterThan(-1);
    /*
    FNXC:NodeWorktreeIsolation 2026-07-29-16:20 (PR #2540 review — coderabbit):
    FAIL CLOSED on a missing boundary. `indexOf` returning -1 made `slice(start, -1)`
    scan nearly the whole of executor.ts, so an unrelated later `activeSessionRegistry`
    reference could satisfy this assertion after the probe itself was deleted.
    */
    const facadeEnd = facadeSource.indexOf("\n  }", facadeStart);
    expect(facadeEnd, "could not find the end of hasLiveSessionSurface facade — the ratchet would scan the whole file").toBeGreaterThan(facadeStart);
    const facadeBody = facadeSource.slice(facadeStart, facadeEnd);
    expect(
      facadeBody.includes("activeSessionRegistry.pathsForTask")
        || facadeBody.includes("pathsForTask")
        || /hasLiveSessionSurfaceImpl\(/.test(facadeBody),
      "hasLiveSessionSurface facade must consult registry paths (directly or via peeled Impl)",
    ).toBe(true);

    // Free-function body must include the registry/paths term (FN-6756 blind spot).
    const peelSource = stripComments(readSource(HAS_LIVE_SESSION_SURFACE, 200));
    expect(
      peelSource.includes("pathsForTask")
        || peelSource.includes("activeSessionRegistry.pathsForTask"),
      "hasLiveSessionSurface no longer consults activeSessionRegistry paths — a triage planner is owned by TriageProcessor and appears in NO executor-owned map, so this term is the only thing that sees it",
    ).toBe(true);
  });
});
