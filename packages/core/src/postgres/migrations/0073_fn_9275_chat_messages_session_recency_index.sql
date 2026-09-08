CREATE INDEX IF NOT EXISTS "idxChatMessagesSessionCreatedAtId"
  ON project.chat_messages USING btree ("session_id", "created_at" DESC, "id" DESC);
