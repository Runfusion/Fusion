---
"@dustinbyrne/kb": patch
---

Fix standalone CLI executable native module packaging

- Native module resolution is now lazy: only initializes when dashboard starts
- Lightweight commands (--help, task list) no longer trigger native module loading
- PTY terminal gracefully degrades to HTTP 503 when native assets unavailable
- Adds process.dlopen() fallback when /$bunfs/root symlink can't be created
- macOS signing script now signs native .node files in runtime/ directory
- Release workflows include runtime/ directory in artifacts
