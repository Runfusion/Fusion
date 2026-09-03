import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { clampQuickChatFabOffset, QuickChatFAB } from "../QuickChatFAB";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

describe("QuickChatFAB launcher", () => {
  it("requests a whole-chat visibility toggle when clicked", () => {
    const onToggle = vi.fn();
    render(<QuickChatFAB showFAB open={false} onToggle={onToggle} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("toggles exactly once for a native pointer activation sequence", () => {
    const onToggle = vi.fn();
    render(<QuickChatFAB onToggle={onToggle} />);
    const launcher = screen.getByTestId("quick-chat-fab");

    fireEvent.pointerDown(launcher, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(launcher, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.click(launcher);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("requests both consecutive toggles instead of repeating an open request", () => {
    const onToggle = vi.fn();
    render(<QuickChatFAB onToggle={onToggle} />);

    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("suppresses the toggle after dragging beyond the movement threshold", () => {
    const onToggle = vi.fn();
    render(<QuickChatFAB onToggle={onToggle} />);
    const launcher = screen.getByTestId("quick-chat-fab");

    fireEvent.pointerDown(launcher, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(launcher, { pointerId: 1, clientX: 110, clientY: 100 });
    fireEvent.pointerUp(launcher, { pointerId: 1, clientX: 110, clientY: 100 });
    fireEvent.click(launcher);

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("announces and exposes all three toggle actions", () => {
    const { rerender } = render(
      <QuickChatFAB toggleAction="open-quick-chat" onToggle={vi.fn()} />,
    );
    const launcher = screen.getByTestId("quick-chat-fab");
    expect(launcher).toHaveAccessibleName("Open quick chat");
    expect(launcher).toHaveAttribute("data-chat-toggle-action", "open-quick-chat");

    rerender(<QuickChatFAB toggleAction="minimize-all" onToggle={vi.fn()} />);
    expect(launcher).toHaveAccessibleName("Minimize all chats");
    expect(launcher).toHaveAttribute("data-chat-toggle-action", "minimize-all");

    rerender(<QuickChatFAB toggleAction="restore-all" onToggle={vi.fn()} />);
    expect(launcher).toHaveAccessibleName("Restore all chats");
    expect(launcher).toHaveAttribute("data-chat-toggle-action", "restore-all");
  });

  it("stays visible as the launcher while the full chat modal is open", () => {
    render(<QuickChatFAB showFAB open onToggle={vi.fn()} />);

    expect(screen.getByTestId("quick-chat-fab")).toHaveAttribute("data-chat-open", "true");
  });

  it("does not render when disabled by settings", () => {
    render(<QuickChatFAB showFAB={false} open={false} onToggle={vi.fn()} />);

    expect(screen.queryByTestId("quick-chat-fab")).toBeNull();
  });

  it("allows dragged placement all the way to viewport edges", () => {
    expect(clampQuickChatFabOffset(-20, 320)).toBe(0);
    expect(clampQuickChatFabOffset(400, 320)).toBe(272);
  });
});
