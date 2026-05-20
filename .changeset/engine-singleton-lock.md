---
"@fusion/engine": minor
---

feat(engine): guard one engine per project per machine

Adds a per-machine singleton lock that engages before each engine
starts, preventing two `fn` dashboard processes from running engines
for the same project on the same host (a scenario that previously
caused worktree corruption and task-state races for in-process
projects).

The guard combines two independent checks:
- A `proper-lockfile`-backed file at `<project>/.fusion/engine.lock`
  with stale-lock recovery.
- A loopback listener (UDS on POSIX, named pipe on Windows) on a
  hashed per-project address.

Failures throw `EngineAlreadyRunningError`; both guards are released
on `stopAll()` / `pauseProject()`.
