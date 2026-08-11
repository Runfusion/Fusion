---
"@runfusion/fusion": patch
---

summary: Make the Agents Overview Active Agents list scrollable on mobile.
category: fix
dev: Overview bar now participates in the Agents flex height chain with a touch scroll owner so long active-agent lists are not clipped; covered by a Chromium browser-layout smoke assertion mirroring the production DOM chain.
