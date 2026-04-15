---
"@gsxdsm/fusion": patch
---

Fix OpenAI Codex login from Settings to succeed when the dashboard is accessed via non-localhost hosts (remote node, LAN host/IP, reverse proxy). The OAuth callback bridge at `/api/auth/openai-codex/callback` rewrites the redirect URI to the active browser host with secure state validation.
