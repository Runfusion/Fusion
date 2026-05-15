---
"@runfusion/fusion": patch
---

Fix GitHub Copilot OAuth login hanging in Settings and Onboarding. The dashboard now auto-answers the enterprise-domain prompt (defaulting to github.com) and surfaces the device user code + verification URL so users can complete the device-code flow end to end.
