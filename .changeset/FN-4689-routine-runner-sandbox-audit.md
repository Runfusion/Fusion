---
"@runfusion/fusion": patch
---
Routine-runner now threads a `RunAuditor` through `resolveSandboxBackend()` so user-configured routine commands emit `sandbox:prepare`/`sandbox:run`/`sandbox:failure` lifecycle events alongside executor and merger commands, closing the FN-4640 observability gap.
