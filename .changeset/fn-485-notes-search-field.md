---
"@runfusion/fusion": patch
---

summary: Notes and Whiteboard search is now one clean field with the magnifier and hint inside it.
category: fix
dev: Adds the shared tokenized `search-field`/`search-field-icon`/`search-field-input` primitive in `packages/dashboard/app/styles.css`, extracted from the header search contract, and replaces every use of the never-defined `sr-only` class with the existing `visually-hidden` utility (a source census test blocks its return).
