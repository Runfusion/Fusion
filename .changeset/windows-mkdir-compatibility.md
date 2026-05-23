---
"@runfusion/fusion": patch
---

Fix Windows compatibility by replacing `mkdir -p` shell command with Node.js `fs.mkdir({ recursive: true })` for cross-platform directory creation.