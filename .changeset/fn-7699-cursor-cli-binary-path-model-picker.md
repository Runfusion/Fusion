---
"@runfusion/fusion": patch
---

summary: The Cursor CLI binary path override now also applies to the model picker, not just sign-in/status.
category: fix
dev: /api/models reads globalSettings.cursorCliBinaryPath (trim/blank→undefined) and threads it as getCursorPickerModels({ binaryPath }) so model-picker discovery spawns the same machine-local cursor-agent used by auth/probe/status. Blank/undefined preserves PATH auto-detection. Follow-up to FN-7696.
