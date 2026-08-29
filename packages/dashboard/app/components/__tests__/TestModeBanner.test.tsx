import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TestModeBanner } from "../TestModeBanner";

describe("TestModeBanner", () => {
  it("renders nothing when inactive", () => {
    const { container } = render(<TestModeBanner isActive={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders status copy when active", () => {
    render(<TestModeBanner isActive />);
    expect(screen.getByRole("status")).toHaveTextContent("Test mode — no real AI calls");
  });
});
