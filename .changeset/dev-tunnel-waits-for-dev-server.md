---
"@runfusion/fusion": patch
---

summary: `pnpm dev --tunnel` waits for the dev server instead of publishing a tunnel to whatever holds the configured port.
category: fix
dev: When the dev child had not reported a bound port within 60s the wrapper fell back to `resolveDevTunnelPort(undefined)` (PORT, else 4040) and published that. In a container whose own Fusion owns 4040 — the case the port fix was written for — this handed out a dev-looking URL serving a different instance, and the only signal was a passing "which may not be it" warning. Observed with a dev server stopped on the interactive `Run central db now? (Y/n)` prompt, which never listens and so never reports. The wait is now unbounded (a tunnel is worthless before the server is up) with a once-a-minute notice naming the interactive-prompt case; an explicit `--tunnel=PORT` still publishes immediately, since that names a target the dev child knows nothing about.
