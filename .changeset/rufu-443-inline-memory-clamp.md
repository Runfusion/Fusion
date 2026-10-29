---
"@runfusion/fusion": patch
---

summary: Agents now get their newest long-term memory entries and are told when part is left out.
category: fix
dev: The inline memory clamp in `formatMemorySection` is order-aware — it keeps the newest `## ` sections (or the tail of a heading-less file) instead of the oldest — and announces every omission inside the rendered `## Agent Memory` section with omitted section/character counts and the `fn_memory_search` / `fn_memory_get` retrieval path. `MAX_MEMORY_LENGTH` (50,000 chars) and `MEMORY_LONG_TERM_BYTE_BUDGET` (32 KiB) are unchanged; their relationship is now documented in `docs/memory-plugin-contract.md` §1.2/§1.5. The chat path's bounded-index branch (`memoryCapChars`) keeps its existing self-announcing contract.
