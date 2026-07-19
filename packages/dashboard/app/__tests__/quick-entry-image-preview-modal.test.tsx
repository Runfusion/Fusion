import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingImagePreviews } from "../components/PendingImagePreviews";

const image = {
  file: new File(["image"], "preview.png", { type: "image/png" }),
  previewUrl: "blob:preview",
};

describe("pending task image previews", () => {
  it.each([
    "quick-entry-preview",
    "task-form-preview",
    "inline-create-preview",
  ])("opens and dismisses the shared %s preview affordance", async (testIdPrefix) => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <PendingImagePreviews
        images={[image]}
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

  it("renders no preview shells without pending images", () => {
    const { container } = render(
      <PendingImagePreviews
        images={[]}
        onRemove={vi.fn()}
        removeLabel="Remove image"
        testIdPrefix="quick-entry-preview"
      />,
    );

    expect(container.querySelector(".inline-create-previews")).toBeNull();
    expect(screen.queryByTestId("quick-entry-preview-open-0")).toBeNull();
  });
});
