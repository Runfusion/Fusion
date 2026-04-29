---
"@runfusion/fusion": patch
"runfusion.ai": patch
"@fusion/core": patch
"@fusion/dashboard": patch
"@fusion/desktop": patch
"@fusion/engine": patch
"@fusion/mobile": patch
"@fusion/pi-claude-cli": patch
"@fusion/plugin-sdk": patch
---

Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
