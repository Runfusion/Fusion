---
"@runfusion/fusion": patch
---

Fix the vitest memory-pressure auto-kill firing on a garbage metric and killing innocent processes. The guard probed `os.availableMemory` (which does not exist) and silently fell back to `os.freemem()`, which on macOS reads ~99% used on an idle machine — so with the toggle on, every vitest process was SIGKILLed every 30 seconds regardless of real memory pressure. It now reads `process.availableMemory()` (Node 22+) and refuses to auto-kill when only the unreliable freemem fallback is available. Kill targeting is also fixed: `pgrep -f vitest` matches full command lines (wrapper shells, monitors, editors that merely mention vitest); the TUI auto-kill/manual kill and the dashboard `POST /api/kill-vitest` + system-stats count now filter matches to actual node processes via a shared `findVitestProcessIds` helper.
