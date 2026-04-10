---
"@gsxdsm/fusion": minor
---

Add daily durable memory pruning to background insight extraction

This change extends the background memory insight extraction to also prune transient content from working memory, keeping it focused on durable items.

**New Features:**
- Memory pruning: Daily extraction now prunes `.fusion/memory.md` to only durable items (Architecture, Conventions, Pitfalls sections)
- Safety validation: Before pruning is applied, candidates are validated to ensure at least 2 of 3 core sections are preserved
- Pruning outcome reporting: Audit reports now include pruning results (applied/skipped, size delta, reason)

**Pruning Behavior:**
- **Preserved**: Architecture, Conventions, Pitfalls sections with durable content
- **Pruned**: Task-specific notes, one-time observations, outdated entries, verbose explanations
- **Validation**: Invalid or malformed prune candidates are safely ignored; existing memory is preserved

**Safety Guarantees:**
- Pruning only applied if validation passes (at least 2 of 3 core sections preserved)
- Malformed AI output never destroys existing memory
- Pruning outcome included in audit reports for operator visibility

**Settings:**
- Same settings as background memory summarization (`insightExtractionEnabled`, `insightExtractionSchedule`)
- No new settings required — pruning is part of the daily extraction workflow
