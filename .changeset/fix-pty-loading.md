---
"@dustinbyrne/kb": patch
---

Fix packaged binary tests by lazy-loading node-pty

The Bun-compiled `kb` binary was failing to run `--help`, `task list`, and `dashboard` commands due to eager loading of the native `node-pty` module. The fix converts the static import to a dynamic import that only executes when a terminal session is actually being created. This allows CLI commands that don't use the terminal to work without loading the native module, while preserving full dashboard terminal functionality when running from source.
