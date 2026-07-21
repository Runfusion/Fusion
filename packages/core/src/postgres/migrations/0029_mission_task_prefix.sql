/*
FNXC:MissionTaskPrefix 2026-07-14-19:00:
Per-mission taskPrefix override (PR #1930). Missions may set a letter-led
alphanumeric prefix used when triaging features into tasks; NULL means inherit
the project-wide settings.taskPrefix. Additive only — no backfill.
FNXC:MissionTaskPrefix 2026-07-20-12:00:
Renumbered 0028→0029 after main claimed 0028 for durable task declarations.
Existing databases that already applied 0000–0028 must receive this column via
an independent version so upgrade paths cannot skip it.

*/

DO $$
BEGIN
  IF to_regclass('project.missions') IS NOT NULL THEN
    ALTER TABLE project.missions
      ADD COLUMN IF NOT EXISTS task_prefix text;
  END IF;
END
$$;
