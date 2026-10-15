---
"@runfusion/fusion": patch
---

summary: Startup banner no longer writes the dashboard bearer token into redirected logs.
category: security
dev: `fn serve` / `fn dashboard` print the launch URL and token raw only when stdout is an interactive terminal; a redirected or piped stream (watchdog script, `nohup`, `systemd`, CI) gets `****<last4>` plus a hint, because that output is persisted and the value is a working operator credential — measured as 175 credential-bearing lines in one production log, one replayed successfully against `POST /api/tasks/:id/bypass-review`. Display-only: `--token`, `$FUSION_DASHBOARD_TOKEN` and `fn daemon --token-only` are unchanged, so nothing locks you out. If you previously ran a non-interactive serve/dashboard, treat the token in that log as exposed and rotate it.
