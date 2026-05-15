---
"@runfusion/fusion": minor
---

Fix Google Generative AI custom provider not saving after model detection. The probe endpoint accepted `google-generative-ai` but create/update routes rejected it. Also adds SSRF protection, body validation, and fixes stale type mappings.
