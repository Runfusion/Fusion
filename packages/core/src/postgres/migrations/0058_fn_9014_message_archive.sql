/*
FNXC:MessageArchive 2026-08-12-22:14:
Mailbox archive is the default non-destructive removal action. Existing correspondence remains
visible as non-archived until an operator explicitly archives it, while delete stays available.
*/
DO $$
BEGIN
  IF to_regclass('project.messages') IS NOT NULL THEN
    ALTER TABLE project.messages ADD COLUMN IF NOT EXISTS archived integer DEFAULT 0;
    CREATE INDEX IF NOT EXISTS "idxMessagesToArchived"
      ON project.messages (to_id, to_type, archived);
  END IF;
END $$;
