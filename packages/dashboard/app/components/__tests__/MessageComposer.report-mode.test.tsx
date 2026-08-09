import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageComposer } from "../MessageComposer";
import { sendMessage } from "../../api";

vi.mock("../../api", () => ({ sendMessage: vi.fn(), fetchNativeStructurePreview: vi.fn() }));
vi.mock("../NativeStructurePreview", () => ({ NativeStructurePreview: () => null }));
vi.mock("../ComposeChatPanel", () => ({
  ComposeChatPanel: ({ onUseDraft }: { onUseDraft: (draft: string) => void }) => (
    <div data-testid="compose-chat-panel">
      <button type="button" data-testid="compose-chat-use-draft" onClick={() => onUseDraft("AI report draft")}>Use draft</button>
    </div>
  ),
}));

const agent = { id: "agent-1", name: "Agent", role: "executor", state: "idle", createdAt: "2026-01-01", updatedAt: "2026-01-01", metadata: {} } as any;

describe("MessageComposer report mode", () => {
  it("keeps quick mode structurally unchanged and mounts report controls only on demand", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<MessageComposer agents={[agent]} onSend={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId("report-title")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("message-composer-mode-report"));
    expect(screen.getByTestId("report-title")).toBeInTheDocument();
    expect(screen.getByTestId("compose-chat-panel")).toBeInTheDocument();
    await user.click(screen.getByTestId("message-composer-mode-quick"));
    expect(screen.queryByTestId("report-title")).not.toBeInTheDocument();
  });

  it("keeps a Quick message metadata-free", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(sendMessage).mockResolvedValue({} as any);
    render(<MessageComposer agents={[agent]} onSend={vi.fn()} onCancel={vi.fn()} />);
    await user.selectOptions(screen.getByTestId("message-composer-recipient"), "agent-1");
    await user.type(screen.getByTestId("message-composer-content"), "Quick note");
    await user.click(screen.getByTestId("message-composer-send"));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "Quick note" }), undefined);
    expect((vi.mocked(sendMessage).mock.calls[0][0] as { metadata?: unknown }).metadata).toBeUndefined();
  });

  it("rejects empty and incomplete report sections before sending", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(sendMessage).mockReset();
    vi.mocked(sendMessage).mockResolvedValue({} as any);
    render(<MessageComposer agents={[agent]} initialMode="report" onSend={vi.fn()} onCancel={vi.fn()} />);
    await user.selectOptions(screen.getByTestId("message-composer-recipient"), "agent-1");
    await user.type(screen.getByTestId("report-title"), "Status");
    await user.type(screen.getByTestId("message-composer-content"), "Body");
    await user.click(screen.getByTestId("message-composer-send"));
    expect(screen.getByTestId("message-composer-error")).toHaveTextContent("A report needs at least one section");
    expect(sendMessage).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("report-section-add"));
    await user.type(screen.getByTestId(/report-section-heading-/), "Only heading");
    await user.click(screen.getByTestId("message-composer-send"));
    expect(screen.getByTestId("message-composer-error")).toHaveTextContent("Every report section needs a heading and a body");
    expect(sendMessage).not.toHaveBeenCalled();
    await user.type(screen.getByTestId(/report-section-body-/), "Everything is ready");
    await user.click(screen.getByTestId("message-composer-send"));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { mailKind: "report", report: { title: "Status", sections: [{ heading: "Only heading", body: "Everything is ready" }] } },
    }), undefined);
  });

  it("preserves a typed section while rows are added and removed", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<MessageComposer agents={[agent]} initialMode="report" onSend={vi.fn()} onCancel={vi.fn()} />);

    await user.click(screen.getByTestId("report-section-add"));
    const firstHeading = screen.getByTestId(/report-section-heading-/);
    const firstBody = screen.getByTestId(/report-section-body-/);
    await user.type(firstHeading, "Stable heading");
    await user.type(firstBody, "Stable body");

    await user.click(screen.getByTestId("report-section-add"));
    expect(screen.getAllByTestId(/report-section-heading-/)[0]).toBe(firstHeading);
    expect(screen.getAllByTestId(/report-section-body-/)[0]).toBe(firstBody);
    expect(firstHeading).toHaveValue("Stable heading");
    expect(firstBody).toHaveValue("Stable body");

    const headings = screen.getAllByTestId(/report-section-heading-/);
    await user.type(headings[1], "Temporary heading");
    await user.click(screen.getAllByTestId(/report-section-remove-/)[1]);
    expect(screen.getByTestId(/report-section-heading-/)).toBe(firstHeading);
    expect(firstHeading).toHaveValue("Stable heading");
    expect(firstBody).toHaveValue("Stable body");
  });

  it("applies a compose-chat draft to the report body", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<MessageComposer agents={[agent]} initialMode="report" onSend={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId("compose-chat-panel")).toBeInTheDocument();
    await user.click(screen.getByTestId("compose-chat-use-draft"));
    expect(screen.getByTestId("message-composer-content")).toHaveValue("AI report draft");
  });

  it("reapplies report prefill only after a new nonce", async () => {
    const { rerender } = render(<MessageComposer agents={[agent]} initialMode="report" initialContent="First" initialReportTitle="First title" prefillNonce={1} onSend={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("message-composer-content")).toHaveValue("First");
    expect(screen.getByTestId("report-title")).toHaveValue("First title");
    rerender(<MessageComposer agents={[agent]} initialMode="report" initialContent="Second" initialReportTitle="Second title" prefillNonce={2} onSend={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("message-composer-content")).toHaveValue("Second");
    expect(screen.getByTestId("report-title")).toHaveValue("Second title");
  });
});
