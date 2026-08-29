# WhatsApp Chat Plugin

WhatsApp Web (Baileys) bridge for Fusion. It pairs with your phone (QR or pairing code), keeps a background connection alive, forwards inbound direct text messages to a Fusion AI session, and sends the assistant reply back to WhatsApp.

No Meta Cloud app, webhook URL, verify token, or Graph API credentials are required.

## Setup

1. Enable/install the plugin, then open **Settings → Plugins → Fusion Plugins → WhatsApp Chat**.
2. Use the pairing panel at the top of the plugin settings. It shows live connection status and, in QR mode, a QR code to scan from WhatsApp **Linked devices**.
3. Configure `allowedSenders` (empty means **nobody is allowed**).
4. Choose `pairingMode`:
   - `qr` (default): scan the in-settings QR code in WhatsApp.
   - `code`: set `pairingPhoneNumber` (E.164 digits without `+`) and use **Request pairing code** in the settings panel.
5. Wait for the panel to report `connected`. Use **Logout / re-pair** to start a fresh pairing session; if a QR is still pending, refresh or wait for a new one.

## Settings

- `pairingMode`: `qr` or `code`.
- `pairingPhoneNumber`: E.164 digits without `+` (used for `code` mode).
- `allowedSenders`: allowed WhatsApp JIDs or E.164 digits.
- `agentSystemPrompt`: system prompt for replies.
- `historyTurnLimit`: persisted turn window (default `40`).
- `dedupeRetentionDays`: replay-protection retention window for inbound message IDs (default `7` days). Rows older than this are pruned lazily whenever a new inbound message is processed.

## Routes

- `GET /api/plugins/fusion-plugin-whatsapp-chat/status`
- `GET /api/plugins/fusion-plugin-whatsapp-chat/qr`
- `POST /api/plugins/fusion-plugin-whatsapp-chat/pair-code`
- `POST /api/plugins/fusion-plugin-whatsapp-chat/logout`

## Storage and lifecycle

- Starts socket on `onLoad`, stops on `onUnload`.
- Persists transcript and dedupe state in:
  - `whatsapp_chat_sessions`
  - `whatsapp_chat_dedupe`
- Persists Baileys auth state in:
  - `whatsapp_auth_creds`
  - `whatsapp_auth_keys`
- After restart, plugin reconnects automatically when auth is valid.

## Troubleshooting

- Stuck `awaiting-qr`: use **Refresh status** in the plugin settings panel and scan the newly displayed QR promptly.
- Need to re-pair: use **Logout / re-pair** in plugin settings; it starts a fresh QR or code pairing session.
- Pair code not generated: ensure `pairingPhoneNumber` is E.164 digits without `+`, then use **Request pairing code** in the settings panel.
- No replies: check `allowedSenders`; empty list blocks all inbound messages by design.

## Compliance warning

Baileys is an unofficial WhatsApp Web protocol client. Use may violate WhatsApp Terms of Service. This plugin is intended for self-hosted, single-user use at your own risk.
