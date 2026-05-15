---
"@runfusion/fusion": patch
---

Fix Missions UI false "No assertions defined" signal on milestones whose child features already have populated acceptance criteria. The milestone view now rolls up feature-level `acceptanceCriteria` as read-only "Completion criteria (from features)" when no structured `MissionContractAssertion` rows exist; the empty-state nudge is preserved only for milestones with no completion criteria at any level.
