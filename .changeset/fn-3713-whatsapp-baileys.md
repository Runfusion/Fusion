---
"@runfusion/fusion": minor
---

WhatsApp Chat plugin now connects via the WhatsApp Web multi-device protocol (Baileys) with QR / pairing-code setup instead of Meta Cloud API webhooks. Removes the verifyToken / appSecret / accessToken / phoneNumberId / graphApiVersion settings and webhook routes; adds /status, /qr, /pair-code, and /logout plugin routes. Existing installs must re-pair after upgrade.
