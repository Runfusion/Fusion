---
title: "Observable long-running agent turns through a blocking plugin-route seam"
date: 2026-06-03
category: architecture-patterns
module: fusion-plugin-compound-engineering
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "A plugin/HTTP route drives a long-running interactive agent turn behind a blocking request/response seam"
  - "Mid-turn agent output (thinking, tool calls, streamed text) is swallowed by a pull-based settle-only event API"
  - "A fixed per-turn timeout risks killing legitimately long, tool-heavy turns that are still actively working"
  - "Clients need live visibility into agent work without persisting transient activity into durable state"
  - "A paused, stateful agent session must be resumable across process restarts without re-emitting prior output"
symptoms:
  - "Client blocks on a single POST for minutes with zero visibility into agent progress"
  - "All mid-turn thinking, tool calls, and streamed text are swallowed; only question/complete/error surface"
  - "A fixed 120s per-turn timeout interrupts legitimately long tool-heavy turns while the agent is still working"
root_cause: async_timing
resolution_type: code_fix
related_components:
  - tooling
  - frontend_stimulus
tags:
  - agent-observability
  - sse
  - streaming
  - detached-execution
  - plugin-routes
  - interactive-session
  - inactivity-timeout
  - live-activity
  - compound-engineering
---

# Observable long-running agent turns through a blocking plugin-route seam

## Context

The compound-engineering bundled plugin runs interactive CE-stage agent sessions through plugin routes. The host exposes a deliberately minimal **pull-based** interactive seam (`packages/core/src/plugin-types.ts`): the caller drives one `prompt`/`answer` per turn and awaits `nextEvent()`, which resolves only when the turn *settles* (`question` | `complete` | `error`). That contract is simple to drive deterministically from a route or a scripted test — but it had three structural consequences that surfaced as user-visible failures:

1. **All mid-turn output was swallowed.** `nextEvent()` does not resolve on intermediate thinking/text/tool activity, so a multi-minute tool-heavy turn produced *nothing* observable until it finished.
2. **Routes blocked blind.** The POST handler ran the whole turn synchronously inside the request, so clients waited minutes with no feedback (and, for the opening turn, no session id to poll).
3. **A fixed 120s turn timeout killed turns that were actively working** — long, legitimately-busy turns hit the wall and died.

The fix made the agent's work live-streamable, made routes non-blocking (detached turns), made the timeout inactivity-based, and persisted the working trace into the transcript across settle/interrupt and process restarts.

## Guidance

### 1. Keep the pull-based settle contract; add a SEPARATE push channel

Don't convert `nextEvent()` into a stream. Live visibility is a *new, optional, additive* callback (`onProgress`) on the session options — the terminal-only pull semantics are untouched. Scripted test fakes that drive `prompt`/`nextEvent` are completely unaffected, and factories that can't stream simply ignore the option.

```ts
// packages/core/src/plugin-types.ts
export interface CreateInteractiveAiSessionOptions {
  // ...
  /** Live progress callback, invoked WHILE a turn runs (the pull-based
   *  nextEvent() only resolves once the turn settles). Must not throw —
   *  implementations should swallow callback errors. */
  onProgress?: (event: InteractiveAiSessionProgressEvent) => void;
}
```

### 2. Deltas, not snapshots; the consumer accumulates

Progress events carry incremental *deltas*. The consumer owns accumulation, merge-by-kind, and capping — the protocol stays tiny and the producer holds no buffer state.

```ts
export type InteractiveAiSessionProgressEvent =
  | { type: "thinking"; delta: string }   // incremental DELTA, not a snapshot
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; phase: "start" | "end"; isError?: boolean };
```

The engine adapter (`packages/engine/src/index.ts`) maps the underlying agent hooks (`onText`/`onThinking`/`onToolStart`/`onToolEnd`) into these deltas, and **every callback is wrapped in try/catch so a consumer error can never break the agent turn**. The consumer (`orchestrator.handleProgress`) merges consecutive same-kind deltas into one activity turn, opens/closes discrete tool turns, and caps both per-turn chars and turn count, dropping the oldest (the tail is what the user is watching).

### 3. Detached turns must NEVER reject

Routes return immediately after the session row exists; the turn runs as a floating background promise (`void turn`). For that to be void-safe, the background promise can have *no* rejection path: factory-create failure, driver throw, and timeout all resolve into a persisted state transition (`failSession` / `interruptSession` / `applyEvent`) plus an emitted observable event. No unhandled rejections, no silent loss.

```ts
// orchestrator.start
const turn = this.runOpeningTurn(session.id, stage, opts.openingMessage);
if (opts.detach) {
  void turn;                       // never rejects (failures persist into state)
  return { session: this.requireSession(session.id) };
}
```

### 4. Inactivity watchdog, not a fixed turn timeout

The watchdog rejects only after `turnTimeoutMs` of *no progress*; each progress event stamps `lastProgressAt` and re-arms it, so an actively-working turn survives indefinitely. With a non-streaming factory (no progress ever arrives), it degrades cleanly to the old fixed per-turn timeout.

```ts
const check = () => {
  if (cancelled) return;  // cancel() stops the loop when the turn settles
  const elapsed = Date.now() - (this.lastProgressAt.get(sessionId) ?? 0);
  if (elapsed >= this.turnTimeoutMs) { reject(new CeTurnTimeoutError(this.turnTimeoutMs)); return; }
  timer = setTimeout(check, this.turnTimeoutMs - elapsed);  // re-arm to the remaining window
  timer.unref?.();
};
```

A watchdog rejection is caught and becomes a preserved-progress `interrupted` state — never silent.

### 5. Live activity is transient; flush a condensed trace into history on settle/interrupt

The mid-turn buffer lives only in memory; the GET route reads it from the orchestrator (`getLiveActivity(id)`) and attaches it as a transient `liveActivity` field on the response — never written as session state during the turn.

On settle (`question`/`complete`/`error`) or interrupt, `flushActivity` writes a condensed copy into conversation history **before** the settling record, so the transcript retains the working trace across restarts.

### 6. Suppress progress (and all side effects) during rehydration replay

Resume re-creates a live handle by replaying recorded user turns against the model. That replay re-streams old output — which must not be re-emitted as new work. A `replaying` set gates `handleProgress`, and the replay drains one event per drive but **discards** it (no persist/emit/artifact-write).

### 7. Throttle push emits and bump the staleness anchor on the same beat

Progress is high-frequency; per-delta SSE emits would flood clients. Throttle to one emit per interval (500ms here), and on that same beat bump the persisted liveness anchor (`lastActivityAt`) so the stale-session recovery rubric sees an actively-working turn as alive rather than abandoned. The client converges via **push + poll**: an SSE event triggers an immediate refetch (low latency), and a poll interval runs while the turn is mid-flight as a fallback — stopping the moment the session settles.

## Why This Matters

- **Observability without protocol churn.** A push side-channel gives live visibility while preserving a settle contract that's trivial to drive deterministically from routes and tests. Converting `nextEvent()` into a stream would have rewritten every consumer and every scripted fake for a purely additive feature.
- **Non-blocking routes need void-safe background work.** Detaching a turn is only safe if the background promise has no rejection path. Routing *every* failure into persisted state + an emitted event is what makes `void turn` correct rather than a latent unhandled-rejection bug.
- **Activity is the liveness signal.** An inactivity watchdog encodes the real intent ("is it still working?") instead of a proxy ("has it taken too long?"), and folding the same signal into the staleness anchor keeps two independent health rubrics coherent.
- **Resilience across restarts.** Persisting a condensed trace on settle/interrupt, plus side-effect-suppressed rehydration, means a paused session resumes in a fresh process with its history intact and without double-streaming.

## When to Apply

- Surfacing live agent (or any long-running job) work through a request/response or pull-based seam that only resolves on terminal events
- A route runs a multi-minute operation and clients currently block with no progress and no handle to poll
- A fixed timeout is killing work that is legitimately still active
- Resuming a paused, stateful session across process restarts without re-emitting prior output

Apply the *push-channel-alongside-pull-contract* and *void-safe-detached-turn* patterns together; they're complementary. Don't reach for this when the operation is short and synchronous — the transient buffer, watchdog, and rehydration machinery are overhead you don't need.

## Examples

Before/after, distilled:

- **Before:** route `await`s the entire turn inside POST; client gets nothing for minutes; mid-turn output is dropped because `nextEvent()` only resolves on settle; a fixed 120s timeout kills busy turns.
- **After:** POST returns `201 {session}` immediately with `detach: true`; `onProgress` deltas accumulate into a transient buffer attached at GET; an inactivity watchdog re-armed by progress lets busy turns run; failures persist into state + emit; resume rehydrates with replay suppressed.

The regression tests (`plugins/fusion-plugin-compound-engineering/src/__tests__/orchestrator-live-output.test.ts`) lock the load-bearing behaviors:

- A busy turn pumped with `thinking` deltas at ~45ms intervals for ~3× the 120ms test timeout stays `active`; once quiet, it flips to `interrupted` with the activity trace present in history.
- `answer(detach)` returns immediately (`status: active`, `currentQuestion: null`), then the background turn converges to the next question.
- `start(detach)` with an exploding factory converges to `status: error` with the message preserved and an observable error event emitted — never silent.

Failure modes this prevents:

1. Silent mid-turn blackout (pull-only API resolves nothing until terminal)
2. Blocked-blind routes (request held open for the full turn, no handle to poll)
3. Killed-while-working timeouts (fixed timeout vs. activity-based liveness)
4. Unhandled rejection / silent loss from floating detached turns
5. Replay double-streaming during rehydration
6. SSE flooding from per-delta emits
7. Stale-rubric false positives on busy sessions (liveness not bumped with activity)
8. Lost transcript on interrupt/settle (transient buffer never condensed into history)
9. Consumer `onProgress` errors breaking the agent turn (guarded at the adapter)

## Related

- [Plugin-bundled skills silently fail to load in interactive sessions](../integration-issues/plugin-bundled-skills-not-loading-in-interactive-sessions.md) — sibling learning on the same `CreateInteractiveAiSessionOptions` seam (it added `requestedSkillNames`/`additionalSkillPaths`; this one adds `onProgress`)
- `docs/plugins/compound-engineering.md` §Sessions — the reference doc for the CE session transport (push + poll)
- Key files: `packages/core/src/plugin-types.ts`, `packages/engine/src/index.ts` (interactive adapter), `plugins/fusion-plugin-compound-engineering/src/session/orchestrator.ts`, `src/routes/session-routes.ts`, `src/dashboard/hooks/useCeSession.ts`
