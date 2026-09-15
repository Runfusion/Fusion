import { describe, expect, it } from "vitest";
import { validateMessageMetadata } from "../types.js";

/*
FNXC:MailboxSubject 2026-09-15-04:40:
Every mail must carry an author and a subject, but `subject` stays optional so legacy persisted
rows and existing system producers remain valid. A declared subject must be a real, bounded string.
*/
describe("validateMessageMetadata subject", () => {
  it("accepts absent metadata, absent subject, and a normal subject", () => {
    expect(() => validateMessageMetadata(undefined)).not.toThrow();
    expect(() => validateMessageMetadata({ subject: "FN-325 completed" })).not.toThrow();
    expect(() => validateMessageMetadata({ kind: "task-completion-notice", taskId: "FN-325" })).not.toThrow();
    expect(() => validateMessageMetadata({ replyTo: { messageId: "m-1" }, wakeRecipient: true })).not.toThrow();
    expect(() => validateMessageMetadata({ subject: "a".repeat(200) })).not.toThrow();
    expect(() => validateMessageMetadata({ subject: `  ${"a".repeat(200)}  ` })).not.toThrow();
  });

  it.each([
    [{ subject: "" }, "metadata.subject must be a non-empty string"],
    [{ subject: "   " }, "metadata.subject must be a non-empty string"],
    [{ subject: 42 }, "metadata.subject must be a non-empty string"],
    [{ subject: { text: "x" } }, "metadata.subject must be a non-empty string"],
    [{ subject: "a".repeat(201) }, "metadata.subject must be at most 200 characters"],
  ])("rejects an invalid subject %#", (metadata, message) => {
    expect(() => validateMessageMetadata(metadata as never)).toThrow(message);
  });
});
