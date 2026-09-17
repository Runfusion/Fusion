import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { Message } from "@fusion/core";
import { resolveMailboxMessageSubject } from "../mailboxSubject";

/*
FNXC:MailboxSubject 2026-09-15-04:40:
Locks the precedence table of the single shared subject resolver so no mailbox surface can drift
back to rendering the raw Markdown head of the body.
*/

// Minimal translation stub mirroring i18next default-value + interpolation behavior.
const t = ((key: string, defaultValue?: string, options?: Record<string, unknown>) => {
  let out = defaultValue ?? key;
  if (options) {
    for (const [name, value] of Object.entries(options)) {
      out = out.replaceAll(`{{${name}}}`, String(value));
    }
  }
  return out;
}) as unknown as TFunction<"app">;

const message = (content: string, metadata?: Message["metadata"]): Pick<Message, "content" | "metadata"> => ({
  content,
  metadata,
});

describe("resolveMailboxMessageSubject", () => {
  it("prefers an explicit subject over a known kind", () => {
    const resolved = resolveMailboxMessageSubject(
      message("## Task completed: FN-325\n\nDelivered the unified mail.", {
        subject: "Handover ready",
        kind: "task-completion-notice",
        taskId: "FN-325",
      }),
      t,
    );
    expect(resolved).toEqual({ subject: "Handover ready", source: "explicit", bodyPreview: "Delivered the unified mail." });
  });

  it("ignores a blank explicit subject and falls back to derivation", () => {
    const resolved = resolveMailboxMessageSubject(
      message("## Task completed: FN-325\n\nDelivered.", { subject: "   ", kind: "task-completion-notice", taskId: "FN-325" }),
      t,
    );
    expect(resolved.subject).toBe("FN-325 completed");
    expect(resolved.source).toBe("kind");
  });

  it("derives a localized subject from a task completion notice", () => {
    const resolved = resolveMailboxMessageSubject(
      message("## Task completed: FN-325\n\nDelivered the unified mail.", { kind: "task-completion-notice", taskId: "FN-325" }),
      t,
    );
    expect(resolved.subject).toBe("FN-325 completed");
    expect(resolved.source).toBe("kind");
    expect(resolved.bodyPreview).toBe("Delivered the unified mail.");
    expect(resolved.subject).not.toContain("##");
    expect(resolved.bodyPreview).not.toContain("##");
  });

  it("derives a Markdown-free subject from the body when there is no metadata", () => {
    const resolved = resolveMailboxMessageSubject(message("## Task completed: FN-325\n\nDelivered the unified mail."), t);
    expect(resolved).toEqual({
      subject: "Task completed: FN-325",
      source: "content",
      bodyPreview: "Delivered the unified mail.",
    });
  });

  it("falls back to the body when a known kind lacks its required data", () => {
    expect(resolveMailboxMessageSubject(message("Task done", { kind: "task-completion-notice" }), t).source).toBe("content");
    expect(resolveMailboxMessageSubject(message("Proposal", { kind: "task-proposal" }), t).source).toBe("content");
    expect(resolveMailboxMessageSubject(message("Anything", { kind: "unknown-kind" }), t).source).toBe("content");
  });

  it("derives subjects from the other known notice kinds", () => {
    expect(resolveMailboxMessageSubject(message("body", { kind: "task-wedge", taskId: "FN-7" }), t).subject).toBe("FN-7 needs attention");
    expect(resolveMailboxMessageSubject(message("body", { kind: "triage-duplicate-decision", taskId: "FN-8" }), t).subject).toBe("FN-8 duplicate decision");
    expect(resolveMailboxMessageSubject(message("body", { kind: "planning-clarification" }), t).subject).toBe("Planning clarification");
    expect(resolveMailboxMessageSubject(message("body", { kind: "task-recommendation-notice" }), t).subject).toBe("Task recommendations");
    expect(
      resolveMailboxMessageSubject(
        message("body", { kind: "task-proposal", proposedTask: { title: "Add coverage", description: "d" } }),
        t,
      ).subject,
    ).toBe("Task proposal: Add coverage");
  });

  it("uses the report title for a structural report mail", () => {
    const resolved = resolveMailboxMessageSubject(
      message("## Weekly brief\n\nEverything landed.", {
        mailKind: "report",
        report: { title: "Weekly brief", sections: [{ heading: "Summary", body: "Everything landed." }] },
      }),
      t,
    );
    expect(resolved.subject).toBe("Weekly brief");
    expect(resolved.source).toBe("report");
    expect(resolved.bodyPreview).toBe("Everything landed.");
  });

  it("strips inline emphasis from the subject and keeps the rest of the body as preview", () => {
    const resolved = resolveMailboxMessageSubject(message("**FN-1 needs operator action**\n\nRaison"), t);
    expect(resolved.subject).toBe("FN-1 needs operator action");
    expect(resolved.subject).not.toContain("**");
    expect(resolved.bodyPreview).toBe("Raison");
  });

  it("returns the fallback label for an empty or marker-only body", () => {
    for (const content of ["", "   \n\n  ", "##\n\n> \n- "]) {
      const resolved = resolveMailboxMessageSubject(message(content), t);
      expect(resolved).toEqual({ subject: "(no subject)", source: "fallback", bodyPreview: "" });
    }
  });

  it("returns an empty preview when the body is a single line", () => {
    expect(resolveMailboxMessageSubject(message("Only one line"), t).bodyPreview).toBe("");
  });

  it("truncates long subjects and previews to a single display line", () => {
    const long = "a".repeat(120);
    const resolved = resolveMailboxMessageSubject(message(`${long}\n\n${long}`), t);
    expect(resolved.subject).toBe(`${"a".repeat(80)}…`);
    expect(resolved.bodyPreview).toBe(`${"a".repeat(80)}…`);
  });
});
