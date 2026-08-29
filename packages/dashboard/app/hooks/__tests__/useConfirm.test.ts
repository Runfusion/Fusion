import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React, { useState } from "react";
import { ConfirmDialogProvider, useConfirm } from "../useConfirm";

function Harness() {
  const { confirm, confirmWithChoice, confirmWithCheckbox } = useConfirm();
  const [result, setResult] = useState<string>("idle");

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "button",
      {
        onClick: async () => {
          const ok = await confirm({ title: "Delete Task", message: "Delete FN-001?", danger: true });
          setResult(ok ? "confirmed" : "canceled");
        },
      },
      "open"
    ),
    React.createElement(
      "button",
      {
        onClick: () => {
          void confirm({ title: "First", message: "first" });
          void confirm({ title: "Second", message: "second" });
        },
      },
      "queue"
    ),
    React.createElement(
      "button",
      {
        onClick: async () => {
          const outcome = await confirmWithCheckbox({
            title: "Delete Task",
            message: "Delete FN-001?",
            checkbox: { label: "Allow re-creation later", defaultChecked: false },
          });
          setResult(JSON.stringify(outcome));
        },
      },
      "open-checkbox"
    ),
    React.createElement(
      "button",
      {
        onClick: async () => {
          const outcome = await confirmWithCheckbox({
            title: "Delete Task",
            message: "Delete FN-001?",
            checkbox: { label: "Allow re-creation later", defaultChecked: true },
          });
          setResult(JSON.stringify(outcome));
        },
      },
      "open-checkbox-default-checked"
    ),
    React.createElement(
      "button",
      {
        onClick: async () => {
          const outcome = await confirmWithCheckbox({ title: "Reset Task", message: "Reset FN-001?" });
          setResult(JSON.stringify(outcome));
        },
      },
      "open-checkbox-without-checkbox"
    ),
    React.createElement(
      "button",
      {
        onClick: async () => {
          const choice = await confirmWithChoice({
            title: "Delete Done",
            message: "Delete or archive?",
            confirmLabel: "Delete",
            tertiaryLabel: "Archive Instead",
          });
          setResult(choice);
        },
      },
      "open-choice"
    ),
    React.createElement("div", { "data-testid": "result" }, result)
  );
}

describe("useConfirm", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips dialogs with the primary/default outcomes when enabled", async () => {
    render(React.createElement(ConfirmDialogProvider, { skipConfirmations: true }, React.createElement(Harness)));

    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("confirmed"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("open-choice"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("primary"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("open-checkbox-default-checked"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent('{"choice":"primary","checkboxValue":true}'));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("open-checkbox-without-checkbox"));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent('{"choice":"primary","checkboxValue":false}'));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("resolves true when confirm is clicked", async () => {
    render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(Harness)
      )
    );

    fireEvent.click(screen.getByText("open"));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe("confirmed");
    });
  });

  it("keeps a mouse-opened confirm visible when its trailing click reaches the backdrop", async () => {
    render(React.createElement(ConfirmDialogProvider, null, React.createElement(Harness)));

    const trigger = screen.getByText("open");
    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    fireEvent.click(trigger);

    const overlay = await screen.findByText("Delete FN-001?").then(() => document.querySelector(".confirm-dialog-overlay"));
    expect(overlay).toBeTruthy();
    fireEvent.mouseDown(overlay as Element);
    fireEvent.pointerUp(overlay as Element, { pointerType: "mouse" });
    fireEvent.click(overlay as Element);

    expect(screen.getByRole("dialog", { name: "Delete Task" })).toBeInTheDocument();
    expect(screen.getByTestId("result")).toHaveTextContent("idle");

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("confirmed"));
  });

  it("keeps a touch-opened confirm visible when its trailing tap reaches the backdrop", async () => {
    render(React.createElement(ConfirmDialogProvider, null, React.createElement(Harness)));

    const trigger = screen.getByText("open");
    fireEvent.touchStart(trigger);
    fireEvent.click(trigger);

    const overlay = await screen.findByText("Delete FN-001?").then(() => document.querySelector(".confirm-dialog-overlay"));
    expect(overlay).toBeTruthy();
    fireEvent.touchEnd(overlay as Element);
    fireEvent.click(overlay as Element);

    expect(screen.getByRole("dialog", { name: "Delete Task" })).toBeInTheDocument();
    expect(screen.getByTestId("result")).toHaveTextContent("idle");

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("confirmed"));
  });

  it("keeps a mobile touch-opened confirm visible through its delayed ghost mouse burst and only deletes after Confirm", async () => {
    vi.useFakeTimers();
    render(React.createElement(ConfirmDialogProvider, null, React.createElement(Harness)));

    const trigger = screen.getByText("open");
    fireEvent.touchStart(trigger);
    fireEvent.touchEnd(trigger);
    // JSDOM does not synthesize this click from touch events, unlike the browser.
    fireEvent.click(trigger);

    expect(screen.getByText("Delete FN-001?")).toBeInTheDocument();
    const overlay = document.querySelector(".confirm-dialog-overlay");
    expect(overlay).toBeTruthy();
    fireEvent.mouseDown(overlay as Element);
    fireEvent.mouseUp(overlay as Element);
    fireEvent.click(overlay as Element);

    expect(screen.getByRole("dialog", { name: "Delete Task" })).toBeInTheDocument();
    expect(screen.getByTestId("result")).toHaveTextContent("idle");

    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("confirmed"));
  });

  it("resolves false when cancel is clicked", async () => {
    render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(Harness)
      )
    );

    fireEvent.click(screen.getByText("open"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe("canceled");
    });
  });

  it("resolves tertiary choice when tertiary button clicked", async () => {
    render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(Harness)
      )
    );

    fireEvent.click(screen.getByText("open-choice"));
    fireEvent.click(await screen.findByRole("button", { name: "Archive Instead" }));

    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe("tertiary");
    });
  });

  it("resolves cancel choice when cancel is clicked", async () => {
    render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(Harness)
      )
    );

    fireEvent.click(screen.getByText("open-choice"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe("cancel");
    });
  });

  it("resolves primary choice when confirm is clicked", async () => {
    render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(Harness)
      )
    );

    fireEvent.click(screen.getByText("open-choice"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe("primary");
    });
  });

  it("queues confirmations sequentially", async () => {
    render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(Harness)
      )
    );

    fireEvent.click(screen.getByText("queue"));

    expect(await screen.findByRole("dialog", { name: "First" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("dialog", { name: "Second" })).toBeInTheDocument();
  });

  it("confirmWithCheckbox returns primary with toggled checkbox value", async () => {
    render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(Harness)
      )
    );

    fireEvent.click(screen.getByText("open-checkbox"));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe('{"choice":"primary","checkboxValue":true}');
    });
  });

  it("confirmWithCheckbox returns cancel with unchecked value on cancel", async () => {
    render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(Harness)
      )
    );

    fireEvent.click(screen.getByText("open-checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe('{"choice":"cancel","checkboxValue":false}');
    });
  });

  it("confirmWithCheckbox keeps defaultChecked value when untouched", async () => {
    render(
      React.createElement(
        ConfirmDialogProvider,
        null,
        React.createElement(Harness)
      )
    );

    fireEvent.click(screen.getByText("open-checkbox-default-checked"));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(screen.getByTestId("result").textContent).toBe('{"choice":"primary","checkboxValue":true}');
    });
  });
});
