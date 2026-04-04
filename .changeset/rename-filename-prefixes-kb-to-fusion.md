---
"@gsxdsm/fusion": patch
---

Rename settings export and backup filename prefixes from `kb` to `fusion`. New exports use `fusion-settings-*.json` and new backups use `fusion-*.db`. Existing `kb-*` backup files remain discoverable for listing, restoration, and cleanup.
