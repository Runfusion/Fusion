import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const workspaceApi = vi.hoisted(() => ({ fetch: vi.fn(), add: vi.fn() }));
vi.mock("../../../../api/agents/agents", () => ({
  fetchWorkspaceRepos: workspaceApi.fetch,
  addWorkspaceRepo: workspaceApi.add,
}));
import { WorkspaceReposCard } from "../WorkspaceReposCard";

beforeEach(() => {
  workspaceApi.fetch.mockReset();
  workspaceApi.add.mockReset();
});

describe("WorkspaceReposCard", () => {
  it("lists candidates and adds a selected repository without remounting the input", async () => {
    workspaceApi.fetch.mockResolvedValue({ repos: ["api"], available: ["web"] });
    workspaceApi.add.mockResolvedValue({ repos: ["api", "web"], outcome: "added" });
    const user = userEvent.setup();
    render(<WorkspaceReposCard projectId="project-1" />);

    await screen.findByText("api");
    const input = screen.getByPlaceholderText("Repository directory");
    await user.type(input, "web");
    expect(input).toHaveFocus();
    await user.click(screen.getByTestId("workspace-repo-add-button"));

    await screen.findByText("web");
    expect(workspaceApi.add).toHaveBeenCalledWith("web", "project-1");
  });

  it("keeps the card absent outside a workspace and displays add validation errors", async () => {
    workspaceApi.fetch.mockRejectedValueOnce(new Error("not a workspace"));
    const { rerender } = render(<WorkspaceReposCard projectId="single" />);
    await waitFor(() => expect(screen.queryByTestId("workspace-repos-card")).not.toBeInTheDocument());

    workspaceApi.fetch.mockResolvedValue({ repos: ["api"], available: [] });
    workspaceApi.add.mockRejectedValue(new Error("not a git work tree"));
    rerender(<WorkspaceReposCard projectId="workspace" />);
    await screen.findByText("api");
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Repository directory"), "plain");
    await user.click(screen.getByTestId("workspace-repo-add-button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a git work tree");
    expect(screen.queryByText("plain")).not.toBeInTheDocument();
  });
});
