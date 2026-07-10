---
"@runfusion/fusion": patch
---

summary: Fix Cursor CLI model discovery and auth to use the real cursor-agent commands.
category: fix
dev: Switches model discovery to `cursor-agent models` (plain text `id - Label`, no `--json`/`model list` support) with header/tip/empty-state filtering, and derives auth from `cursor-agent status --format json` (`isAuthenticated`) instead of a `--version`-success heuristic.
