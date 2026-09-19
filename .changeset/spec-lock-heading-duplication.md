---
"@runfusion/fusion": patch
---

summary: Approved plans are no longer rejected by equivalent headings or by headings inside code fences.
category: fix
dev: Spec-lock canonicalization now reads level-2 headings only outside balanced code fences (backtick or tilde, up to three leading spaces) and falls back to the previous fence-blind declaration set on an unterminated fence; SPEC_LOCK_PARSER_VERSION is bumped to 2 so retained evidence distinguishes the two scans. Distinct alias spellings still merge and a repeated exact heading outside fences is still refused.
