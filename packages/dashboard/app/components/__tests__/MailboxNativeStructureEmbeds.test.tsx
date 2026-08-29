import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, NativeStructureEmbed } from "@fusion/core";
import { fetchNativeStructurePreview } from "../../api";
import { MailboxNativeStructureEmbeds } from "../MailboxNativeStructureEmbeds";

vi.mock("../../api", () => ({ fetchNativeStructurePreview: vi.fn() }));
const fetchPreview = vi.mocked(fetchNativeStructurePreview);

function message(nativeStructures?: NativeStructureEmbed[]): Pick<Message, "metadata"> {
  return { metadata: nativeStructures ? { nativeStructures } : undefined };
}

describe("MailboxNativeStructureEmbeds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not create an attachment shell without embeds", () => {
    const { container } = render(<MailboxNativeStructureEmbeds message={message()} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders every persisted embed and forwards preview navigation", async () => {
    const onOpen = vi.fn();
    fetchPreview.mockResolvedValue({ available: true, kind: "mission", kindLabel: "Mission", title: "Launch mail", excerpt: "Review", openTarget: { view: "missions", id: "M-1" } });
    render(<MailboxNativeStructureEmbeds message={message([
      { kind: "mission", id: "M-1", label: "Launch mail" },
      { kind: "goal", id: "G-1", label: "Ship" },
    ])} onOpen={onOpen} />);

    await waitFor(() => expect(screen.getAllByTestId("native-structure-preview")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: /Open Mission/ })[0]);
    expect(onOpen).toHaveBeenCalledWith({ kind: "mission", id: "M-1", projectId: undefined }, expect.objectContaining({ available: true }));
  });

  it("uses the captured label for unavailable targets", async () => {
    fetchPreview.mockResolvedValue({ available: false, kind: "mission", id: "M-1", reason: "soft-deleted" });
    render(<MailboxNativeStructureEmbeds message={message([{ kind: "mission", id: "M-1", label: "Launch mail" }])} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("native-structure-preview-unavailable")).toHaveTextContent("Launch mail"));
  });
});
