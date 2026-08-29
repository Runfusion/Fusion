import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "../AgentAvatar";

describe("AgentAvatar", () => {
  it("renders image when imageUrl is set", () => {
    render(<AgentAvatar agent={{ id: "a1", name: "Agent One", imageUrl: "/api/agents/a1/avatar" }} />);
    expect(screen.getByRole("img", { name: "Agent One avatar" })).toBeTruthy();
  });

  it("renders emoji when icon is set and no imageUrl", () => {
    render(<AgentAvatar agent={{ id: "a1", name: "Agent One", icon: "🤖" }} />);
    expect(screen.getByText("🤖")).toBeTruthy();
  });

  it("renders bot fallback when neither imageUrl nor icon is set", () => {
    const { container } = render(<AgentAvatar agent={{ id: "a1", name: "Agent One" }} />);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("falls back to emoji when image fails", () => {
    render(<AgentAvatar agent={{ id: "a1", name: "Agent One", imageUrl: "/avatar", icon: "⚙️" }} />);
    const img = screen.getByRole("img", { name: "Agent One avatar" });
    fireEvent.error(img);
    expect(screen.getByText("⚙️")).toBeTruthy();
  });

  it("applies width and height from size prop", () => {
    const { container } = render(<AgentAvatar agent={{ id: "a1", name: "Agent One" }} size={52} />);
    const avatar = container.querySelector(".agent-avatar") as HTMLElement;
    expect(avatar.style.width).toBe("52px");
    expect(avatar.style.height).toBe("52px");
  });

  it("includes cache-bust query param when updatedAt exists", () => {
    render(<AgentAvatar agent={{ id: "a1", name: "Agent One", imageUrl: "/avatar", updatedAt: "2026-05-05T00:00:00.000Z" }} />);
    const img = screen.getByRole("img", { name: "Agent One avatar" }) as HTMLImageElement;
    expect(img.src).toContain("/avatar?t=2026-05-05T00%3A00%3A00.000Z");
  });
});
