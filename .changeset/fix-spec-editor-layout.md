---
"@dustinbyrne/kb": patch
---

Fix SpecEditor layout to fill available modal space

- Added CSS styles for `.spec-editor` component with flex layout
- Removed hardcoded `rows={20}` from textarea in favor of CSS-based sizing
- Toolbar stays fixed at top while content scrolls
- AI revision section stays at bottom
- Added responsive styles for mobile viewports
