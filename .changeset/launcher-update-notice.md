---
"runfusion.ai": patch
---

Surface "new version available" notices to users who run `npx runfusion.ai` without ever opening the dashboard. The launcher now reads the existing `~/.fusion/update-check.json` cache (written by the dashboard's update-check service) and prints a one-line stderr notice when a newer Fusion is published. When the cache is missing or older than 24h, a fire-and-forget fetch against the npm registry refreshes it (1.5s timeout) so non-dashboard users still pick up updates on their next run. Disable with `FUSION_NO_UPDATE_CHECK=1`; auto-skipped in CI and non-TTY contexts.
