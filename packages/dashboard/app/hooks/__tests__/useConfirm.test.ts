import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React, { useState } from "react";
import { ConfirmDialogProvider, useConfirm } from "../useConfirm";

function Harness() {
  const { confirm } = useConfirm();
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
});
