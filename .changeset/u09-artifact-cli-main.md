---
"@runfusion/fusion": patch
---

summary: Execute artifact-cache CLI entrypoints correctly on Windows.
category: fix
dev: Compare the script module URL against `pathToFileURL(process.argv[1])` instead of constructing a platform-sensitive file URL string.
