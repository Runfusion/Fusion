---
"@runfusion/fusion": patch
---

Fix Droid CLI auth/status probing to resolve the effective binary path from plugin settings (including custom `droidBinaryPath`) so Settings no longer reports false "not installed" states when Droid is configured at a non-default path.
