---
"@runfusion/fusion": patch
---

summary: Deliver enabled plugin skills in dashboard chat the same way task sessions do (include skill body paths).
category: fix
dev: Chat and room-responder sessions now forward buildSessionSkillContextSync.additionalSkillPaths into createResolvedAgentSession so the pi loader can discover plugin SKILL.md bodies (GitHub #2364 / FN-8443; completes chat half of #2017).
