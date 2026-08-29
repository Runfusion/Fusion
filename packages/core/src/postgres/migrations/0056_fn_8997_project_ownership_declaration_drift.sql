/*
FNXC:MultiProjectIsolation 2026-08-12-02:12:
Migration 0006 already establishes project_id ownership and composite keys. FN-8997 adds only idempotent partition-prefixed indexes needed by the newly scoped Drizzle predicates; healthy post-0006 databases require no ownership rewrite.
*/
DO $$
BEGIN
  IF to_regclass('project.workflow_steps') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "idxWorkflowStepsProjectCreatedAt" ON project.workflow_steps(project_id, created_at);
  END IF;
  IF to_regclass('project.chat_room_members') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "idxChatRoomMembersProjectAgentId" ON project.chat_room_members(project_id, agent_id);
  END IF;
  IF to_regclass('project.chat_room_messages') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "idxChatRoomMessagesProjectRoomCreatedAt" ON project.chat_room_messages(project_id, room_id, created_at);
    CREATE INDEX IF NOT EXISTS "idxChatRoomMessagesProjectRoomId" ON project.chat_room_messages(project_id, room_id);
  END IF;
END $$;
