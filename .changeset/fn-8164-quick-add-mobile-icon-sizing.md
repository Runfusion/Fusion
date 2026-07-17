---
"@runfusion/fusion": patch
---

summary: Quick Add action buttons read at a proper size on mobile.
category: fix
dev: Adds a mobile-only (@media max-width:768px) tokenized glyph-size override and tightened horizontal spacing to .quick-entry-actions in QuickEntryBox.css; preserves the 36px touch-target floor and leaves desktop rendering unchanged. Follow-up to FN-8147.
