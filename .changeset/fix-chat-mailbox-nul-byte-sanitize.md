---
"@runfusion/fusion": patch
---

summary: Fix a crash where chat messages and mailbox sends containing a raw NUL byte would abort mid-conversation.
category: fix
dev: PostgreSQL text/jsonb columns reject U+0000 outright ("unsupported Unicode escape sequence" / "\u0000 cannot be converted to text"). Tool output piped into a chat message or agent mailbox send could carry a literal NUL byte and crash addChatMessage/addChatRoomMessage/sendMessage with an uncaught PostgresError. Extracted the existing stripNulChars/deepStripNulChars sanitizer (previously only used by the one-time SQLite migration) into a shared packages/core/src/postgres/nul-sanitize.ts module and wired it into all three live write paths. Also fixes a related embedded-Postgres startup race (JoinedInstanceUnreachableError) where a joiner could hit ECONNREFUSED before the owning process's listener was ready; now retried once, mirroring the existing NonUtf8EmbeddedClusterError retry pattern.
