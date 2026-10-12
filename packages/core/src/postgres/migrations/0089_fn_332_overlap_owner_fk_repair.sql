/*
FNXC:OverlapWait 2026-09-21-09:55:
Upstream b1db055c27 hardened the task_overlap_waits owner FK (ON UPDATE CASCADE + DEFERRABLE);
this line applied its overlap-wait table long ago via 0075, whose original FK is neither cascade
on update nor deferrable. Project-partition promotion refuses such FKs (unsafe-fk-update-graph),
so repair databases that already applied the original 0075. Mirrors upstream's repair block that
piggybacked on their 0085 (not applied on this line).
*/
DO $$
BEGIN
  IF to_regclass('project.task_overlap_waits') IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_task_overlap_wait_owner'
      AND conrelid = 'project.task_overlap_waits'::regclass
      AND (confupdtype <> 'c' OR NOT condeferrable)
  ) THEN
    ALTER TABLE project.task_overlap_waits DROP CONSTRAINT fk_task_overlap_wait_owner;
    ALTER TABLE project.task_overlap_waits ADD CONSTRAINT fk_task_overlap_wait_owner
      FOREIGN KEY (project_id, task_id) REFERENCES project.tasks(project_id, id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
