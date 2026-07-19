/*
FNXC:MissionTaskPrefix 2026-07-14-19:00:
Per-mission taskPrefix override (PR #1930). Missions may set a letter-led
alphanumeric prefix used when triaging features into tasks; NULL means inherit
the project-wide settings.taskPrefix. Additive only — no backfill.
FNXC:MissionTaskPrefix 2026-07-19-12:55:
Renumbered 0026→0028 after main claimed 0026 (bigint counters) and 0027
(workflow IR pin). Existing databases that already applied 0000–0027 must
receive this column via an independent version so upgrade paths cannot skip it.

*/

DO $$
BEGIN
  IF to_regclass('project.missions') IS NOT NULL THEN
    ALTER TABLE project.missions
      ADD COLUMN IF NOT EXISTS task_prefix text;
  END IF;
END
$$;
