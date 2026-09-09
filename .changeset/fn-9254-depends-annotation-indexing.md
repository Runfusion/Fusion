---
"@runfusion/fusion": patch
---

summary: Align plan step dependency annotations with their numbered headings.
category: fix
dev: `depends` values now name literal `### Step N` headings via `resolveAuthoredStepHeadingOffset`; `json-steps` uses 0-based document indices, while fully-1-based legacy prompts remain unchanged.
