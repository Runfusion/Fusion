---
"@runfusion/fusion": patch
---

summary: Fix packaged desktop app crashing on first boot because PostgreSQL migrations were missing from the build.
category: fix
dev: "@fusion/core's bare tsc build never copies src/postgres/migrations/*.sql into dist; the CLI compensates in packages/cli/tsup.config.ts but the desktop staging did not, so packaged Local mode crashed schema init (ENOENT dist/postgres/migrations/0000_initial.sql) after embedded Postgres started. packages/desktop/scripts/workspace-tools.ts now stages the migrations in buildCore(), re-stages them into the pnpm-deploy closure in stageDesktopDeploy(), and fails the build via verifyCoreMigrationsStaged() if the baseline migration is absent. Fixed in 6e5bb5d3d."
