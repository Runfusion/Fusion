---
"@gsxdsm/fusion": patch
---

Fix terminal failing to initialize on first page load with MIME type error. The terminal now automatically retries dynamic xterm.js imports when the server returns an HTML response instead of JavaScript.
