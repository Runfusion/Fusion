---
"@runfusion/fusion": patch
---

Fix Claude dashboard OAuth on remote hosts by using the pasted authorization-code flow instead of callback URL rewriting, while preserving callback proxy behavior for providers that still require it.