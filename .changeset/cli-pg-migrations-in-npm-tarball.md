---
"@runfusion/fusion": patch
---

summary: Fix npm-installed CLI crashing at startup because PostgreSQL migrations were missing from the published package.
category: fix
dev: "tsup stages packages/core/src/postgres/migrations into dist/migrations, but the package files globs (dist/**/*.js, *.d.ts, maps, named dirs) matched no .sql file, so npm pack stripped every migration from the tarball. Installed CLIs failed schema init with ENOENT dist/migrations/0000_initial.sql and the dashboard supervisor crash-looped. Added dist/migrations/** to files; npm pack --dry-run now lists all 21 migration files. Sibling of the desktop staging fix 6e5bb5d3d."
