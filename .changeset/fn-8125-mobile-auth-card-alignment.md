---
"@runfusion/fusion": patch
---

summary: Align mobile Settings provider cards with the section header's left edge.
category: fix
dev: Mobile-only CSS in SettingsModal.css — zero the .auth-panel-body padding-inline and reduce the scoped .auth-panel-body .auth-provider-card / .auth-section-hint / .auth-group-label horizontal inset so auth-panel cards, hint, and group-label share the header gutter; the unscoped .auth-provider-card rule (CustomProvidersSection) is left unchanged.
