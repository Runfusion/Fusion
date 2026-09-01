---
"@runfusion/fusion": minor
---

summary: Update Fusion from source in one click — pull, rebuild, and restart from Command Center.
category: feature
dev: New `POST /system/source/update` job (git status/pull --ff-only, pnpm install, workspace build, restart only on build success) plus `sourceUpdateSupported` on `/system/info`. The Docker entrypoint is now a restart supervisor (relaunches on exit 86, forwards signals, stamps `FUSION_SUPERVISOR_PID`) and accepts `--from-source`/`FUSION_FROM_SOURCE` with `FUSION_SOURCE_ROOT` (default `/home/node/fusion`).
