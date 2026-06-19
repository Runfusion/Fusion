import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TodoModal } from "../TodoModal";

const mockTodoView = vi.fn();
const mockUseMobileKeyboard = vi.fn();
const mockUseViewportMode = vi.fn();

vi.mock("../TodoView", () => ({
  TodoView: (props: unknown) => {
    mockTodoView(props);
    return <div data-testid="todo-view-content">Todo content</div>;
  },
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: unknown[]) => mockUseMobileKeyboard(...args),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  getViewportMode: () => mockUseViewportMode(),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
  useViewportMode: (...args: unknown[]) => mockUseViewportMode(...args),
}));

describe("TodoModal", () => {
  const onClose = vi.fn();
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseViewportMode.mockReturnValue("desktop");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
      keyboardOpen: false,
    });
  });

  it("renders modal dialog semantics and header content", () => {
    render(<TodoModal onClose={onClose} addToast={addToast} />);

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: "Todos" })).toBeInTheDocument();
    expect(screen.getByText("Manage reusable todo lists for your project.")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<TodoModal onClose={onClose} addToast={addToast} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on overlay backdrop click", () => {
    render(<TodoModal onClose={onClose} addToast={addToast} />);
    const overlay = screen.getByRole("dialog");
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from close button", () => {
    render(<TodoModal onClose={onClose} addToast={addToast} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("passes expected props through the lazy-loaded TodoView", async () => {
    const onPlanningMode = vi.fn();
    render(
      <TodoModal
        onClose={onClose}
        addToast={addToast}
        projectId="proj-1"
        onPlanningMode={onPlanningMode}
      />,
    );

    expect(await screen.findByTestId("todo-view-content")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockTodoView).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          addToast,
          onPlanningMode,
          onClose,
          mobileKeyboardActive: false,
        }),
      );
    });
  });

  describe("mobile keyboard behavior", () => {
    it("applies CSS variables when keyboard is open on mobile", () => {
      mockUseViewportMode.mockReturnValue("mobile");
      mockUseMobileKeyboard.mockReturnValue({
        keyboardOverlap: 250,
        viewportHeight: 450,
        viewportOffsetTop: 40,
        keyboardOpen: true,
      });

      render(<TodoModal onClose={onClose} addToast={addToast} />);
      const modal = screen.getByRole("dialog").querySelector(".modal.todo-modal");
      expect(modal).toBeTruthy();

      const style = (modal as HTMLElement).style;
      expect(style.getPropertyValue("--keyboard-overlap")).toBe("250px");
      expect(style.getPropertyValue("--vv-offset-top")).toBe("40px");
      expect(style.getPropertyValue("--vv-height")).toBe("450px");
      expect(mockTodoView).toHaveBeenCalledWith(expect.objectContaining({ mobileKeyboardActive: true }));
    });

    it("does not apply keyboard CSS variables when keyboard is closed", () => {
      mockUseViewportMode.mockReturnValue("mobile");
      mockUseMobileKeyboard.mockReturnValue({
        keyboardOverlap: 0,
        viewportHeight: null,
        viewportOffsetTop: 0,
        keyboardOpen: false,
      });

      render(<TodoModal onClose={onClose} addToast={addToast} />);
      const modal = screen.getByRole("dialog").querySelector(".modal.todo-modal");
      expect(modal).toBeTruthy();

      const style = (modal as HTMLElement).style;
      expect(style.getPropertyValue("--keyboard-overlap")).toBe("");
      expect(style.getPropertyValue("--vv-offset-top")).toBe("");
      expect(style.getPropertyValue("--vv-height")).toBe("");
      expect(mockTodoView).toHaveBeenCalledWith(expect.objectContaining({ mobileKeyboardActive: false }));
    });
  });
});
