---
"@runfusion/fusion": patch
---

`fn serve` and `fn daemon` now auto-register the current directory as a Fusion project on first run, fixing the `No engine started for the current project — exiting` failure in CI/Docker/cron/headless environments. Pass `--no-auto-register` to preserve the previous strict behavior.
