---
"@gsxdsm/fusion": patch
---

Fix file-based operations to work correctly with database-backed storage. Task directories are now created on-demand when file operations need them, preventing ENOENT errors when directories are missing.
