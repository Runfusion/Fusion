---
"@runfusion/fusion": patch
---

summary: The Docker image now ships ripgrep, so coding agents can search at full speed in a container.
category: fix
dev: Adds `ripgrep` to the runner stage apt install alongside git and ca-certificates, and extends the runner-stage assertion in scripts/__tests__/dockerfile-workspace-manifests.test.mjs to cover it. Agents reach for `rg` first and silently degrade to slower or partial fallbacks when it is absent, which only shows up in the container because developer machines have it installed.
