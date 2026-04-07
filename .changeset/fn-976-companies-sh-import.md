---
"@gsxdsm/fusion": minor
---

Add companies.sh agent import support. Parse shell-script-based company manifests
and import agents via CLI (fn agent import <file> --dry-run --skip-existing)
and dashboard API (POST /agents/import).
