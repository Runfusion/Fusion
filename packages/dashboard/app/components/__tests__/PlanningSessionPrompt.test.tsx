// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { PlanningSessionPrompt } from "../PlanningSessionPrompt";

afterEach(cleanup);

describe("PlanningSessionPrompt", () => {
  it("renders the initiating prompt in a read-only textarea", () => {
    render(<PlanningSessionPrompt prompt="Ship the new billing page" testId="x" />);

    const textarea = screen.getByTestId("x");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveValue("Ship the new billing page");
    expect(textarea).toHaveProperty("readOnly", true);
  });

  it.each([
    ["an empty prompt", ""],
    ["a whitespace-only prompt", "   \n\t "],
    ["an undefined prompt", undefined],
  ])("renders no shell for %s", (_label, prompt) => {
    const { container } = render(<PlanningSessionPrompt prompt={prompt} testId="x" />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("x")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("cannot be changed through user input", async () => {
    const user = userEvent.setup();
    render(<PlanningSessionPrompt prompt="Keep this exact prompt" testId="x" />);

    const textarea = screen.getByTestId("x");
    await user.type(textarea, "mutation");

    expect(textarea).toHaveValue("Keep this exact prompt");
  });

  it("preserves a multi-line prompt verbatim", () => {
    const prompt = "line one\nline two\nline three";
    render(<PlanningSessionPrompt prompt={prompt} testId="x" />);

    expect(screen.getByTestId("x")).toHaveValue(prompt);
  });
});
