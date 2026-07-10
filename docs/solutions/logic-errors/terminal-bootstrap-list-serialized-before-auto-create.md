---
category: logic-errors
module: dashboard-terminal
tags: [terminal, bootstrap, latency, websocket, xterm, performance]
problem_type: unnecessary-serialization
applies_when: A client bootstrap sequence gates a decision-irrelevant network round trip in front of the round trip that actually creates the resource the user is waiting on.
---

# Terminal initial load blocked by a no-op session-list round trip (FN-7686)

## Problem

Opening the dashboard terminal rendered the terminal chrome immediately but
the xterm surface stayed blank for seconds before the first shell
prompt/output appeared. The delay lived in the bootstrap sequencing, not in
xterm rendering or steady-state I/O.

`useTerminalSessions.ts`'s `validateAndRestore()` effect always called
`listTerminalSessions()` (bounded by `BOOTSTRAP_LIST_TIMEOUT_MS = 15000`) and
did not set `isReady=true` — the gate the auto-create effect waits on —
until that HTTP round trip resolved. On a **fresh open** (no persisted
`kb-terminal-tabs`), that round trip's result is provably discarded: with
zero local tabs, the stale-session filter always reduces to an empty array
regardless of what the server returns. The list call was validation in
name only, yet it fully serialized in front of `createTerminalSession()` —
the round trip that actually spawns the PTY session the terminal needs
before a WebSocket can even attempt to connect.

## Root cause pattern

A bootstrap step (`list`) is unconditionally awaited before a dependent step
(`create`), even when the first step's result cannot change the second
step's outcome for a specific precondition (here: nothing to validate).
This is the general "unnecessary round-trip serialization" trap — the code
reads as "validate then create" but for one common branch, "validate" does
nothing.

## Fix

Skip the list-validation round trip entirely when
`readTabsFromStorage(projectId)` is empty on mount, and mark
`serverAvailable=true`/`isReady=true` immediately so the auto-create effect
is not gated behind a discardable network call. Leave the list call fully
in place whenever there ARE persisted tabs to validate (that case IS
decision-relevant — the server tells you which sessionIds still exist).

```ts
// packages/dashboard/app/hooks/useTerminalSessions.ts
if (readTabsFromStorage(projectId).length === 0) {
  setServerAvailable(true);
  setIsReady(true);
  return; // skip listTerminalSessions() — nothing to validate
}
```

## Guardrails preserved

- `generationRef` staleness guards against stale bootstrap completions.
- Windows no-auto-create suppression (unchanged — still runs before this
  branch).
- `bootstrapCreateInFlightGenerationRef` create-dedup and the
  `setTimeout(…, 0)` micro-guard.
- The 15s `BOOTSTRAP_LIST_TIMEOUT_MS`/`BOOTSTRAP_CREATE_TIMEOUT_MS` bounds
  (unchanged for the reload-with-persisted-tabs path).
- `--login` shell profile execution (left untouched — real,
  environment-dependent cost, not "fixed" by dropping shell setup).

## What was ruled out with evidence (do not re-attempt without new evidence)

- xterm dynamic import/init (`TerminalModal.initTerminal`) — already runs
  concurrently with session bootstrap; not serialized.
- `READY_QUIET_WINDOW_MS`/resize-suppression buffering — bounded at 150ms.
- `resolveScopedStore` (multi-project) — resolves synchronously from an
  already-live engine on the warm-project path.
- WebSocket connect gated behind session creation — inherent and correct;
  a session must exist before its socket can open.

## Regression command

```bash
pnpm --filter @fusion/dashboard exec vitest run app/hooks/__tests__/useTerminalSessions.test.ts app/hooks/__tests__/useTerminal.test.ts app/components/__tests__/TerminalModal.test.tsx --silent=passed-only --reporter=dot
```

The key regression (`bootstrap sequencing (FN-7686)` describe block in
`useTerminalSessions.test.ts`) holds `listTerminalSessions()` permanently
pending on a fresh (empty-localStorage) mount and asserts auto-create still
completes — this fails pre-fix (timeout) and passes post-fix.
