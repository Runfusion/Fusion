---
"@runfusion/fusion": patch
---

Fix Fusion desktop (Electron) packaged builds opening a blank window — or no window at all — on macOS. `run()` is now invoked in packaged builds (where `process.argv[1]` is unset by Electron), and the dashboard client is built with a relative `--base ./` so its `file://`-loaded `index.html` can resolve `./assets/*` from inside the asar.
