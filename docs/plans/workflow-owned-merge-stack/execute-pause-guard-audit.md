# `TaskExecutor.execute()` and the pause contract — call-site audit

<!--
FNXC:WorkflowLifecycle 2026-07-30-10:40:
Written to make a deferred question DECIDABLE, not to decide it. `executor-prompt.test.ts` has three
failures asserting that `execute()` refuses to dispatch a user-paused card during a global pause;
the guard actually lives in the scheduler, so those tests call a layer that has never had it. Both
available fixes change behaviour or delete coverage of the USER PAUSE safeguard, so this records the
evidence instead of picking one inside a test-repair PR.
-->

## The failing assertion

`packages/engine/src/__tests__/executor-prompt.test.ts` — 3 failures, all of this shape:

```
expect(mockedCreateFnAgent).not.toHaveBeenCalled();   // actually called 1 time
```

The test's own comment (from #2371) states the behaviour as *"a paused todo task is no longer
dispatched at all"*. That is true of the **scheduler** path: `scheduler.ts:1515` is a hard
`globalPause` stop that never reaches `.execute(`. These three tests call `executor.execute(task)`
**directly**, so no guard fires and an agent session is created.

So the tests are not simply wrong about the product — they assert an invariant at a layer that does
not enforce it. Whether that layer *should* enforce it is the open question.

## Every `execute()` call site outside the scheduler

Enclosing method resolved per site. "Guard" means a `globalPause`/`enginePaused` check reached before
the call — **directly OR through a helper that reads them**.

FNXC:WorkflowLifecycle 2026-07-30-15:45 (PR review — coderabbit, major):
An earlier version of this table scanned each method body for the literal flag names and marked
`dispatchUnpauseResume()` unguarded. Wrong: it reads them through `getExecutionPauseLabel()`. The scan
was re-run against the 13 methods that read the flags directly, treating a call to any of them as a
guard. That is the SECOND cheap heuristic to produce a confident wrong answer in this audit — the
first was a 40-line window above each call site, which mis-attributed two guarded sites as unguarded.
Both erred by making the problem look different in size than it is.

| Site | Enclosing method | Pause-guarded? | Reading |
|---|---|---|---|
| `executor.ts:3333` | `dispatchUnpauseResume()` | **yes** (via helper) | Guarded at `:3290` via `getExecutionPauseLabel()`, which reads both flags; returns at `:3293`. Also the unpause path, so it declines while a pause is still active rather than racing the operator. |
| `executor.ts:3495` | `constructor()` — a `task:moved` subscription, `to === "in-progress"` | **no** | **The one real gap.** Event-driven dispatch that consults no pause state. |
| `executor.ts:5702` | `resumeTaskForAgent()` | yes | `if (settings.globalPause \|\| settings.enginePaused) return;` plus `!task.paused`. |
| `executor.ts:5858` | `resumeOrphaned()` | yes | Same guard earlier in the method. |
| `in-process-runtime.ts:2255` | `drainWorkflowContinuations()` | no (indirect) | Gated by `workflowContinuationDrainActive \|\| this.status !== "active"`. Engine pause is *expected* to leave the runtime non-active, so this is guarded by proxy rather than by a pause read. |

**Result: exactly one path — the `task:moved` subscription in the constructor — can reach
`execute()` without consulting pause state.** Re-verified after that correction: the block
(`executor.ts:3481-3503`) reads neither flag directly and calls NONE of the 13 methods that do. That is a much narrower question than "does `execute()`
need a guard", and it is answerable by whoever owns the pause contract.

## Why this was not fixed here

Three options, and they are not equivalent:

1. **Guard the `task:moved` subscription.** Narrowest change; leaves `execute()` unguarded by design
   and keeps the scheduler as the single pause authority. Does **not** make the three tests pass,
   because they call `execute()` directly.
2. **Give `execute()` its own guard** (defence-in-depth). Makes the three tests pass, but must not
   refuse the legitimate internal re-dispatch paths above — `dispatchUnpauseResume()` in particular
   would break outright, since it exists to resume a card the operator just unpaused.
3. **Retire the three direct-`execute()` assertions** and cover the invariant at the scheduler layer,
   where it is enforced.

(2) and (3) both touch coverage of **user pause** — a safeguard this program has re-ratified and
explicitly told workers not to narrow. Picking either silently inside a test-repair PR is how a
safeguard gets weakened by accident, so the decision is left to the owner with the table above.

## RESOLVED: the gap is reachable, from three surfaces

The audit above left one thing open — whether the `task:moved` subscription can actually fire while
paused. It can, and nothing on the path checks:

| Layer | Pause check? |
|---|---|
| `moves.ts` (`moveTaskImpl` / `moveTaskInternal`, which emit `task:moved`) | **no** — no `globalPause`/`enginePaused` read anywhere in the file |
| `POST /tasks/:id/move` (`register-task-workflow-routes.ts:1927`) — the operator drag/move route | **no** |
| `fn task move` (`cli/src/commands/task.ts`, 5 `moveTask` call sites) | **no** |
| the executor's `task:moved` subscription (`executor.ts:3473`) | **no** — it destructures `source` but never gates on it; the only early return is `recoveringCompleted` |

So the repro is ordinary operator behaviour:

1. Operator pauses the engine globally.
2. Operator drags a card into the wip column (or calls `POST /tasks/:id/move`, or `fn task move`).
3. `store.moveTask` emits `task:moved` with `to === "in-progress"`.
4. The executor subscription dispatches `execute()` — consulting no pause state.
5. An agent session starts during a global pause.

Step 5 is not inferred: it is exactly what `executor-prompt.test.ts`'s three failures observe —
`createFnAgent` called once with `globalPause: true`. Those tests are reporting a real, reachable
behaviour at the layer they exercise, not merely testing the wrong layer.

**This changes the recommendation.** The gap is not theoretical, so "leave the status quo" is no
longer one of the options: some layer has to refuse. Which one is still the owner call —

- guarding the **subscription** keeps the scheduler as the single pause authority and covers every
  trigger surface at once, but leaves `execute()` callable while paused by design;
- guarding the **move route(s)** refuses the operator action outright, which is a UX decision (an
  operator may legitimately want to stage a board while paused);
- guarding **`execute()`** covers everything but must exempt `dispatchUnpauseResume()`.

## What is verified here, and what is not

Verified: the enclosing method and pause-guard status of all five non-scheduler call sites, resolved
programmatically rather than by eyeballing nearby lines (an earlier 40-line-window pass gave a
different and wrong attribution for two sites — `:5702`/`:5858` looked unguarded because their guard
sits earlier in the same method).

**Now** verified (previous section): the subscription IS reachable while paused — via the move route,
the CLI, and any direct `moveTask`. An earlier version of this document listed that trace as the
remaining work; it is done, and it removed "the gap is theoretical" as a possibility.

### Severity: the session RUNS; only the completion handoff is withheld

The remaining question was whether something downstream aborts a session started this way. It does
not. `executor.ts` reads `globalPause`/`enginePaused` in 18 places; none of them is on the path
between the `task:moved` subscription and session start:

- `execute()` is a 7-line wrapper around `executeCore()` — no pause read.
- `executeCore()` is routing only (73 lines) — no pause read.
- the guarded lanes are all *other* entry points (`resumeTaskForAgent`, `resumeOrphaned`,
  `recoverCompletedTask`) or *later* stages.

What DOES fire is `shouldDeferCompletionForGlobalPause()`, which withholds the **completion
handoff** while a global pause is active (called from four sites, e.g. `:12982` "before workflow
steps after step-session completion"), plus `createTaskDoneTool`'s `hardPauseActive`.

So the observable behaviour of the gap is:

| | during a global pause |
|---|---|
| worktree acquired | **yes** |
| agent session created | **yes** — `createFnAgent` called, per `executor-prompt.test.ts` |
| model calls / file mutations | **yes** |
| card advances to review | no — handoff deferred |

That is not cosmetic. An operator who pauses the engine and then rearranges the board gets a live
agent burning tokens and mutating a worktree; the only thing the pause still buys them is that the
card does not move on. It makes choosing a layer urgent rather than optional.

### No lane outside the executor refuses either

The last open possibility was that some other layer independently declines to start work under a
global pause, shrinking the blast radius. Checked, and it does not:

| Lane | Pause reads | Where they are |
|---|---:|---|
| `runtimes/in-process-runtime.ts` | 4 | `start()` (engine startup) and `resumeAfterUnpause()` — neither is on the `task:moved` dispatch path |
| the agent-session seam (`pi.ts`, `index.ts` — `createFnAgent`) | **0** | nothing to gate on |
| `scheduler.ts` | 15 | the scheduler lane only, which this path bypasses by construction |

`agent-heartbeat.ts` reads pause in 10 places, but that governs the durable-agent heartbeat lane, not
executor dispatch — it cannot un-create a session the executor already started.

So the table above stands as written: the blast radius is a real agent session doing real work. Every
pause read reachable on this path — inside the executor and outside it — is accounted for.

**Genuinely open, and the only thing left:** which layer should hold the guard. That is a
pause-contract decision, not a measurement.
