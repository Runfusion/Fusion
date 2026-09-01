---
"@runfusion/fusion": patch
---

summary: Remote access now reports "running" for a tunnel that survived a restart.
category: fix
dev: `tailscale funnel <port>` registers a FOREGROUND session, so tailscaled files its config under `Foreground.<session-id>` rather than at the top level of `serve status --json`. `detectActiveFunnel` read only the top level, so the funnel Fusion actually spawns was undetectable: a tunnel surviving a supervised restart was never adopted and the status route reported `stopped` with `no_prior_running_marker` while the public URL served 200. Detection now scans foreground sessions as well as the persistent config.
