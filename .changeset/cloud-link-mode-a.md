---
"@runfusion/fusion": minor
---

summary: Add cloud-link Mode A client — pair, heartbeat, and cloudTicket remote-login.
category: feature
dev: New `fn cloud` CLI (`pair-start`, `pair-complete`, `heartbeat`, `status`, `unlink`) and `@fusion/core` cloud-link HTTP client. `/remote-login?cloudTicket=` redeems against a configured cloud HTTP base then issues a short-lived `rt` (or daemon token). Device state in `~/.fusion/cloud-link.json`. Configure via `FUSION_CLOUD_HTTP_URL` or `--http`.
