---
"@runfusion/fusion": patch
---

Harden CLI onboarding auto-launch backward compatibility by adding an explicit skip when both the central DB and local project DB already exist. This preserves established agent/headless behavior by ensuring non-TTY, `serve`, and `daemon` invocations continue without onboarding prompts or blocking.
