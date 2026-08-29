/*
FNXC:MissionTaskPrefix 2026-07-26-12:00:
Per-mission taskPrefix override (PR #1930 / #2347). Missions may set a letter-led
alphanumeric prefix used when triaging features into tasks; NULL means inherit
the project-wide settings.taskPrefix. Additive only — no backfill.
Renumbered to 0037 after main claimed 0031–0036 (workflow continuations through
chat session tags). Existing databases that already applied 0000–0036 must receive
this column via an independent version so upgrade paths cannot skip it.
*/

DO $$
BEGIN
  IF to_regclass('project.missions') IS NOT NULL THEN
    ALTER TABLE project.missions
      ADD COLUMN IF NOT EXISTS task_prefix text;
  END IF;
END
$$;
