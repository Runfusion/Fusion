// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CliPrintingPressWizardView } from "../dashboard-view";

vi.mock("lucide-react", () => ({ Wand2: () => null }));

describe("CliPrintingPressWizardView", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "draft-1" }) })));
  });

  it("walks steps, gates validation, and posts draft", async () => {
    const user = userEvent.setup();
    render(<CliPrintingPressWizardView />);

    const next = screen.getByRole("button", { name: "Next" });
    expect((next as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Name"), "GitHub");
    await user.type(screen.getByLabelText("Slug"), "github");
    await user.type(screen.getByLabelText("Base URL"), "https://api.github.com");
    expect((next as HTMLButtonElement).disabled).toBe(false);

    await user.click(next);
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.type(screen.getByPlaceholderText("Name"), "List Repos");
    await user.type(screen.getByPlaceholderText("/path"), "/user/repos");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = (fetch as any).mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({ name: "GitHub", slug: "github", baseUrl: "https://api.github.com", transport: "http" });
    expect(await screen.findByText(/Saved — draft id draft-1/)).toBeTruthy();
  });
});
