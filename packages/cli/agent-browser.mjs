#!/usr/bin/env node

/*
FNXC:AgentBrowserPackaging 2026-07-22-12:19:
Publish this top-level bin shim with Fusion so npm can expose agent-browser and
delegate to the pinned dependency's platform-aware launcher.
*/
/*
 * FNXC:CliAwaitLiveness 2026-08-11-09:17:
 * This delegation intentionally retains top-level await. Replacing it with a
 * forced successful exit could hide an unsettled delegated command and truncate
 * its long-running process; the FN-8954 fix belongs in the stranded operation.
 */
await import("agent-browser/bin/agent-browser.js");
