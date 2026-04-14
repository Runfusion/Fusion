---
"@gsxdsm/fusion": patch
---

Make memory instruction injection backend-aware for the triage and executor prompts. Behavior now branches correctly based on `memoryBackendType` setting:
- `file` backend → includes `.fusion/memory.md` read/write guidance
- `readonly` backend → read-only wording without write/update directives  
- `qmd`/non-file backends → generic instructions without unconditional `.fusion/memory.md` reference

The `resolveMemoryInstructionContext()` function provides backend metadata for instruction generation. Backward compatible: omitting `memoryBackendType` or using unknown types falls back to file-style output with explicit path.
