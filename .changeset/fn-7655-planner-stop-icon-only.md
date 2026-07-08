---
"@runfusion/fusion": patch
---

summary: Planner chat stop button now shows just the stop icon, not a text label.
category: fix
dev: StandardChatActionButton gains showStopText (defaults to showSendText); TaskPlannerChatTab sets showStopText={false}. aria-label "Stop generation" retained.
