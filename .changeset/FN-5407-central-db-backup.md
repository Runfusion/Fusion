---
"@runfusion/fusion": minor
---

`fn backup` now also snapshots the central database (`~/.fusion/fusion-central.db`)
alongside the per-project database. Scheduled and manual backups produce a paired
`fusion-central-<timestamp>.db` file in `.fusion/backups/`; `fn backup --list`,
`--cleanup`, and `--restore` operate on the pair. Restoring a `fusion-central-*`
file restores only the central DB. A missing central DB is skipped silently and
does not fail the project backup.
