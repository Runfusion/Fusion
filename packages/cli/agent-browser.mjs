#!/usr/bin/env node

/*
FNXC:AgentBrowserPackaging 2026-07-22-12:19:
Publish this top-level bin shim with Fusion so npm can expose agent-browser and
delegate to the pinned dependency's platform-aware launcher.
*/
await import("agent-browser/bin/agent-browser.js");
