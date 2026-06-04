---
"@runfusion/fusion": patch
---

Stop missions from silently looping or stalling when agents can't run their tasks (GitHub #1261).

Importing a catalog ("company") agent assigns it the role `custom`, which the scheduler never auto-assigns mission/queue work to. Combined with a model/provider that rejects the `developer` system role, this surfaced to users as an invisible, repeating failure loop.

- **Auto-recover from incompatible roles:** an "unsupported message role" provider rejection (e.g. a reasoning model sending the `developer` role to a provider that only accepts `system`/`user`/`assistant`/`tool`) is now treated as a model-selection error, so a configured fallback model is tried once before the task is marked failed. The single-swap guard keeps an incompatible fallback from looping.
- **Stop the retry loop:** operator-actionable failures (unsupported role, auth, quota) now block the mission feature immediately with a clear event instead of burning the full retry budget re-running the same cryptic error.
- **Preflight mission start:** when ephemeral agents are disabled and no eligible executor agent exists, starting a mission now fails fast with an actionable message instead of queueing tasks forever.
- **Warn on import:** importing only `custom`-role agents now surfaces a warning that they won't be auto-assigned mission work unless one is given the `executor` role.
