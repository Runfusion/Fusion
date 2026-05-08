# WhatsApp Chat Plugin

WhatsApp Web (Baileys) bridge for Fusion. It pairs with your phone (QR or pairing code), keeps a background connection alive, forwards inbound direct text messages to a Fusion AI session, and sends the assistant reply back to WhatsApp.

No Meta Cloud app, webhook URL, verify token, or Graph API credentials are required.

## Setup

1. Enable/install the plugin in Plugin Manager.
2. Configure `allowedSenders` (empty means **nobody is allowed**).
3. Choose `pairingMode`:
   - `qr` (default): fetch QR from `/api/plugins/fusion-plugin-whatsapp-chat/qr` and scan in WhatsApp.
   - `code`: set `pairingPhoneNumber` (E.164 digits without `+`) and request code via `/pair-code`.
4. Confirm `/status` reports `connected`.

## Settings

- `pairingMode`: `qr` or `code`.
- `pairingPhoneNumber`: E.164 digits without `+` (used for `code` mode).
- `allowedSenders`: allowed WhatsApp JIDs or E.164 digits.
- `agentSystemPrompt`: system prompt for replies.
- `historyTurnLimit`: persisted turn window (default `40`).

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

- Stuck `awaiting-qr`: fetch a fresh QR and scan promptly.
- `loggedOut`: call `/logout` (or wait for clear) and re-pair.
- Pair code not generated: ensure `pairingPhoneNumber` is E.164 digits without `+`.
- No replies: check `allowedSenders`; empty list blocks all inbound messages by design.

## Compliance warning

Baileys is an unofficial WhatsApp Web protocol client. Use may violate WhatsApp Terms of Service. This plugin is intended for self-hosted, single-user use at your own risk.
