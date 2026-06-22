import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { clampQuickChatFabOffset, QuickChatFAB } from "../QuickChatFAB";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

describe("QuickChatFAB launcher", () => {
  it("opens the full chat modal when clicked", () => {
    const onOpenChange = vi.fn();
    render(<QuickChatFAB showFAB open={false} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("stays visible as the minimized launcher while the full chat modal is open", () => {
    render(<QuickChatFAB showFAB open onOpenChange={vi.fn()} />);

    expect(screen.getByTestId("quick-chat-fab")).toBeInTheDocument();
  });

  it("does not render when disabled by settings", () => {
    render(<QuickChatFAB showFAB={false} open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByTestId("quick-chat-fab")).toBeNull();
  });

  it("allows dragged placement all the way to viewport edges", () => {
    expect(clampQuickChatFabOffset(-20, 320)).toBe(0);
    expect(clampQuickChatFabOffset(400, 320)).toBe(272);
  });
});
