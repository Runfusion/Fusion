---
"@runfusion/fusion": patch
---

summary: Fix Docker image build failing on memory and first-run container startup failing on volume permissions.
category: fix
dev: Builder runs `pnpm build` with `NODE_OPTIONS=--max-old-space-size=6144` (dashboard vite build OOMed at V8's default old-space on a stock 8GB Docker Desktop VM, exit 134). Runner pre-creates `/home/node/.fusion` owned by `node` so a fresh named volume inherits ownership and embedded Postgres `initdb` succeeds; bind mounts still require a host-side `chown -R 1000:1000`. Also drops the dependency-graph plugin's stale `taskStuck` tsconfig path mapping.
