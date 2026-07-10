---
"@runfusion/fusion": patch
---

summary: Fix misaligned padding on the Cursor CLI authentication card.
category: fix
dev: Wraps `CursorCliProviderCard`'s compact status line + binary-path control in a padded `.cursor-cli-provider-card__body` to match the header inset, mirroring the Claude CLI card's `.auth-provider-cli-details-body`.
