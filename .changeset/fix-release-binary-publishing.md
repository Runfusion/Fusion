---
"@runfusion/fusion": patch
---

Fix the Binary Release workflow so platform binaries publish to GitHub Releases again. The release job now tolerates a single failing build leg instead of being skipped (which previously suppressed all assets), the node_modules cache key includes CPU arch to stop arm64 runners restoring x64 native deps, the macOS CLI signing step is skipped gracefully when Apple certs are absent, and the dependency-graph plugin build uses a cross-platform copy step that no longer breaks the Windows desktop build.
