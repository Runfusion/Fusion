---
"@runfusion/fusion": minor
---

summary: New `pnpm dev --tunnel` publishes a dev server through a Cloudflare quick tunnel and prints the URL.
category: feature
dev: Adds `--tunnel` / `--tunnel=PORT` (and `FUSION_DEV_TUNNEL`/`FUSION_DEV_TUNNEL_PORT`) to the dev wrapper, plus `scripts/lib/dev-tunnel.mjs`. Port defaults to `PORT` or 4040 via `resolveDevTunnelPort`. Quick tunnels are viable here because a dev server is HTTP — TCP endpoints would need a card (ngrok) or a domain plus Zero Trust (Cloudflare). Tunnel failure is non-fatal, watch-mode restarts reuse the existing tunnel so a shared link stays valid, and `--tunnel` consumes a following token only when numeric so `--tunnel dashboard` still forwards its argument. Documented in docs/contributing.md.
