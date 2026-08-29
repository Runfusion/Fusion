---
"@runfusion/fusion": patch
---

summary: Fix HTTPS git clones failing in Docker with "server certificate verification failed".
category: fix
dev: The runner stage installed `git` but not `ca-certificates`, and the slim base ships zero CA certificates. git verifies TLS against the SYSTEM trust store, so every HTTPS clone failed and project setup was impossible in a container. It stayed hidden because Node carries its own bundled CA store — the dashboard, model APIs, and OAuth token exchanges all worked. Guarded by a new assertion in scripts/__tests__/dockerfile-workspace-manifests.test.mjs.
