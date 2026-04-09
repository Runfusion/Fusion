---
"@gsxdsm/fusion": minor
---

Add background memory summarization and audit processing

This change introduces real-time background processing that automatically extracts and audits project memory insights on a configurable schedule.

**New Features:**
- Background insight extraction: AI-powered analysis of `.fusion/memory.md` to distill insights into `.fusion/memory-insights.md`
- Audit reports: Automatic generation of `.fusion/memory-audit.md` after each extraction run
- Runtime wiring: Both `fn dashboard` and `fn serve` now sync and process insight extraction automation

**Files Generated:**
- `.fusion/memory-insights.md` — Long-term distilled insights (categories: Patterns, Principles, Conventions, Pitfalls, Context)
- `.fusion/memory-audit.md` — Human-readable audit report with health checks

**Settings:**
- `insightExtractionEnabled` — Enable/disable scheduled extraction
- `insightExtractionSchedule` — Cron expression for extraction timing
- `insightExtractionMinIntervalMs` — Minimum interval between extractions

**Safety:**
- Working memory (.fusion/memory.md) is never overwritten
- Malformed AI output preserves existing insights
- Post-processing failures are isolated and logged
