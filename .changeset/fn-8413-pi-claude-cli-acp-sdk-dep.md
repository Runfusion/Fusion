---
"@runfusion/fusion": patch
---

summary: Install @agentclientprotocol/sdk with @runfusion/fusion so the Claude CLI pi extension can load.
category: fix
dev: FN-8413 / issue #2355 — nested dist/pi-claude-cli/package.json declared the SDK but npm only installs root dependencies; pin remains 0.24.0 (do not bump to 1.x).
