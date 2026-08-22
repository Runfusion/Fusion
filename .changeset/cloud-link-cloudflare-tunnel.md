---
"@runfusion/fusion": minor
---

summary: Linked Fusion instances start a Cloudflare tunnel and keep Cloud Link updated when the URL changes.
category: feature
dev: `fn serve` / `fn dashboard` provision `cloudflared tunnel --url` to the bound dashboard port and heartbeat candidates (including host rotations) every 20s. `fn cloud heartbeat` without `--url` does the same until Ctrl+C.
