---
"@runfusion/fusion": patch
---

summary: Remote Access now labels a Cloudflare tunnel URL correctly instead of calling it a Tailnet URL.
category: fix
dev: RemoteSection derives the share-block label from remoteStatus.provider; adds settings.remote.cloudflareTunnelURL and settings.remote.tunnelURL.
