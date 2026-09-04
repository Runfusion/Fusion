---
"@runfusion/fusion": patch
---

summary: Make the dashboard terminal work on macOS without manually compiling native code.
category: fix
dev: Switches the node-pty alias to @lydell/node-pty@1.2.0-beta.15 script-free platform packages, removes the build allowance, verifies fetched cross-target payloads against the lockfile, hard-fails missing staging unless explicitly opted out, and drops 32-bit Linux payload support.
