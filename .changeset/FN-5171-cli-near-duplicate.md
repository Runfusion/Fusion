---
"@runfusion/fusion": patch
---

Layer FN-5152's near-duplicate intent guard onto the CLI `fn task create`
direct-store path. Aligned thresholds (≥2 shared high-signal tokens AND
title-token Jaccard ≥ 0.30 within a 7-day window), `--no-dedup` bypass,
`source.sourceMetadata.intentSignature` stamping, and fail-open semantics
match the dashboard `POST /api/tasks` gate. Non-TTY runs refuse with exit
1; TTY runs prompt before creating. GitHub-import and AI-planning paths
intentionally skip the gate (FN-5060 contract).
