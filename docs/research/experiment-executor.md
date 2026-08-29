# Experiment Executor (`@fusion/engine`)

`ExperimentExecutor` provides engine-side parity with pi-autoresearch's init/run/log loop.

## Public API

- `initExperiment(input)`
  - Creates a new active session and appends a `config` record.
  - If an active/finalizing session with the same `name` + `projectId` exists, starts a new segment instead.
- `runExperiment(input, opts?)`
  - Runs benchmark command asynchronously, parses `METRIC` lines, and returns a transient run result.
  - Does not persist run records.
- `logExperiment(input)`
  - Appends a persisted `run` record with selected outcome.
  - `keep` commits git changes.
  - `discard` / `checks_failed` / `errored` can revert to a baseline commit.
- `getStatus(sessionId)` returns current session status, runs in segment, active handles, and limits.
- `cancel(runHandle)` aborts an in-flight benchmark run.

## Store Composition (FN-4218)

Executor uses `ExperimentSessionStore` for:
- session creation/reuse (`createSession`, `startNewSegment`)
- record append (`appendRecord`)
- best/kept pointers (`setBestRun`, `recordKept`)
- run payload commit patching (`updateRecordPayload` additive method)

## METRIC Grammar

Parser accepts:

```regex
^METRIC\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(?:\(([^)]+)\))?\s*$
```

- first valid metric = primary
- later metrics = secondary
- dedup by metric name (last-write-wins)
- denylist: `__proto__`, `constructor`, `prototype`
- non-finite values are ignored with warnings

## Benchmark Execution Contract

`runBenchmark()` uses non-blocking child process execution (`spawn`, async path):
- default timeout: 10 minutes
- default max buffer: 10MB
- supports `AbortSignal`
- throttled progress callback (<= every 500ms)
- when stdout exceeds buffer, full output is written to temp file and returned stdout is truncated to last 64KB

## Keep/Revert Git Policy

Preserved artifacts on revert:
- `autoresearch.jsonl`
- `autoresearch.md`
- `autoresearch.ideas.md`
- `autoresearch.checks.sh`
- `autoresearch.config.json`
- `autoresearch.hooks/`

Behavior:
- `keep`: stage all + commit (`experiment(<session>): keep <run>` message default)
- discard/check failures/errors: reset hard to baseline while preserving autoresearch artifacts via stash roundtrip

## Error Taxonomy

- `ExperimentMaxIterationsError` — run attempted after reaching max iterations.
- `ExperimentGitNotConfiguredError` — keep/revert path requested without configured `GitOps`.
- `ExperimentRevertConflictError` — stash-pop conflict while restoring preserved artifacts after revert.

## Follow-ups

- FN-4221: CLI/dashboard/pi-extension wiring.
- FN-4222: finalize workflow (branch/finalization orchestration).
