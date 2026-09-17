import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { copyTextToClipboard } from "../../utils/copyToClipboard";

vi.mock("../../utils/copyToClipboard", () => ({ copyTextToClipboard: vi.fn(async () => true) }));
const mockCopy = vi.mocked(copyTextToClipboard);
import {
  ErrorBoundary,
  PageErrorBoundary,
  ModalErrorBoundary,
  RootErrorBoundary,
} from "../ErrorBoundary";

// Suppress console.error noise from React error boundary logging
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

// ---- Throwing child helper ----

function ThrowingChild({ shouldThrow }: { shouldThrow?: boolean }) {
  if (shouldThrow !== false) {
    throw new Error("Test render error");
  }
  return <div data-testid="child-ok">OK</div>;
}

// ---- Tests ----

describe("ErrorBoundary", () => {
  it("catches child render error and shows default fallback", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Test render error")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Reload page")).toBeInTheDocument();
  });

  it("calls onError callback", () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });

  it("renders custom fallback when provided", () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom">Custom</div>}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("custom")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
    // Default fallback should NOT appear
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("resetErrorBoundary recovers from error", () => {
    let shouldThrow = true;

    function ConditionalChild() {
      if (shouldThrow) {
        throw new Error("Test render error");
      }
      return <div data-testid="child-ok">OK</div>;
    }

    render(
      <ErrorBoundary>
        <ConditionalChild />
      </ErrorBoundary>,
    );

    // Error fallback should be visible
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.queryByTestId("child-ok")).not.toBeInTheDocument();

    // Fix the error source before retrying
    shouldThrow = false;

    // Click Retry button
    act(() => {
      fireEvent.click(screen.getByText("Retry"));
    });

    // Child should now render successfully
    expect(screen.getByTestId("child-ok")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it('level prop applies correct CSS class for "page"', () => {
    render(
      <ErrorBoundary level="page">
        <ThrowingChild />
      </ErrorBoundary>,
    );

    const container = screen.getByText("Something went wrong").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--page");
  });

  it('level prop applies correct CSS class for "modal"', () => {
    render(
      <ErrorBoundary level="modal">
        <ThrowingChild />
      </ErrorBoundary>,
    );

    const container = screen.getByText("This section encountered an error").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--modal");
  });

  it('level prop applies correct CSS class for "root"', () => {
    render(
      <ErrorBoundary level="root">
        <ThrowingChild />
      </ErrorBoundary>,
    );

    const container = screen.getByText("Something went wrong").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--root");
  });

  it("renders children normally when no error occurs", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("child-ok")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});

describe("PageErrorBoundary", () => {
  it("renders with page level", () => {
    render(
      <PageErrorBoundary>
        <ThrowingChild />
      </PageErrorBoundary>,
    );

    const container = screen.getByText("Something went wrong").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--page");
  });
});

describe("ModalErrorBoundary", () => {
  it("renders with modal level", () => {
    render(
      <ModalErrorBoundary>
        <ThrowingChild />
      </ModalErrorBoundary>,
    );

    const container = screen.getByText("This section encountered an error").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--modal");
  });
});

describe("RootErrorBoundary", () => {
  it("renders with root level", () => {
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );

    const container = screen.getByText("Something went wrong").closest(".error-boundary");
    expect(container).toHaveClass("error-boundary--root");
  });
});

/*
FNXC:ErrorBoundaryDiagnostics 2026-09-17-19:34:
FN-515: the operator hit the minified overlay on a phone with no console, so the fallback must expose
its own bounded diagnostic. These cases mount the REAL boundary with NO application provider — the
fallback has to work after everything else died — and cover every boundary level, a normal error, a
minified #185 error, copy success/refusal, a late copy answer, Retry, Reload, and the untouched custom
fallback priority.
*/
describe("ErrorBoundary diagnostics", () => {
  beforeEach(() => {
    mockCopy.mockReset();
    mockCopy.mockResolvedValue(true);
  });

  function ThrowSpecific({ error }: { error: unknown }): never {
    throw error as Error;
  }

  function reportText(): string {
    return screen.getByTestId("error-boundary-report").textContent ?? "";
  }

  it.each(["root", "page", "modal"] as const)("exposes collapsible details for the %s level", (level) => {
    render(
      <ErrorBoundary level={level}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(reportText()).toContain(`Boundary level: ${level}`);
    expect(reportText()).toContain("Test render error");
    expect(reportText()).toContain("Component stack:");
  });

  it("explains a minified React #185 error and links its documentation", () => {
    render(
      <RootErrorBoundary>
        <ThrowSpecific error={new Error("Minified React error #185; visit https://react.dev/errors/185 for the full message")} />
      </RootErrorBoundary>,
    );

    expect(screen.getByText(/React stopped a render loop/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://react.dev/errors/185" }))
      .toHaveAttribute("href", "https://react.dev/errors/185");
    expect(reportText()).toContain("#185");
  });

  it("does not explain an unrelated error as a render loop", () => {
    render(
      <RootErrorBoundary>
        <ThrowSpecific error={new Error("Cannot read properties of null")} />
      </RootErrorBoundary>,
    );

    expect(screen.queryByText(/React stopped a render loop/)).toBeNull();
  });

  it("survives a thrown value with no stack", () => {
    render(
      <RootErrorBoundary>
        <ThrowSpecific error={Object.assign(new Error("No stack here"), { stack: undefined })} />
      </RootErrorBoundary>,
    );

    expect(reportText()).toContain("JavaScript stack:\n(unavailable)");
  });

  it("copies exactly the displayed report and reports success", async () => {
    const user = userEvent.setup({ document });
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );
    const displayed = reportText();

    await user.click(screen.getByRole("button", { name: "Copy details" }));

    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(mockCopy.mock.calls[0][0]).toBe(displayed);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  it("keeps the report selectable and explains a refused copy", async () => {
    mockCopy.mockResolvedValue(false);
    const user = userEvent.setup({ document });
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );

    await user.click(screen.getByRole("button", { name: "Copy details" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Copy failed/ })).toBeInTheDocument());
    expect(reportText()).toContain("Test render error");
  });

  it("details and copy are reachable by keyboard", async () => {
    const user = userEvent.setup({ document });
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );
    const details = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;

    const summary = screen.getByText("Technical details") as HTMLElement;

    // A native <summary> is focusable and is the disclosure control itself.
    summary.focus();
    expect(document.activeElement).toBe(summary);
    expect(summary.tagName).toBe("SUMMARY");

    // jsdom does not synthesize summary activation from a key press, so activate it and then prove
    // the copy action is a real keyboard-reachable button rather than a pointer-only affordance.
    await user.click(summary);
    expect(details.open).toBe(true);

    const copy = screen.getByRole("button", { name: "Copy details" });
    copy.focus();
    expect(document.activeElement).toBe(copy);
    await user.keyboard("{Enter}");
    expect(mockCopy).toHaveBeenCalledTimes(1);
  });

  it("a copy answer arriving after Retry does not restore a stale diagnostic", async () => {
    let resolveCopy: ((value: boolean) => void) | null = null;
    mockCopy.mockImplementation(() => new Promise<boolean>((resolve) => { resolveCopy = resolve; }));
    let shouldThrow = true;
    function Conditional() {
      if (shouldThrow) throw new Error("First failure");
      return <div data-testid="child-ok">OK</div>;
    }
    render(
      <RootErrorBoundary>
        <Conditional />
      </RootErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    shouldThrow = false;
    act(() => { fireEvent.click(screen.getByText("Retry")); });
    expect(screen.getByTestId("child-ok")).toBeInTheDocument();

    await act(async () => { resolveCopy?.(true); });

    // The recovered subtree stays recovered; no diagnostic returns.
    expect(screen.getByTestId("child-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary-report")).toBeNull();
  });

  it("Retry clears the diagnostic and a fresh error produces a fresh one", () => {
    let message = "First failure";
    let shouldThrow = true;
    function Conditional() {
      if (shouldThrow) throw new Error(message);
      return <div data-testid="child-ok">OK</div>;
    }
    const view = render(
      <RootErrorBoundary>
        <Conditional />
      </RootErrorBoundary>,
    );
    expect(reportText()).toContain("First failure");

    shouldThrow = false;
    act(() => { fireEvent.click(screen.getByText("Retry")); });
    expect(screen.queryByTestId("error-boundary-report")).toBeNull();

    message = "Second failure";
    shouldThrow = true;
    view.unmount();
    render(
      <RootErrorBoundary>
        <Conditional />
      </RootErrorBoundary>,
    );

    expect(reportText()).toContain("Second failure");
    expect(reportText()).not.toContain("First failure");
  });

  it("Reload page still reloads", () => {
    const reload = vi.fn();
    const previous = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...previous, reload } });
    try {
      render(
        <RootErrorBoundary>
          <ThrowingChild />
        </RootErrorBoundary>,
      );
      fireEvent.click(screen.getByText("Reload page"));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: previous });
    }
  });

  it("a custom fallback keeps priority and receives no diagnostic controls", () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom">Custom</div>}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("custom")).toBeInTheDocument();
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy details" })).toBeNull();
    expect(screen.queryByTestId("error-boundary-report")).toBeNull();
  });

  it("does not leak synthetic secret markers into the report or the copied text", async () => {
    const user = userEvent.setup({ document });
    render(
      <RootErrorBoundary>
        <ThrowSpecific error={new Error("POST https://user:FN515_SECRET_PW@api.test/tasks?token=FN515_SECRET_QS failed with Bearer FN515_SECRET_BEARER")} />
      </RootErrorBoundary>,
    );

    await user.click(screen.getByRole("button", { name: "Copy details" }));
    const copied = mockCopy.mock.calls[0][0];

    for (const marker of ["FN515_SECRET_PW", "FN515_SECRET_QS", "FN515_SECRET_BEARER"]) {
      expect(reportText()).not.toContain(marker);
      expect(copied).not.toContain(marker);
    }
    expect(reportText()).toContain("api.test/tasks");
  });

  it("the fallback itself does not loop: one caught error renders one diagnostic", () => {
    render(
      <RootErrorBoundary>
        <ThrowingChild />
      </RootErrorBoundary>,
    );

    expect(screen.getAllByTestId("error-boundary-report")).toHaveLength(1);
    const logged = consoleSpy.mock.calls
      .map((call) => call.map((part) => (part instanceof Error ? part.message : String(part))).join(" "))
      .join("\n");
    expect(logged).not.toMatch(/Maximum update depth exceeded/i);
  });
});
