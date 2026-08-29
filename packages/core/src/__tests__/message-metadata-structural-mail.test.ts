import { describe, expect, it } from "vitest";
import { validateMessageMetadata } from "../types.js";

describe("validateMessageMetadata structural mail", () => {
  it("accepts absent, legacy, report, approval, and mail-kind-only metadata", () => {
    expect(() => validateMessageMetadata(undefined)).not.toThrow();
    expect(() => validateMessageMetadata({ replyTo: { messageId: "m-1" }, wakeRecipient: true, nativeStructures: [{ kind: "mission", id: "M-1" }], kind: "task-proposal", proposedTask: { title: "Title", description: "Description" }, proposalIdempotencyKey: "proposal-1" })).not.toThrow();
    expect(() => validateMessageMetadata({ mailKind: "report", report: { title: "Brief", sections: [{ heading: "Summary", body: "Ready" }] } })).not.toThrow();
    expect(() => validateMessageMetadata({ mailKind: "approval", approvalRequestId: "approval-1" })).not.toThrow();
    expect(() => validateMessageMetadata({ mailKind: "message" })).not.toThrow();
  });

  it.each([
    [{ mailKind: "other" }, "metadata.mailKind"],
    [{ report: "bad" }, "metadata.report must be an object"],
    [{ report: { title: " ", sections: [{ heading: "H", body: "B" }] } }, "metadata.report.title"],
    [{ report: { title: "T", sections: "bad" } }, "metadata.report.sections must be an array"],
    [{ report: { title: "T", sections: [] } }, "metadata.report.sections must not be empty"],
    [{ report: { title: "T", sections: [{ body: "B" }] } }, "metadata.report.sections[].heading"],
    [{ report: { title: "T", sections: [{ heading: "H", body: " " }] } }, "metadata.report.sections[].body"],
    [{ approvalRequestId: " " }, "metadata.approvalRequestId"],
  ])("rejects malformed structural mail %#", (metadata, message) => {
    expect(() => validateMessageMetadata(metadata as never)).toThrow(message);
  });
});
