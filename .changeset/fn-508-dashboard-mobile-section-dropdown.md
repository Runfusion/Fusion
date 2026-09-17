---
"@runfusion/fusion": patch
---

summary: Dashboard on phones keeps a fixed header with a full-width section drop list instead of a back arrow.
category: feature
dev: CommandCenter drops its mobilePane state and backAction; the phone section strip reuses CommandCenterSectionNav's dropdown variant with the new `fullWidth` flag in the shared ViewLayout tabs zone.
