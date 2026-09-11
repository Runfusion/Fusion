import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { History } from "lucide-react";
import { ViewHeader } from "../ViewHeader";

describe("ViewHeader", () => {
  it("rend une seule action Close accessible pour une vue flottante", () => {
    const onClose = vi.fn();
    render(<ViewHeader icon={History} title="History" titleId="history-title" onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "History" })).toHaveAttribute("id", "history-title");
    fireEvent.click(screen.getByRole("button", { name: "Close History" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
