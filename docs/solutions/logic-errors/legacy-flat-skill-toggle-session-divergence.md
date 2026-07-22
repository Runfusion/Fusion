---
title: "Legacy flat skill-toggle keys silently suppressed categorized session skills"
date: 2026-07-21
category: docs/solutions/logic-errors
module: engine (session skill resolver)
problem_type: logic_error
component: path_identity
symptoms:
  - "The Skills view showed a categorized plugin skill enabled while agent sessions omitted it."
  - "Deleting a stale flat `-name/SKILL.md` settings entry restored the skill to the session manifest."
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - skill-resolver
  - skill-settings
  - skills-adapter
tags:
  - skills
  - settings
  - plugin-skills
  - path-identity
  - session-manifest
  - legacy-settings
---

# Legacy flat skill-toggle keys silently suppressed categorized session skills

## Problem

Project skill toggles are persisted as signed paths such as `-api/api-versioning/SKILL.md`. The Skills view resolves those paths relative to a skill body beneath `skills/`, but the session override resolver also accepted a bare skill-name match. After a plugin moved a body from `skills/api-versioning/SKILL.md` to `skills/api/api-versioning/SKILL.md`, an old `-api-versioning/SKILL.md` entry no longer matched the view yet still excluded the session skill because pi exposed `skill.name === "api-versioning"`.

## Solution

Session allow, exclusion, and disabled-diagnostic matching now use the same canonical identity as the Skills view: the complete body-relative path beneath the final `skills/` segment. Absolute patterns continue to match exact file paths. A flat `name/SKILL.md` pattern remains compatible only when the discovered body path is itself flat; it cannot match a categorized `category/name/SKILL.md` body merely by sharing the final directory name.

## Prevention

- Treat stored setting keys as identities, not labels: compare the complete normalized path at every reader.
- When a layout changes, test every reader of the persisted key, including session assembly and diagnostics, not only the UI display.
- Preserve legacy compatibility only where the legacy key still identifies the current on-disk path; otherwise ignore it consistently rather than allowing one reader to honor it.
