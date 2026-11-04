---
"@runfusion/fusion": minor
---

summary: Boot logs, the terminal, and health now report the V8 heap ceiling; a default one warns in Mailbox.
category: feature
dev: `/api/health` additively reports `heapLimitBytes`, `heapLimitSource`, and `heapLimitIsV8Default` and `/api/system-stats` gains the two descriptors (resolved from the live heap limit plus the launch sites that can set it: `execArgv` and `NODE_OPTIONS`); the boot path logs the ceiling on every start, the CLI banner and the supervisor's attempt/backoff/give-up lines state it with its declaring site and whether a respawn carries it, and when no launch site declared one the dashboard warns, writes one Mailbox notice per UTC day, and records a `runtime:heap-ceiling` run-audit row. Observation only — Fusion never sets, raises, defaults, or injects `--max-old-space-size`, and no raw `NODE_OPTIONS` value is exposed on any surface.
