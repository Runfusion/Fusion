import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MessageComposer } from "../MessageComposer";

vi.mock("../../api", () => ({
  sendMessage: vi.fn(),
}));

const defaultProps = {
  onSend: vi.fn(),
  onCancel: vi.fn(),
  addToast: vi.fn(),
};

describe("MessageComposer autosize", () => {
  it("grows and caps height as content wraps, then resets for short content", async () => {
    render(<MessageComposer {...defaultProps} />);

    const textarea = screen.getByTestId("message-composer-content") as HTMLTextAreaElement;
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        const value = (this as HTMLTextAreaElement).value;
        if (!value || value.length <= 4) return 24;
        if (value.includes("\n\n")) return 900;
        return 180;
      },
    });

    await userEvent.type(textarea, "line one\nline two");
    await waitFor(() => {
      expect(Number.parseInt(textarea.style.height, 10)).toBeGreaterThanOrEqual(68);
      expect(Number.parseInt(textarea.style.height, 10)).toBeLessThanOrEqual(320);
    });

    await userEvent.type(textarea, "\n\nline three");
    await waitFor(() => {
      expect(textarea.style.height).toBe("320px");
    });

    await userEvent.clear(textarea);
    await userEvent.type(textarea, "ok");
    await waitFor(() => {
      expect(textarea.style.height).toBe("68px");
    });
  });
});
