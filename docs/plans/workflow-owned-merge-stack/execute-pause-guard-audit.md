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

Enclosing method resolved per site, and "guard" means a `globalPause`/`enginePaused` check appearing
in that method before the call:

| Site | Enclosing method | Pause-guarded? | Reading |
|---|---|---|---|
| `executor.ts:3333` | `dispatchUnpauseResume()` | no | **Correct as-is.** This is the UNPAUSE path; a pause guard here would be self-contradictory. |
| `executor.ts:3495` | `constructor()` — a `task:moved` subscription, `to === "in-progress"` | **no** | **The one real gap.** Event-driven dispatch that consults no pause state. |
| `executor.ts:5702` | `resumeTaskForAgent()` | yes | `if (settings.globalPause \|\| settings.enginePaused) return;` plus `!task.paused`. |
| `executor.ts:5858` | `resumeOrphaned()` | yes | Same guard earlier in the method. |
| `in-process-runtime.ts:2255` | `drainWorkflowContinuations()` | no (indirect) | Gated by `workflowContinuationDrainActive \|\| this.status !== "active"`. Engine pause is *expected* to leave the runtime non-active, so this is guarded by proxy rather than by a pause read. |

**Result: exactly one path — the `task:moved` subscription in the constructor — can reach
`execute()` without consulting pause state.** That is a much narrower question than "does `execute()`
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

**Still not** verified: whether an agent started this way does damage before something else stops it.
The pause is re-read elsewhere during a run, so the session may abort early. That bounds the
SEVERITY, not the existence, and it does not change which layer needs the guard.
