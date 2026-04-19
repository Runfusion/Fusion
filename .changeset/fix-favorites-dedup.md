---
"@gsxdsm/fusion": patch
---

Fix: Remove duplicate model entries in CustomModelDropdown favorites list

Favorited models were appearing twice in the dropdown - once in the favorites
section at the top, and again in their provider group. Now favorited models
only appear in the favorites section, eliminating the duplicate FireworksAI
(or any provider) section when models are favorited.
