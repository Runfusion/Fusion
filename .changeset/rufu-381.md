---
"@runfusion/fusion": patch
---

summary: A review gate that dies with no verdict now names the real cause, or says so and shows the re-runs left.
category: fix
dev: The no-verdict failure `output` refuses the bare `failed` status echo as a cause, forwards the session's `error` text onto `node:<id>:error` at the custom-node boundary, and otherwise records `no cause detected (attempt N of 4; automatic re-run budget: R of 3 left)` from `MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS`. `status`, `verdict`, `verdictRequired`, edge routing and failed-gate bypass eligibility are unchanged.
