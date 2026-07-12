---
"@runfusion/fusion": patch
---

summary: Per-project plugin-skill toggles now apply to agent sessions, not just the Skills view.
category: fix
dev: collectPluginSkillNames now resolves effective enablement via the shared @fusion/core resolver (getSkillSettingState), matching discoverSkills; fixes issue #2016 (FN-7858).
