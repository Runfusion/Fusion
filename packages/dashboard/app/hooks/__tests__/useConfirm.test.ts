import { describe, it, expect } from "vitest";
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
