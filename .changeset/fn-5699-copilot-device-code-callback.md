---
"@runfusion/fusion": patch
---

Fix dashboard OAuth login for `github-copilot` when upstream auth storage invokes device-code callbacks. The `/api/auth/login` route now provides the expected callback wiring and preserves `deviceCode: { userCode, verificationUri }` in responses so Copilot login no longer crashes with `options.onDeviceCode is not a function`.
