/*
FNXC:NotificationTestHarness 2026-07-30-23:40:
Drain the promise chain behind a FIRE-AND-FORGET store event handler.

WHY THIS EXISTS. `NotificationService` subscribes to `task:moved` / `task:updated` with synchronous
`(data): void` listeners that kick off async work via `void this.handleTaskMovedAsync(data)` — the store
emits and does not wait. A test therefore has nothing to await, and 25 call sites across the two
notification suites reached for `await Promise.resolve()`: exactly ONE microtask.

That works only while the handler happens to complete within one tick. It is not an assertion about
behaviour — it is a count of the `await`s that happen to be on the path, so adding a single `await`
anywhere inside the handler turns 29 passing tests red without anything being broken. (One site had
already grown a second `await Promise.resolve()` back to back, which is the same discovery made
locally and papered over.)

Draining a fixed, generous number of microtasks instead means the tests assert what they are actually
about — "the notification was dispatched" — and stop encoding the handler's internal await depth.

WHY MICROTASKS AND NOT `setImmediate`. Both suites use `vi.useFakeTimers()`, which replaces the macrotask
queue; a `setImmediate`-based drain would hang under fake timers unless every call site also advanced
them. Chained promise continuations are unaffected by fake timers, so an await loop is the one drain that
works in both modes.

WHY NOT `vi.waitFor`. It polls with real timers and would fight the fake-timer suites for the same
reason. It is also unnecessary here: the work is a promise chain, not a timed retry.

NOT a substitute for advancing timers. Tests that assert the deferred/grace-window behaviour still call
`vi.advanceTimersByTime(...)` themselves; this only drains what is already queued.
*/

/** Yield to the microtask queue enough times for a fire-and-forget handler chain to settle. */
export async function flushAsyncHandlers(iterations = 25): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}
