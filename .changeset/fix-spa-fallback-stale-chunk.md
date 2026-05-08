---
"@runfusion/fusion": patch
---

Stop the dashboard's SPA catch-all from serving `index.html` for missing asset URLs. Stale `/assets/*.js` requests after a rebuild now get a real 404, so the browser surfaces a chunk-load error (which versionCheck recovers from) instead of poisoning the page with a `text/html` module script and reloading into a blank shell.
