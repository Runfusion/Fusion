---
"@runfusion/fusion": patch
---

summary: Make Grok CLI chat replies reliable by using the stable headless JSON response.
category: fix
dev: Grok runtime now invokes `grok -p <prompt> --output-format json` and diagnoses empty non-EndTurn results.
