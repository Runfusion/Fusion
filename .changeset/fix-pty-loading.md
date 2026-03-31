---
"@dustinbyrne/kb": patch
---

Fix standalone CLI native asset packaging for terminal support

- Stage node-pty native assets (pty.node, spawn-helper) alongside the compiled binary
- Assets are placed in `dist/runtime/<platform-arch>/` for each build target
- Runtime resolution patch ensures Bun-compiled binary can find staged native assets
- Terminal functionality now works in isolated standalone deployments
- Non-terminal commands no longer crash due to eager native module loading
