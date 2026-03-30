---
"@dustinbyrne/kb": patch
---

Remove automatic browser-opening behavior on dashboard startup

The dashboard no longer automatically opens a browser window when starting. Users must manually navigate to the URL shown in the console output. The `--no-open` flag has been removed as it is now the default behavior.
