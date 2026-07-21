---
"@runfusion/fusion": patch
---

summary: Task detail inline action icons now render at a consistent size on tablet screens.
category: fix
dev: Scoped the .detail-meta-inline-controls SVG sizing so every inline-row icon (including nested ProviderIcon SVGs) resolves to the shared --icon-size-sm token at desktop, tablet (769–1024px), and mobile. No handler/behavior changes; preserves the icon-only row, square-box sizing, size-prop-less oversight Eye/EyeOff, and the mobile wrap fallback.
