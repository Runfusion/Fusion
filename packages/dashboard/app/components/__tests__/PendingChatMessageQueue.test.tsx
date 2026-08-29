import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingChatMessageQueue } from "../PendingChatMessageQueue";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback: string, options?: { preview?: string }) =>
      fallback.replace("{{preview}}", options?.preview ?? ""),
  }),
}));

describe("PendingChatMessageQueue", () => {
  const callbacks = () => ({
    onEdit: vi.fn(),
    onMove: vi.fn(),
    onDelete: vi.fn(),
    onForceSend: vi.fn(),
  });

  it("renders no queue shell for empty or undefined messages", () => {
    const props = callbacks();
    const { rerender } = render(<PendingChatMessageQueue {...props} />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(document.body.querySelector("button")).not.toBeInTheDocument();

    rerender(<PendingChatMessageQueue {...props} messages={[]} />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("manages duplicate entries by index and rejects blank edits without destruction", async () => {
    const user = userEvent.setup();
    const props = callbacks();
    render(<PendingChatMessageQueue {...props} messages={["Duplicate", "Duplicate", "Last"]} testIdPrefix="queue" />);

    await user.click(screen.getByTestId("queue-edit-1"));
    const input = screen.getByRole("textbox", { name: "Edit queued message 2" });
    await user.clear(input);
    await user.click(screen.getByTestId("queue-save-1"));
    expect(screen.getByText("Queued messages cannot be empty")).toBeInTheDocument();
    expect(props.onEdit).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("queue-cancel-1"));
    expect(screen.getByTestId("queue-message-1")).toHaveTextContent("Duplicate");
    await user.click(screen.getByTestId("queue-edit-1"));
    const reopenedInput = screen.getByRole("textbox", { name: "Edit queued message 2" });
    await user.clear(reopenedInput);
    await user.type(reopenedInput, "Edited duplicate");
    await user.click(screen.getByTestId("queue-save-1"));
    expect(props.onEdit).toHaveBeenCalledWith(1, "Edited duplicate");

    await user.click(screen.getByTestId("queue-up-2"));
    await user.click(screen.getByTestId("queue-down-0"));
    expect(props.onMove).toHaveBeenNthCalledWith(1, 2, -1);
    expect(props.onMove).toHaveBeenNthCalledWith(2, 0, 1);
    expect(screen.getByTestId("queue-up-0")).toBeDisabled();
    expect(screen.getByTestId("queue-down-2")).toBeDisabled();

    await user.click(screen.getByTestId("queue-delete-1"));
    expect(props.onDelete).toHaveBeenCalledWith(1);
    await user.click(screen.getByTestId("queue-force-1"));
    expect(props.onForceSend).toHaveBeenCalledWith(1);
  });

  it("disables every mutation while the caller owns a queue action", async () => {
    const user = userEvent.setup();
    const props = callbacks();
    render(<PendingChatMessageQueue {...props} messages={["One", "Two"]} disabled testIdPrefix="queue" />);

    for (const id of ["edit-0", "up-1", "down-0", "delete-0", "force-0"]) {
      expect(screen.getByTestId(`queue-${id}`)).toBeDisabled();
    }
    await user.click(screen.getByTestId("queue-force-0"));
    expect(props.onForceSend).not.toHaveBeenCalled();
  });
});
