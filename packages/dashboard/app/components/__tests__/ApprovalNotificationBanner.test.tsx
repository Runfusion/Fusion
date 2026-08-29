import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApprovalNotificationBanner } from "../ApprovalNotificationBanner";

describe("ApprovalNotificationBanner", () => {
  it("renders count and handles actions", () => {
    const onOpenMailbox = vi.fn();
    const onDismiss = vi.fn();

    render(
      <ApprovalNotificationBanner
        pendingCount={2}
        onOpenMailbox={onOpenMailbox}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("2 approval requests need your attention")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Open Mailbox"));
    expect(onOpenMailbox).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Dismiss approval notification banner"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
