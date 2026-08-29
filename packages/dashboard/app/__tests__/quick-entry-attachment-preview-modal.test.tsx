import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingAttachmentPreviews } from "../components/PendingAttachmentPreviews";

const image = {
  file: new File(["image"], "preview.png", { type: "image/png" }),
  previewUrl: "blob:preview",
};

describe("pending task attachment previews", () => {
  it.each([
    "quick-entry-preview",
    "task-form-preview",
    "inline-create-preview",
  ])("opens and dismisses the shared %s preview affordance", async (testIdPrefix) => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <PendingAttachmentPreviews
        attachments={[image]}
        onRemove={onRemove}
        removeLabel="Remove image"
        testIdPrefix={testIdPrefix}
      />,
    );

    const openButton = screen.getByTestId(`${testIdPrefix}-open-0`);
    expect(openButton).toHaveAccessibleName("Open image preview.png");
    await user.click(openButton);

    const window = screen.getByTestId("floating-window-pending-image-preview");
    expect(window).toHaveClass("floating-window--image-preview");
    expect(screen.getByRole("img", { name: "preview.png" })).toHaveAttribute("src", "blob:preview");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("floating-window-pending-image-preview")).toBeNull());
    expect(openButton).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByTestId("floating-window-pending-image-preview")).toBeTruthy();
    fireEvent.click(screen.getByTestId(`${testIdPrefix}-remove-0`));
    expect(onRemove).toHaveBeenCalledWith(0);
    expect(screen.queryByTestId("floating-window-pending-image-preview")).toBeNull();
  });

  it("renders a non-image filename with removal but no image-open button", () => {
    const onRemove = vi.fn();
    render(
      <PendingAttachmentPreviews
        attachments={[{ file: new File(["note"], "notes.txt", { type: "text/plain" }) }]}
        onRemove={onRemove}
        removeLabel="Remove attachment"
        testIdPrefix="quick-entry-preview"
      />,
    );

    expect(screen.getByTestId("quick-entry-preview-file-0")).toHaveTextContent("notes.txt");
    expect(screen.queryByTestId("quick-entry-preview-open-0")).toBeNull();
    expect(screen.getByTestId("quick-entry-preview-remove-0")).toHaveAccessibleName("Remove attachment: notes.txt");
    fireEvent.click(screen.getByTestId("quick-entry-preview-remove-0"));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("renders mixed attachments without empty preview controls and disables removals when requested", () => {
    render(
      <PendingAttachmentPreviews
        attachments={[image, { file: new File(["{}"], "data.json", { type: "application/json" }) }]}
        onRemove={vi.fn()}
        disabled
        removeLabel="Remove attachment"
        testIdPrefix="quick-entry-preview"
      />,
    );

    expect(screen.getByTestId("quick-entry-preview-open-0")).toBeInTheDocument();
    expect(screen.getByTestId("quick-entry-preview-file-1")).toHaveTextContent("data.json");
    expect(screen.queryByTestId("quick-entry-preview-open-1")).toBeNull();
    expect(screen.getByTestId("quick-entry-preview-remove-0")).toBeDisabled();
    expect(screen.getByTestId("quick-entry-preview-remove-1")).toBeDisabled();
  });

  it("renders no preview shells without pending attachments", () => {
    const { container } = render(
      <PendingAttachmentPreviews
        attachments={[]}
        onRemove={vi.fn()}
        removeLabel="Remove image"
        testIdPrefix="quick-entry-preview"
      />,
    );

    expect(container.querySelector(".inline-create-previews")).toBeNull();
    expect(screen.queryByTestId("quick-entry-preview-open-0")).toBeNull();
  });
});
