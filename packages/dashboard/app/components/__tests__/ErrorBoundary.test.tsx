import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { act } from "react";
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
